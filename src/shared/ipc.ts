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

  // Local shells
  z.object({ channel: z.literal('local:list-shells'), data: z.any().optional() }),

  // Sessions
  z.object({ channel: z.literal('sessions:list'), data: z.any().optional() }),
  z.object({ channel: z.literal('sessions:open'), data: z.object({ profileId: z.string() }) }),
  z.object({
    channel: z.literal('sessions:open-many'),
    data: z.object({ profileIds: z.array(z.string()).min(1) }),
  }),
  z.object({
    channel: z.literal('sessions:close'),
    data: z.object({
      sessionId: z.string(),
      /**
       * Close even though a macro is running. Absent, the main process refuses
       * and reports what is in flight so the renderer can ask — the check lives
       * there rather than in the renderer because the renderer's idea of
       * "busy" is a broadcast it may have missed.
       */
      force: z.boolean().default(false),
    }),
  }),
  /** Macros in flight, so a window that just opened can render the indicators. */
  z.object({ channel: z.literal('macros:running'), data: z.any().optional() }),
  /**
   * Reads a SecureCRT session store and reports what *would* be imported.
   * Separate from the write so nothing lands before it has been seen.
   */
  z.object({
    channel: z.literal('profiles:scan-securecrt'),
    data: z.object({ folder: z.string().optional() }).default({}),
  }),
  /** Creates the connections a scan proposed. */
  z.object({
    channel: z.literal('profiles:import-securecrt'),
    data: z.object({ folder: z.string() }),
  }),
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
  // The Insert buttons — the assistant panel's and the tldr panel's — and
  // nothing else. Distinct from `sessions:paste` because it refuses anything
  // that would run itself: it strips trailing newlines and declines multi-line
  // text on a remote that cannot tell a paste from typing. See
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

  /**
   * Fetches one file from the host over SFTP, for the operator rather than for
   * a button.
   *
   * `remotePath` is typed by the person at the keyboard, and where it lands is
   * chosen in the system's own save dialog — so unlike the `download` macro
   * step this is **not** confined to the transfer folder. The confinement in
   * `file-transfer.ts` exists because a button from the exchange supplies its
   * own paths; here both ends are the operator's deliberate choice in the
   * moment, which is the same trust model as any browser download.
   */
  z.object({
    channel: z.literal('sessions:download-file'),
    data: z.object({
      sessionId: z.string(),
      /** Absolute or relative to the login directory, as SFTP resolves it. */
      remotePath: z.string().min(1).max(4096),
    }),
  }),

  // SFTP explorer and download queue.
  //
  // Browsing is a question with an immediate answer; a download is work that
  // outlives the panel that started it. So the queue lives in the main process
  // and every window watches it — closing the explorer does not cancel a
  // transfer, and the same queue is visible wherever it is looked at.
  z.object({
    channel: z.literal('sftp:list'),
    data: z.object({
      sessionId: z.string(),
      /** `.` opens where an SSH login lands rather than at the root. */
      path: z.string().default('.'),
    }),
  }),
  /** Which sessions have an explorer pane open. Shared so pop-out works. */
  z.object({ channel: z.literal('sftp:panes'), data: z.any().optional() }),
  z.object({
    channel: z.literal('sftp:open-pane'),
    data: z.object({ sessionId: z.string() }),
  }),
  z.object({
    channel: z.literal('sftp:close-pane'),
    data: z.object({ sessionId: z.string() }),
  }),
  /**
   * Queues files. The destination folder is chosen once in the system's own
   * picker — per-file prompting is unusable for a queue, and confining it to
   * the transfer folder would defeat the point of a browser.
   */
  z.object({
    channel: z.literal('sftp:enqueue'),
    data: z.object({
      sessionId: z.string(),
      files: z
        .array(
          z.object({
            remotePath: z.string().min(1).max(4096),
            name: z.string().min(1).max(512),
            size: z.number().min(0).default(0),
          })
        )
        .min(1)
        .max(500),
    }),
  }),
  z.object({ channel: z.literal('sftp:queue'), data: z.any().optional() }),
  z.object({
    channel: z.literal('sftp:cancel'),
    data: z.object({ transferId: z.string() }),
  }),
  z.object({ channel: z.literal('sftp:cancel-all'), data: z.any().optional() }),
  z.object({ channel: z.literal('sftp:clear-finished'), data: z.any().optional() }),
  z.object({
    channel: z.literal('sftp:retry'),
    data: z.object({ transferId: z.string() }),
  }),
  /** Opens a completed download in the system file manager. */
  z.object({
    channel: z.literal('sftp:reveal'),
    data: z.object({ transferId: z.string() }),
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

  // tldr command intelligence.
  //
  // Reads are cheap and index-only; `tldr:run` is the one channel here that
  // acts, and it is gated in the main process rather than only in the panel —
  // see the case in main.ts.
  z.object({ channel: z.literal('tldr:status'), data: z.any().optional() }),
  z.object({
    channel: z.literal('tldr:lookup'),
    data: z.object({ command: z.string(), platform: z.string().default('common') }),
  }),
  z.object({
    channel: z.literal('tldr:search'),
    data: z.object({
      query: z.string(),
      platform: z.string().default('common'),
      limit: z.number().min(1).max(200).default(40),
    }),
  }),
  z.object({
    channel: z.literal('tldr:page'),
    data: z.object({
      command: z.string(),
      platform: z.string().default('common'),
      /** True when `platform` names the page's own platform, not the session's. */
      exact: z.boolean().default(false),
    }),
  }),
  z.object({
    channel: z.literal('tldr:update'),
    data: z.object({ force: z.boolean().default(true) }).default({ force: true }),
  }),
  z.object({ channel: z.literal('tldr:rebuild'), data: z.any().optional() }),
  z.object({ channel: z.literal('tldr:clear'), data: z.any().optional() }),
  /**
   * Sends a command built in the tldr panel to one session, and only that one.
   *
   * `confirmedDestructive` is not a formality: the main process classifies the
   * command itself and refuses anything that looks destructive until the
   * operator has been shown it and said yes. A panel that forgot to ask cannot
   * make this run.
   */
  z.object({
    channel: z.literal('tldr:run'),
    data: z.object({
      sessionId: z.string(),
      command: z.string().min(1),
      confirmedDestructive: z.boolean().default(false),
    }),
  }),

  // SmartCom Cloud — the optional account.
  //
  // Every channel here answers with display data. **No token ever crosses this
  // boundary**: access tokens live in the main process's memory, refresh tokens
  // in the OS keystore, and `cloud:status` is names, dates and plan labels. A
  // compromised renderer gets nothing it could replay.
  //
  // `cloud:checkout` and `cloud:portal` return a URL for the main process to
  // open in the system browser. The app never renders a payment form — that is
  // the same rule the website follows, and it matters more here, since a card
  // number inside an Electron renderer would be a card number in a desktop
  // application's memory for no benefit at all.
  z.object({ channel: z.literal('cloud:status'), data: z.any().optional() }),
  z.object({ channel: z.literal('cloud:get-settings'), data: z.any().optional() }),
  z.object({
    channel: z.literal('cloud:save-settings'),
    data: z.object({
      enabled: z.boolean().optional(),
      baseUrl: z.string().optional(),
      deviceName: z.string().optional(),
    }),
  }),
  z.object({
    channel: z.literal('cloud:sign-in'),
    data: z.object({ email: z.string().email(), password: z.string().min(1) }),
  }),
  z.object({
    channel: z.literal('cloud:sign-out'),
    data: z.object({ everywhere: z.boolean().default(false) }).default({ everywhere: false }),
  }),
  /** Re-reads the account from the server. The panel's refresh button. */
  z.object({ channel: z.literal('cloud:refresh'), data: z.any().optional() }),
  z.object({ channel: z.literal('cloud:devices'), data: z.any().optional() }),
  z.object({
    channel: z.literal('cloud:rename-device'),
    data: z.object({ deviceId: z.string().min(1), name: z.string().min(1).max(100) }),
  }),
  /**
   * Ends a device's cloud access. Not a remote wipe — the machine keeps every
   * host, button and script it has and goes on working offline.
   */
  z.object({
    channel: z.literal('cloud:revoke-device'),
    data: z.object({ deviceId: z.string().min(1) }),
  }),
  z.object({
    channel: z.literal('cloud:checkout'),
    data: z.object({ plan: z.string().min(1) }),
  }),
  z.object({ channel: z.literal('cloud:portal'), data: z.any().optional() }),
  /** Opens the website's registration page. Sign-up is never proxied through the API. */
  z.object({ channel: z.literal('cloud:open-signup'), data: z.any().optional() }),

  // Sync. Reads are cheap; `cloud:sync-now` is the only one that acts, and it
  // is single-flight in the main process — pressing the button twice joins the
  // run already going rather than starting a second.
  z.object({ channel: z.literal('cloud:sync-status'), data: z.any().optional() }),
  z.object({ channel: z.literal('cloud:sync-now'), data: z.any().optional() }),
  /**
   * Queues every local object for upload.
   *
   * The first sync of an install that already has data, and the repair path
   * when a machine is linked to a different workspace. It only marks things as
   * needing to be sent — it changes no data and deletes nothing.
   */
  z.object({ channel: z.literal('cloud:sync-everything'), data: z.any().optional() }),

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
  /** The full set of in-flight macros, whenever one starts or finishes. */
  'macro-running-changed',
  'macro-form-request',
  'macro-confirm-request',
  'ai-stream',
  /**
   * Progress of a manual SFTP download. A capture file is routinely hundreds
   * of megabytes, so a transfer with no feedback looks like a hung app.
   */
  'file-transfer-progress',
  /** The whole download queue, whenever anything in it moves. */
  'sftp-queue-changed',
  /** Which sessions have an explorer open — so a pane survives a pop-out. */
  'sftp-panes-changed',
  /** tldr cache state: download progress, index rebuilds, failures. */
  'tldr-status',
  /**
   * Account state: signed in or out, plan, last error. Pushed rather than
   * polled because a token rotation can sign a machine out between one panel
   * open and the next, and every window has to agree about that.
   */
  'cloud-status',
  /** Sync progress and its last error, pushed as a run starts and finishes. */
  'cloud-sync-status',
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
