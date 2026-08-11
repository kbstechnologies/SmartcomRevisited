import { z } from 'zod'

/**
 * Optional text that also accepts null.
 *
 * SQLite returns NULL for empty nullable columns, which arrives as `null`.
 * Plain `optionalText` rejects that, so loading a row and saving it
 * straight back failed IPC validation ("expected string, received null").
 */
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? undefined)


/** A folder in the connection list. */
export const ConnectionGroupSchema = z.object({
  id: optionalText,
  name: z.string().min(1),
  description: optionalText,
  color: optionalText,
  /** Manual ordering in the connection list; lower sorts first. */
  sortOrder: z.number().default(0),
  createdAt: optionalText,
  updatedAt: optionalText,
})

export type ConnectionGroup = z.infer<typeof ConnectionGroupSchema>

export const TRANSPORTS = ['ssh', 'serial'] as const
export type Transport = (typeof TRANSPORTS)[number]

export const SERIAL_PARITIES = ['none', 'even', 'odd', 'mark', 'space'] as const
export const SERIAL_FLOW_CONTROL = ['none', 'rtscts', 'xonxoff'] as const
export const COMMON_BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const

export const ProfileSchema = z
  .object({
    id: optionalText,
    name: z.string().min(1),
    /** Which kind of connection this is. Serial keeps the SmartCOM heritage. */
    transport: z.enum(TRANSPORTS).default('ssh'),
    /** Folder this connection belongs to; ungrouped when absent. */
    groupId: optionalText,

    // --- SSH ---
    host: z.string().default(''),
    port: z.number().min(1).max(65535).default(22),
    username: z.string().default(''),
    authMethod: z.enum(['password', 'key', 'agent']).default('password'),
    /** Path to a private key on disk (external key). */
    keyPath: optionalText,
    /** Id of a key managed by Smartcom Revisited; takes precedence over `keyPath`. */
    keyId: optionalText,

    // --- Serial ---
    /** Device path, e.g. COM3 on Windows or /dev/ttyUSB0 elsewhere. */
    serialPath: optionalText,
    baudRate: z.number().min(50).max(4000000).default(115200),
    dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
    stopBits: z.union([z.literal(1), z.literal(2)]).default(1),
    parity: z.enum(SERIAL_PARITIES).default('none'),
    flowControl: z.enum(SERIAL_FLOW_CONTROL).default('none'),

    /** Macro run automatically once the session connects. */
    startupMacroId: optionalText,
    createdAt: optionalText,
    updatedAt: optionalText,
  })
  // Required fields differ by transport, so they are checked here rather than
  // forcing serial connections to carry a meaningless host and username.
  .superRefine((profile, ctx) => {
    if (profile.transport === 'ssh') {
      if (!profile.host.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['host'], message: 'Host is required' })
      }
      if (!profile.username.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['username'],
          message: 'Username is required',
        })
      }
    } else if (!profile.serialPath?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['serialPath'],
        message: 'Serial port is required',
      })
    }
  })

/**
 * Icon names offered for macro buttons. Kept as a shared list so the picker and
 * the renderer's icon map cannot drift apart.
 */
export const MACRO_ICONS = [
  'terminal',
  'play',
  'bolt',
  'server',
  'globe',
  'shield',
  'wrench',
  'chart',
  'folder',
  'clock',
  'refresh',
  'power',
  'search',
  'document',
  'signal',
  'lock',
] as const

export type MacroIcon = (typeof MACRO_ICONS)[number]

export const SSH_KEY_TYPES = ['rsa', 'ed25519'] as const

/**
 * Metadata for a keypair Smartcom Revisited generated or imported. The private key itself
 * never lives here — it is held in the OS-encrypted vault (see keychain.ts).
 */
export const SshKeySchema = z.object({
  id: optionalText,
  name: z.string().min(1),
  type: z.enum(SSH_KEY_TYPES).default('rsa'),
  /** RSA modulus size; ignored for ed25519. */
  bits: z.number().default(4096),
  /** OpenSSH one-line public key, ready for authorized_keys. */
  publicKey: z.string(),
  /** SHA256 fingerprint in OpenSSH form, e.g. `SHA256:abc…`. */
  fingerprint: z.string(),
  comment: z.string().default(''),
  /** Whether the stored private key is itself passphrase-protected. */
  hasPassphrase: z.boolean().default(false),
  createdAt: optionalText,
})

