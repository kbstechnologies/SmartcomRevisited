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

export const TRANSPORTS = ['ssh', 'serial', 'local'] as const
export type Transport = (typeof TRANSPORTS)[number]

/**
 * Families of local shell. Drives the icon and the argument defaults; `other`
 * covers anything the operator typed in by hand.
 */
export const LOCAL_SHELL_KINDS = [
  'cmd',
  'powershell',
  'pwsh',
  'wsl',
  'bash',
  'zsh',
  'fish',
  'sh',
  'other',
] as const
export type LocalShellKind = (typeof LOCAL_SHELL_KINDS)[number]

export const SERIAL_PARITIES = ['none', 'even', 'odd', 'mark', 'space'] as const
export const SERIAL_FLOW_CONTROL = ['none', 'rtscts', 'xonxoff'] as const
export const COMMON_BAUD_RATES = [
  300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
] as const

export const ProfileSchema = z
  .object({
    id: optionalText,
    name: z.string().min(1),
    /**
     * Which kind of connection this is. Serial keeps the SmartCOM heritage;
     * `local` is a shell on this machine — WSL, PowerShell, cmd, bash, zsh —
     * run through a pty so it behaves like any other host in the list.
     */
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

    // --- Local shell ---
    /** Executable to run, e.g. `C:\Windows\System32\cmd.exe` or `/bin/zsh`. */
    shellCommand: optionalText,
    /**
     * Arguments passed to it, as a list rather than one string: a WSL distro
     * name or an installation path can contain spaces, and re-splitting a
     * joined command line would break exactly those cases.
     */
    shellArgs: z.array(z.string()).default([]),
    /** Directory the shell starts in; the user's home when blank. */
    shellCwd: optionalText,
    /** Which family this is, for the icon. Cosmetic only. */
    shellKind: z.enum(LOCAL_SHELL_KINDS).default('other'),

    /** Macro run automatically once the session connects. */
    startupMacroId: optionalText,
    /**
     * Button sets shown while a session to this connection is in front.
     *
     * Empty means "no opinion — show everything", which is what an existing
     * connection and a freshly created one both do. It is deliberately a filter
     * rather than a grant: the sets still exist and are one click away in the
     * panel's right-click menu, so a wrong assignment hides work, never loses
     * it. Ids of sets this machine does not have are dropped on read.
     */
    macroSetIds: z.array(z.string()).default([]),
    /**
     * Labels describing what this host *is* — `cisco`, `switch`, `production`.
     *
     * Where `macroSetIds` names specific sets, tags say what the box is and let
     * the sets find it. Tagging one connection `cisco` surfaces every set
     * tagged `cisco`, including ones installed next month, which naming sets by
     * id cannot do. The two are additive: a set shows if it is named *or*
     * shares a tag.
     */
    // `normaliseTags` is declared further down; the function declaration is
    // hoisted, and sharing it matters — two normalisers that drifted apart
    // would show up as tags that look identical and refuse to match.
    tags: z
      .array(z.string())
      .default([])
      .transform((tags) => normaliseTags(tags)),
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
    } else if (profile.transport === 'local') {
      if (!profile.shellCommand?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['shellCommand'],
          message: 'Shell command is required',
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
  /**
   * Repeat until a pattern appears — polling a device until it says it is
   * done. Always bounded by `maxIterations`; see the engine for why an
   * unbounded loop against a live device is not on offer.
   */
  'while',
  /**
   * Run the body once per item in a list held in a variable — the interfaces
   * an `expect` just captured, a list typed into a form.
   */
  'forEach',
  /** Stop this macro (and optionally the whole run) early. */
  'exit',
  /** Copy a script from the library to the host, run it, then delete it. */
  'runScript',
  /**
   * Fetch a file from the host over SFTP — the capture a button just made,
   * a config it just wrote.
   */
  'download',
  /** Send a local file to the host over SFTP. */
  'upload',
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

  /**
   * `while` / `forEach`: hard cap on iterations.
   *
   * Mandatory in effect — the engine applies a ceiling whatever this says.
   * A loop that cannot terminate is bad enough in a script; against a live
   * switch, with a button somebody shared, it is a way to hold a shell open
   * forever issuing commands nobody is reading.
   */
  maxIterations: z.number().min(1).max(1000).default(50),

  /** `forEach`: name of the variable holding the list to walk. */
  listVariable: optionalText,
  /**
   * `forEach`: name bound to each item in turn. Defaults to `ITEM`.
   */
  itemVariable: optionalText,
  /**
   * `forEach`: what separates the items. `lines` suits captured command
   * output; `comma` suits something typed into a form.
   */
  listSeparator: z.enum(['lines', 'comma', 'whitespace']).default('lines'),

  /**
   * `download` / `upload`: path on the host. Supports `{{var}}`, which is the
   * point — an `expect` capture can name a file the device chose itself.
   */
  remotePath: optionalText,
  /**
   * `download` / `upload`: path relative to the configured transfer folder.
   *
   * Relative on purpose. An absolute path in a shared button could read a
   * private key on upload or overwrite something on download, so the engine
   * resolves this inside the transfer folder and refuses anything escaping it.
   * Left blank on a download, the remote filename is used.
   */
  localPath: optionalText,
  /**
   * `download`: replace an existing local file instead of saving beside it.
   *
   * Off by default. Collecting the same file twice is normal — the same button
   * against the same host an hour later — and silently replacing the earlier
   * result is the outcome nobody asks for.
   */
  overwrite: z.boolean().default(false),
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
  /**
   * Id of the button this one was copied from, set by "copy" and by starring.
   *
   * Copies are independent from the moment they are made — editing one never
   * touches the other — so this is provenance, not a link. It exists so the
   * star can be a toggle: without it, un-starring would have to guess which
   * favourite came from which button, and "Interface Status" exists in a dozen
   * sets. A dangling value is harmless and is treated as "not a copy".
   */
  sourceMacroId: optionalText,
  createdAt: optionalText,
  updatedAt: optionalText,
})

/**
 * The favourites set: one reserved set every install has, holding copies of the
 * buttons the operator stars.
 *
 * The id is fixed rather than looked up by name so that starring can find it
 * without a search, and so renaming it does not orphan the feature. It is
 * exempt from the per-connection filter — a favourite is a favourite whichever
 * host is in front, which is the whole point of starring it.
 *
 * On import the id is remapped like any other, so someone else's exported
 * favourites arrive as an ordinary set rather than merging into yours.
 */
export const FAVOURITES_SET_ID = 'favourites'
export const FAVOURITES_SET_NAME = 'Favourites'

/**
 * Normalises a tag so "Cisco", " cisco " and "CISCO" are one tag.
 *
 * Tags are matched across two things a user edits in different places, months
 * apart — a connection and a button set — so anything that makes two visually
 * identical tags fail to match would be reported as the feature not working.
 * Lower-cased, trimmed, inner whitespace collapsed to a single hyphen.
 */
export function normaliseTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-')
}

