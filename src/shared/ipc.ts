import { z } from 'zod'
import {
  ProfileSchema,
  MacroSchema,
  MacroSetSchema,
  SettingsSchema,
  MacroRunParamsSchema,
  LogFilterSchema,
  ExportOptionsSchema,
  ConnectionGroupSchema,
} from './types'
import { AiAskSchema, AiSettingsSchema } from './ai'

export const IpcRequestSchema = z.discriminatedUnion('channel', [
  // Profiles
  z.object({ channel: z.literal('profiles:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('profiles:get'), data: z.object({ id: z.string() }) }),
  z.object({ channel: z.literal('profiles:save'), data: ProfileSchema }),
  z.object({ channel: z.literal('profiles:delete'), data: z.object({ id: z.string() }) }),
  z.object({ channel: z.literal('profiles:test'), data: z.object({ id: z.string() }) }),
  z.object({
    channel: z.literal('profiles:export'),
    data: z.object({ profileIds: z.array(z.string()).optional() }).default({}),
  }),
  z.object({ channel: z.literal('profiles:import'), data: z.any().optional() }),
  z.object({
    channel: z.literal('profiles:export-securecrt'),
    data: z
      .object({
        profileIds: z.array(z.string()).optional(),
        /** Off by default: an account name leaving the machine is a choice. */
        includeUsernames: z.boolean().default(false),
      })
      .default({ includeUsernames: false }),
  }),

  // Connection groups
  z.object({ channel: z.literal('groups:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('groups:save'), data: ConnectionGroupSchema }),
  z.object({ channel: z.literal('groups:delete'), data: z.object({ id: z.string() }) }),

  // Serial
  z.object({ channel: z.literal('serial:list-ports'), data: z.any().optional() }),

  // Sessions
  z.object({ channel: z.literal('sessions:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('sessions:open'), data: z.object({ profileId: z.string() }) }),
  z.object({
    channel: z.literal('sessions:open-many'),
    data: z.object({ profileIds: z.array(z.string()).min(1) }),
  }),
  z.object({ channel: z.literal('sessions:close'), data: z.object({ sessionId: z.string() }) }),
  // Raw output so far, so a pane that mounts after the session started — a
  // popped-out window, a reloaded one — shows the history instead of nothing.
  z.object({ channel: z.literal('sessions:scrollback'), data: z.object({ sessionId: z.string() }) }),
  z.object({
    channel: z.literal('sessions:send'),
    data: z.object({ sessionId: z.string(), text: z.string() }),
  }),
  // Text that came from the clipboard or from a suggestion, rather than from
  // keystrokes. The main process converts line endings and, when the remote has
  // asked for bracketed paste, wraps it — sending it as typing corrupts
  // anything multi-line.
  z.object({
    channel: z.literal('sessions:paste'),
    data: z.object({ sessionId: z.string(), text: z.string() }),
  }),
  // The assistant's Insert button, and nothing else. Distinct from
  // `sessions:paste` because it refuses anything that would run itself — see
  // src/shared/assistant-contract.ts.
  z.object({
    channel: z.literal('sessions:insert-suggestion'),
    data: z.object({ sessionId: z.string(), text: z.string() }),
  }),
  z.object({
    channel: z.literal('sessions:broadcast'),
    data: z.object({ sessionIds: z.array(z.string()), text: z.string() }),
  }),
  z.object({
    channel: z.literal('sessions:resize'),
    data: z.object({ sessionId: z.string(), cols: z.number(), rows: z.number() }),
  }),

  // PuTTY-style session logging
  z.object({
    channel: z.literal('sessions:log-start'),
    data: z.object({
      sessionId: z.string(),
      /** Omit to auto-name the file under the configured log directory. */
      filePath: z.string().optional(),
      /** Omit to use the `sessionLogFormat` setting. */
      format: z.enum(['raw', 'plain']).optional(),
    }),
  }),
  z.object({ channel: z.literal('sessions:log-stop'), data: z.object({ sessionId: z.string() }) }),
  z.object({ channel: z.literal('sessions:log-status'), data: z.any().optional() }),
  z.object({ channel: z.literal('sessions:log-reveal'), data: z.object({ sessionId: z.string() }) }),

  // Macros
  z.object({ channel: z.literal('macros:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('macros:get'), data: z.object({ id: z.string() }) }),
  z.object({ channel: z.literal('macros:save'), data: MacroSchema }),
  z.object({ channel: z.literal('macros:delete'), data: z.object({ id: z.string() }) }),
  z.object({
    channel: z.literal('macros:copy'),
    data: z.object({
      id: z.string(),
      targetSetId: z.string(),
      /** Blank or absent lets the database pick a name free in the target set. */
      name: z.string().optional(),
    }),
  }),
  z.object({ channel: z.literal('macros:toggle-favourite'), data: z.object({ id: z.string() }) }),
  z.object({ channel: z.literal('macros:run'), data: MacroRunParamsSchema }),
  z.object({ channel: z.literal('macros:cancel'), data: z.object({ sessionId: z.string() }) }),
  z.object({ channel: z.literal('macros:resume'), data: z.object({ sessionId: z.string() }) }),
  z.object({
    channel: z.literal('macros:submit-form'),
    data: z.object({
      requestId: z.string(),
      /** null when the operator dismissed the form, which stops the run. */
      values: z.record(z.string()).nullable(),
    }),
  }),
  // Script library — a folder on disk, indexed and staged over SFTP
  z.object({ channel: z.literal('scripts:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('scripts:read'), data: z.object({ path: z.string() }) }),
  z.object({ channel: z.literal('scripts:choose-folder'), data: z.any().optional() }),
  z.object({ channel: z.literal('scripts:reveal'), data: z.any().optional() }),
  z.object({
    channel: z.literal('scripts:run'),
    data: z.object({
      sessionId: z.string(),
      path: z.string(),
      remoteDir: z.string().optional(),
      interpreter: z.string().optional(),
      args: z.string().optional(),
      cleanup: z.boolean().optional(),
    }),
  }),
  // Global variables — one text file whose NAME=value lines are available to
  // every button and script as {{NAME}}.
  z.object({ channel: z.literal('globals:get'), data: z.any().optional() }),
  z.object({ channel: z.literal('globals:save'), data: z.object({ text: z.string() }) }),
  z.object({ channel: z.literal('globals:reveal'), data: z.any().optional() }),

  z.object({
    channel: z.literal('macros:submit-confirm'),
    data: z.object({
      requestId: z.string(),
      /** false when the operator declined or dismissed, which stops the run. */
      confirmed: z.boolean(),
    }),
  }),

  // Macro Sets
  z.object({ channel: z.literal('macro-sets:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('macro-sets:save'), data: MacroSetSchema }),
  z.object({ channel: z.literal('macro-sets:delete'), data: z.object({ id: z.string() }) }),
  z.object({
    channel: z.literal('macro-sets:export'),
    data: z.object({ setIds: z.array(z.string()).min(1) }),
  }),
  z.object({ channel: z.literal('macro-sets:import'), data: z.any().optional() }),

  // Audit Logs
  z.object({ channel: z.literal('logs:query'), data: LogFilterSchema.default({}) }),
  z.object({ channel: z.literal('logs:export'), data: ExportOptionsSchema }),

  // Settings
  z.object({ channel: z.literal('settings:get'), data: z.any().optional() }),
  z.object({ channel: z.literal('settings:save'), data: SettingsSchema.partial() }),

  // Secrets
  z.object({
    channel: z.literal('secrets:get'),
    data: z.object({ service: z.string(), account: z.string() }),
  }),
  z.object({
    channel: z.literal('secrets:set'),
    data: z.object({ service: z.string(), account: z.string(), password: z.string() }),
  }),
  z.object({
    channel: z.literal('secrets:delete'),
    data: z.object({ service: z.string(), account: z.string() }),
  }),

  // SSH keys
  z.object({ channel: z.literal('keys:list'), data: z.any().optional() }),
  z.object({
    channel: z.literal('keys:generate'),
    data: z.object({
      name: z.string().min(1),
      // ed25519 by default: it is what ssh-keygen has defaulted to for years,
      // and RSA is now the deliberate choice for older kit.
      type: z.enum(['rsa', 'ed25519']).default('ed25519'),
      /** RSA modulus size, ignored for ed25519 — the curve fixes its length. */
      bits: z.number().min(2048).max(8192).default(4096),
      comment: z.string().default(''),
      /** Encrypts the private key at rest, on top of the OS-backed vault. */
      passphrase: z.string().optional(),
    }),
  }),
  z.object({
    channel: z.literal('keys:import'),
    data: z.object({
      name: z.string().min(1),
      /** PEM or OpenSSH private key text. */
      privateKey: z.string().min(1),
      passphrase: z.string().optional(),
      comment: z.string().default(''),
    }),
  }),
  z.object({ channel: z.literal('keys:delete'), data: z.object({ id: z.string() }) }),
  z.object({ channel: z.literal('keys:get-public'), data: z.object({ id: z.string() }) }),
  z.object({
    channel: z.literal('keys:export-private'),
    data: z.object({ id: z.string() }),
  }),
  z.object({
    channel: z.literal('keys:deploy'),
    data: z.object({
      keyId: z.string(),
      profileId: z.string(),
      /** Reuse a live session's connection instead of authenticating again. */
      sessionId: z.string().optional(),
      /** Password for a one-off connection when no session is supplied. */
      password: z.string().optional(),
    }),
  }),

  // Dialogs
  z.object({
    channel: z.literal('dialog:pick-directory'),
    data: z.any().optional(),
  }),
  z.object({
    channel: z.literal('dialog:pick-file'),
    data: z.any().optional(),
  }),

  // Assistant
  z.object({ channel: z.literal('ai:ask'), data: AiAskSchema }),
  z.object({ channel: z.literal('ai:cancel'), data: z.object({ requestId: z.string() }) }),
  z.object({ channel: z.literal('ai:get-settings'), data: z.any().optional() }),
  z.object({ channel: z.literal('ai:save-settings'), data: AiSettingsSchema.partial() }),
  z.object({
    channel: z.literal('ai:set-key'),
    data: z.object({ provider: z.enum(['anthropic', 'openai', 'ollama']), apiKey: z.string() }),
  }),
  z.object({ channel: z.literal('ai:key-status'), data: z.any().optional() }),
  z.object({ channel: z.literal('ai:list-models'), data: z.any().optional() }),

  // Detached terminal windows
  z.object({
    channel: z.literal('windows:detach'),
    data: z.object({ sessionIds: z.array(z.string()).min(1) }),
  }),
  z.object({ channel: z.literal('windows:list'), data: z.any().optional() }),
  z.object({
    channel: z.literal('windows:reattach'),
    data: z.object({ windowId: z.number() }),
  }),
  z.object({
    channel: z.literal('windows:set-active-session'),
    data: z.object({ sessionId: z.string().nullable() }),
  }),

  // Clipboard — through the main process so it works in the sandboxed
  // renderer without depending on the async clipboard API's permissions.
  z.object({ channel: z.literal('clipboard:write'), data: z.object({ text: z.string() }) }),
  z.object({ channel: z.literal('clipboard:read'), data: z.any().optional() }),

  // Updates
  z.object({ channel: z.literal('updates:status'), data: z.any().optional() }),
  z.object({
    channel: z.literal('updates:check'),
    data: z.object({ download: z.boolean().optional() }).optional(),
  }),
  z.object({ channel: z.literal('updates:download'), data: z.any().optional() }),
  z.object({ channel: z.literal('updates:install'), data: z.any().optional() }),
  z.object({ channel: z.literal('updates:open-releases'), data: z.any().optional() }),

  // App
  z.object({ channel: z.literal('app:get-version'), data: z.any().optional() }),
  z.object({ channel: z.literal('app:get-info'), data: z.any().optional() }),
  z.object({ channel: z.literal('app:open-path'), data: z.object({ path: z.string() }) }),
  z.object({ channel: z.literal('app:open-external'), data: z.object({ url: z.string().url() }) }),
  z.object({ channel: z.literal('app:quit'), data: z.any().optional() }),
])

export type IpcRequest = z.infer<typeof IpcRequestSchema>
export type IpcChannel = IpcRequest['channel']

export interface IpcResponse<T = any> {
  success: boolean
  data?: T
  error?: string
}

/** Main → renderer push channels. Mirrored by the preload allow-list. */
export const EVENT_CHANNELS = [
  'session-status-changed',
  'session-data',
  'session-log-changed',
  'macro-progress',
  'macro-form-request',
  'macro-confirm-request',
  'ai-stream',
  'active-session-changed',
  'session-placement-changed',
  'update-status',
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]

export interface ElectronAPI {
  invoke: <T = any>(channel: IpcChannel, data?: any) => Promise<IpcResponse<T>>
  on: (channel: EventChannel, listener: (payload: any) => void) => void
  off: (channel: EventChannel, listener: (payload: any) => void) => void
}