export type SshKey = z.infer<typeof SshKeySchema>
export type SshKeyType = (typeof SSH_KEY_TYPES)[number]

/**
 * A single input on a macro's popup form. The collected value is substituted
 * into step text wherever `{{name}}` appears.
 */
export const FormFieldSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Use letters, numbers and underscore; must not start with a digit'),
  label: optionalText,
  type: z
    .enum(['text', 'number', 'password', 'select', 'checkbox', 'textarea'])
    .default('text'),
  defaultValue: z.string().default(''),
  /** Choices for `select`. */
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  placeholder: optionalText,
  description: optionalText,
})

export const MACRO_STEP_TYPES = [
  /** Type text into the session. */
  'send',
  /** Block until a regex appears in the output (wait for prompt). */
  'expect',
  /** Wait a fixed number of milliseconds. */
  'delay',
  /** Pop a form mid-flow; answers become variables for the steps that follow. */
  'form',
  /** Ask yes/no before going on: "Do you want to reboot?" No stops the run. */
  'confirm',
  /** Halt until the operator clicks Resume. */
  'pause',
  /** Branch on whether a pattern appears before the timeout. */
  'if',
  /** Stop this macro (and optionally the whole run) early. */
  'exit',
  /** Copy a script from the library to the host, run it, then delete it. */
  'runScript',
  /** Run another button's script. */
  'callMacro',
  /** Run every button in another set, in order. */
  'callSet',
] as const

export type MacroStepType = (typeof MACRO_STEP_TYPES)[number]

const MacroStepBase = z.object({
  type: z.enum(MACRO_STEP_TYPES),
  /** `send`: text written to the shell. Supports `{{var}}` substitution. */
  text: optionalText,
  /** `send`: append a newline (i.e. press Enter) after the text. */
  appendEnter: z.boolean().default(false),
  /** `expect` / `if`: regex to look for in session output. */
  pattern: optionalText,
  delayMs: z.number().min(0).default(0),
  timeoutMs: z.number().min(0).optional(),
  repeat: z.number().min(1).optional(),

  /** `pause` / `confirm`: message shown to the operator. */
  message: optionalText,
  /** `form` / `confirm`: heading on the popup. */
  title: optionalText,
  /** `confirm`: label on the button that carries on. Defaults to "Yes". */
  confirmLabel: optionalText,
  /** `confirm`: label on the button that stops. Defaults to "No". */
  cancelLabel: optionalText,
  /** `confirm`: style the go-ahead as destructive — reboots, wipes, reloads. */
  destructive: z.boolean().default(false),
  /** `form`: inputs collected at this point in the flow. */
  fields: z.array(FormFieldSchema).default([]),
  /** `exit` / `confirm`: also abort any macros that called this one. */
  exitAll: z.boolean().default(false),

  /**
   * `runScript`: path of the script inside the library folder, relative to its
   * root (e.g. `cisco/backup-config.sh`). Stored relative so a shared button
   * still resolves on someone else's machine.
   */
  scriptPath: optionalText,
  /** `runScript`: directory on the host to stage the file in. */
  remoteDir: optionalText,
  /** `runScript`: run it with this interpreter instead of executing directly. */
  interpreter: optionalText,
  /** `runScript`: arguments appended to the command; supports `{{var}}`. */
  scriptArgs: optionalText,
  /** `runScript`: delete the staged copy once it has run. */
  cleanupAfterRun: z.boolean().default(true),

  /** `callMacro`: id of the macro to run. */
  targetMacroId: optionalText,
  /** `callSet`: id of the macro set whose macros run in order. */
  targetSetId: optionalText,
  /**
   * Values handed to the callee, keyed by the callee's field name. Values may
   * themselves reference the caller's variables, e.g. `{ HOST: '{{TARGET}}' }`.
   */
  args: z.record(z.string()).default({}),
  /** Keep going if this step fails instead of aborting the macro. */
  continueOnError: z.boolean().default(false),
})