/** Cleans a list of tags: normalised, de-duplicated, blanks dropped, sorted. */
export function normaliseTags(tags: readonly string[] | undefined): string[] {
  return [...new Set((tags ?? []).map(normaliseTag).filter(Boolean))].sort()
}

const TagsSchema = z
  .array(z.string())
  .default([])
  .transform((tags) => normaliseTags(tags))

export const MacroSetSchema = z.object({
  id: optionalText,
  name: z.string().min(1),
  description: optionalText,
  color: optionalText,
  /**
   * Free-form labels used to match this set to connections — `cisco`,
   * `firewall`, `customer-acme`. A set shows on any connection sharing one.
   *
   * Part of the exported bundle, so a shared set arrives already labelled and
   * starts matching the recipient's hosts without them tagging anything.
   */
  tags: TagsSchema,
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

  /**
   * Folder that `download` and `upload` steps are confined to.
   *
   * Both directions are restricted to it, and that is a security boundary
   * rather than tidiness: a button from the exchange could otherwise read a
   * private key off this machine and upload it somewhere, which would look
   * like a perfectly ordinary run. Blank means a `transfers` folder inside the
   * app's own data directory.
   */
  transferDir: z.string().default(''),

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

/**
 * A shell this machine can actually start, as found by the main process.
 *
 * The renderer only ever offers what came back from detection, so a connection
 * cannot be saved pointing at a PowerShell 7 that is not installed. The
 * command is still editable by hand for anything detection misses.
 */
export interface LocalShellInfo {
  /** Unique on this machine — 'cmd', 'pwsh', 'wsl:Ubuntu-22.04'. */
  id: string
  /** What the picker shows, e.g. "WSL — Ubuntu-22.04". */
  label: string
  command: string
  args: string[]
  kind: LocalShellKind
  /** True for the machine's login shell, so the form can preselect it. */
  isDefault?: boolean
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