export type MacroStep = z.infer<typeof MacroStepBase> & {
  /** `if`: steps run when `pattern` matched. */
  thenSteps: MacroStep[]
  /** `if`: steps run when it did not. */
  elseSteps: MacroStep[]
}

// `if` nests steps, so the schema has to reference itself lazily.
export const MacroStepSchema: z.ZodType<MacroStep> = z.lazy(() =>
  MacroStepBase.extend({
    thenSteps: z.array(MacroStepSchema).default([]),
    elseSteps: z.array(MacroStepSchema).default([]),
  })
) as z.ZodType<MacroStep>

export const MacroSchema = z.object({
  id: optionalText,
  setId: z.string(),
  name: z.string().min(1),
  description: optionalText,
  steps: z.array(MacroStepSchema),
  /** Popup form definition. Empty means the macro runs immediately. */
  fields: z.array(FormFieldSchema).default([]),
  /** Legacy plain-name placeholders, migrated into `fields` on read. */
  placeholders: z.array(z.string()).default([]),
  /** Button tint in the macro panel. */
  color: optionalText,
  /** Named icon shown on the button (see MACRO_ICONS). */
  icon: optionalText,
  confirmBeforeRun: z.boolean().default(false),
  createdAt: optionalText,
  updatedAt: optionalText,
})

export const MacroSetSchema = z.object({
  id: optionalText,
  name: z.string().min(1),
  description: optionalText,
  color: optionalText,
  createdAt: optionalText,
  updatedAt: optionalText,
})

export const AuditLogSchema = z.object({
  id: optionalText,
  timestamp: z.string(),
  userMachine: z.string(),
  sessionId: z.string(),
  /** Cleared when the connection is deleted; the log entry itself is kept. */
  profileId: optionalText,
  /** Who the entry was about, recorded at the time so it survives a delete. */
  profileLabel: optionalText,
  macroId: optionalText,
  macroName: optionalText,
  commands: z.array(z.string()),
  result: z.enum(['success', 'timeout', 'error']),
  stdoutSnippet: optionalText,
  stderrSnippet: optionalText,
})

export const SessionSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  profileName: z.string(),
  status: z.enum(['connecting', 'connected', 'disconnected', 'error']),
  createdAt: z.string(),
  lastActivity: optionalText,
  error: optionalText,
  /** Path of the active PuTTY-style session log, if logging is on. */
  logPath: optionalText,
})

/** How terminals are arranged in the workspace. */
export const LayoutModeSchema = z.enum(['tabs', 'grid', 'fullscreen'])

export const SettingsSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  fontSize: z.number().min(8).max(24).default(14),
  fontFamily: z.string().default('JetBrains Mono'),
  scrollback: z.number().min(100).max(100000).default(5000),
  logRetentionDays: z.number().min(1).max(365).default(90),
  enableKeepalive: z.boolean().default(true),
  keepaliveInterval: z.number().min(10).max(300).default(30),
  autoReconnect: z.boolean().default(true),
  maskSensitiveData: z.boolean().default(true),
  defaultShell: z.string().default('/bin/bash'),

  /**
   * Folder holding the script library. The folder on disk is the source of
   * truth — scripts are read at send time, so editing one in your own editor
   * (or pulling new ones from git) needs no re-import.
   */
  scriptLibraryDir: z.string().default(''),
  /** Where scripts are staged on the host before running. */
  scriptRemoteDir: z.string().default('/tmp'),

  // Workspace layout
  layoutMode: LayoutModeSchema.default('tabs'),
  /** 0 = auto (square-ish); otherwise a fixed column count for grid mode. */
  gridColumns: z.number().min(0).max(6).default(0),
  /** Type into every connected pane at once (tmux `setw synchronize-panes`). */
  broadcastInput: z.boolean().default(false),

  // PuTTY-style session logging
  sessionLogDir: z.string().default(''),
  /** Begin logging automatically whenever a session opens. */
  autoStartSessionLog: z.boolean().default(false),
  /** `raw` keeps ANSI escapes; `plain` strips them for readable text logs. */
  sessionLogFormat: z.enum(['raw', 'plain']).default('plain'),

  // Updates
  /** Look for a new release shortly after start-up. */
  autoUpdateCheck: z.boolean().default(true),
  /**
   * Fetch the update in the background once found, so installing it is one
   * click. Turn off on a metered connection — the check itself is tiny.
   */
  autoUpdateDownload: z.boolean().default(true),
})

export type Profile = z.infer<typeof ProfileSchema>
export type FormField = z.infer<typeof FormFieldSchema>
export type Macro = z.infer<typeof MacroSchema>
export type MacroSet = z.infer<typeof MacroSetSchema>
export type AuditLog = z.infer<typeof AuditLogSchema>
export type Session = z.infer<typeof SessionSchema>
export type Settings = z.infer<typeof SettingsSchema>
export type LayoutMode = z.infer<typeof LayoutModeSchema>

/**
 * One entry in the script library tree. The library is a folder on disk that
 * the app only indexes, so these mirror what is really there rather than rows
 * the app owns.
 */
export interface ScriptEntry {
  /** Path relative to the library root, POSIX separators: `cisco/backup.sh`. */
  path: string
  name: string
  type: 'file' | 'folder'
  size: number
  modifiedAt: string
  children?: ScriptEntry[]
}

/**
 * Portable button-set file. Sets are exported with their buttons so a set can
 * be shared or moved between machines; ids are remapped on import, so a bundle
 * never collides with what is already installed.
 */
export const BUTTON_SET_FORMAT = 'smartcom-revisited/button-set'

export const ButtonSetBundleSchema = z.object({
  format: z.literal(BUTTON_SET_FORMAT),
  version: z.literal(1),
  exportedAt: optionalText,
  exportedBy: optionalText,
  sets: z.array(MacroSetSchema),
  macros: z.array(MacroSchema),
})

export type ButtonSetBundle = z.infer<typeof ButtonSetBundleSchema>

/**
 * Portable connection file. Secrets are deliberately excluded — passwords and
 * key passphrases stay in the OS vault and never travel in an export.
 */
export const CONNECTION_FORMAT = 'smartcom-revisited/connections'

export const ConnectionBundleSchema = z.object({
  format: z.literal(CONNECTION_FORMAT),
  version: z.literal(1),
  exportedAt: optionalText,
  exportedBy: optionalText,
  groups: z.array(ConnectionGroupSchema),
  profiles: z.array(ProfileSchema),
})

export type ConnectionBundle = z.infer<typeof ConnectionBundleSchema>

/** A serial device offered by the host machine. */
export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  friendlyName?: string
  productId?: string
  vendorId?: string
}

export const MacroRunParamsSchema = z.object({
  macroId: z.string(),
  sessionId: z.string(),
  /** Values for this macro's form fields, keyed by field name. */
  variables: z.record(z.string()).default({}),
})

export const LogFilterSchema = z.object({
  startDate: optionalText,
  endDate: optionalText,
  profileId: optionalText,
  macroSetId: optionalText,
  result: z.enum(['success', 'timeout', 'error']).optional(),
  searchText: optionalText,
})

export const ExportOptionsSchema = z.object({
  format: z.enum(['csv', 'json']),
  filters: LogFilterSchema.default({}),
})

export type MacroRunParams = z.infer<typeof MacroRunParamsSchema>
export type LogFilter = z.infer<typeof LogFilterSchema>
export type ExportOptions = z.infer<typeof ExportOptionsSchema>

/**
 * Macros saved before the form builder existed carry `placeholders: string[]`.
 * Treat those as plain required text inputs so old macros keep working.
 */
export function resolveFields(macro: Pick<Macro, 'fields' | 'placeholders'>): FormField[] {
  if (macro.fields && macro.fields.length > 0) return macro.fields
  return (macro.placeholders ?? []).map((name) =>
    FormFieldSchema.parse({ name, label: name, type: 'text', required: true })
  )
}

/** Replace every `{{NAME}}` occurrence with the matching variable value. */
export function interpolate(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? variables[name] : match
  )
}
