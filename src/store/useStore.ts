import { create } from 'zustand'
import { clearSessionBuffer } from '../lib/sessionStream'
import { clearCommandLine } from '../lib/commandLine'
import type {
  Profile,
  Session,
  Macro,
  MacroSet,
  Settings,
  AuditLog,
  MacroRunParams,
  LogFilter,
  ExportOptions,
  LayoutMode,
  SshKey,
  FormField,
  ConnectionGroup,
  SerialPortInfo,
  LocalShellInfo,
  ScriptEntry,
} from '@shared/types'
import type { AiSettings, AiAsk, AiStreamEvent, AssistantTurn } from '@shared/ai'
import type { GlobalVar, GlobalVarProblem } from '@shared/global-vars'
import type { TldrCacheStatus, TldrPage, TldrPlatform, TldrSearchResult } from '@shared/tldr'

/** A macro in flight, as reported by the main process. */
export interface RunningMacro {
  sessionId: string
  macroId: string
  macroName: string
  profileName: string
  startedAt: string
}

/** The global variables file as the main process last read it. */
export interface GlobalVarsState {
  /** Where the file is, shown in the editor so it can be found on disk. */
  path: string
  /** Raw file text, so the editor can offer the file itself, not a rendering. */
  text: string
  vars: GlobalVar[]
  problems: GlobalVarProblem[]
}

/** An inline `form` step waiting on the operator. */
export interface PendingFormRequest {
  requestId: string
  sessionId: string
  title: string
  fields: FormField[]
}

/** An inline `confirm` step waiting on a yes or no. */
export interface PendingConfirmRequest {
  requestId: string
  sessionId: string
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  destructive: boolean
}

/** Modal dialogs that can be opened from more than one place. */
export type AppDialog = 'keys' | 'settings' | 'logs' | 'about' | 'scripts' | 'globals' | null

/**
 * Which tab the right-hand panel is showing.
 *
 * In the store rather than in Layout's own state because three different places
 * now need to raise it: the tldr indicator above the terminal, a Command Center
 * result, and the Ask AI button inside the tldr panel.
 */
export type SidePanel = 'buttons' | 'assistant' | 'tldr' | 'scratch'

/** What the tldr panel has been asked to show. */
export interface TldrRequest {
  command: string
  /** Session platform, or the page's own platform when `exact`. */
  platform: string
  /** True when `platform` names the page variant rather than the session. */
  exact?: boolean
  /** Session the panel should act on. Fixed at open time, then tracked. */
  sessionId: string | null
}

/** Answer to `tldr:page`. */
export interface TldrPageResult {
  page: TldrPage | null
  related: TldrSearchResult[]
  platforms: TldrPlatform[]
}

/** `tldr:status`, plus what the cache occupies on disk. */
export interface TldrStatus extends TldrCacheStatus {
  cacheBytes: number
}

/** Answer to `tldr:run`. A refusal is not an error — it is a question. */
export interface TldrRunResult {
  ran: boolean
  requiresConfirmation: boolean
  reasons: string[]
}

export interface MacroProgress {
  macroName?: string
  stepIndex?: number
  stepCount?: number
  depth?: number
  awaitingResume?: boolean
  message?: string
}

export interface OpenSessionOutcome {
  profileId: string
  profileName?: string
  sessionId?: string
  error?: string
}

interface AppStore {
  // UI State
  isCommandPaletteOpen: boolean
  activeSessionId: string | null
  isMacroRecording: boolean
  recordedCommands: string[]
  sidebarCollapsed: boolean
  theme: 'dark' | 'light'
  layoutMode: LayoutMode
  gridColumns: number
  broadcastInput: boolean
  /** Session id → path of its active log file. */
  sessionLogs: Record<string, string>
  /** Session id → latest macro progress report. */
  macroProgress: Record<string, MacroProgress>
  /** Macros in flight across every session, mirrored from the main process. */
  runningMacros: RunningMacro[]
  setRunningMacros: (running: RunningMacro[]) => void
  loadRunningMacros: () => Promise<void>
  pendingForm: PendingFormRequest | null
  pendingConfirm: PendingConfirmRequest | null
  /** Which modal is open. Shared so the command palette can open them too. */
  activeDialog: AppDialog
  /** Terminals shown in a detached window: session id -> window id. */
  sessionPlacement: Record<string, number>
  /** True when this renderer is a detached terminals-only window. */
  isDetachedWindow: boolean

  /**
   * The assistant conversation, its draft input and the in-flight request.
   * These belong to the app rather than to AssistantPanel because the panel
   * unmounts every time you switch to the buttons tab or collapse the side
   * panel — holding them locally cleared the conversation each time.
   */
  /** Script library folder and its tree, as last read from disk. */
  scriptLibrary: { root: string; entries: ScriptEntry[] }

  /**
   * Global variables, available to every button as `{{NAME}}`. Kept in the
   * store rather than in the editor dialog because the button panel resolves
   * form defaults through them before it prompts.
   */
  globalVars: GlobalVarsState

  assistantTurns: AssistantTurn[]
  assistantInput: string
  assistantRequestId: string | null
  /**
   * A question queued for the assistant from somewhere else in the app.
   *
   * The tldr panel's Ask AI does not build a second AI path: it drops the
   * question here and raises the assistant tab, and AssistantPanel sends it
   * through exactly the same `ai:ask` it uses for anything typed into it.
   */
  assistantPrefill: string | null

  /** Which tab the right-hand panel is showing. */
  sidePanel: SidePanel
  /** The page the tldr panel is showing, or null when it has nothing yet. */
  tldrRequest: TldrRequest | null
  /** Cache state, mirrored from the main process and its `tldr-status` push. */
  tldrStatus: TldrStatus | null
  /** Whether the searchable Command Center is open. */
  tldrSearchOpen: boolean

  /**
   * The scratch pad: somewhere to park text between two terminals.
   *
   * Held here and **nowhere else**. It is not a setting, it is not in the
   * database, and it is not written to disk — closing Smartcom throws it away,
   * which is the point. It lives in the store rather than in the component
   * only because the side panel unmounts whenever you switch tabs, which would
   * otherwise lose what you had parked in it a second ago.
   *
   * Deliberately not persisted for a second reason: the obvious thing to park
   * in it while working is a credential, and a notepad that quietly kept one
   * on disk would be a worse feature than no notepad.
   */
  scratchpad: string

  // Data
  profiles: Profile[]
  sessions: Session[]
  macros: Macro[]
  macroSets: MacroSet[]
  sshKeys: SshKey[]
  connectionGroups: ConnectionGroup[]
  settings: Partial<Settings>
  auditLogs: AuditLog[]

  // UI Actions
  setCommandPaletteOpen: (open: boolean) => void
  setActiveSession: (sessionId: string | null) => void
  setMacroRecording: (recording: boolean) => void
  addRecordedCommand: (command: string) => void
  clearRecordedCommands: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setTheme: (theme: 'dark' | 'light') => void
  setLayoutMode: (mode: LayoutMode) => void
  setGridColumns: (columns: number) => void
  setBroadcastInput: (enabled: boolean) => void
  setPendingForm: (request: PendingFormRequest | null) => void
  setPendingConfirm: (request: PendingConfirmRequest | null) => void
  submitMacroConfirm: (requestId: string, confirmed: boolean) => Promise<void>
  setActiveDialog: (dialog: AppDialog) => void
  setSessionPlacement: (placement: Record<string, number>) => void
  setDetachedWindow: (detached: boolean) => void
  loadSessionPlacement: () => Promise<void>
  detachSessions: (sessionIds: string[]) => Promise<void>
  reattachWindow: (windowId: number) => Promise<void>

  loadAiSettings: () => Promise<AiSettings>
  saveAiSettings: (settings: Partial<AiSettings>) => Promise<AiSettings>
  setAiKey: (provider: string, apiKey: string) => Promise<void>
  aiKeyStatus: () => Promise<Record<string, boolean>>
  askAssistant: (ask: AiAsk) => Promise<void>
  cancelAssistant: (requestId: string) => Promise<void>
  loadScriptLibrary: () => Promise<void>
  chooseScriptFolder: () => Promise<boolean>
  readScript: (path: string) => Promise<{ path: string; content: string; size: number }>
  revealScriptFolder: () => Promise<void>
  loadGlobalVars: () => Promise<void>
  saveGlobalVars: (text: string) => Promise<GlobalVarsState>
  revealGlobalVars: () => Promise<void>
  runScriptOnSession: (params: {
    sessionId: string
    path: string
    remoteDir?: string
    interpreter?: string
    args?: string
    cleanup?: boolean
  }) => Promise<{ remotePath: string; command: string }>

  setAssistantTurns: (update: AssistantTurn[] | ((current: AssistantTurn[]) => AssistantTurn[])) => void
  setAssistantInput: (input: string) => void
  setAssistantRequestId: (requestId: string | null) => void
  setAssistantPrefill: (prompt: string | null) => void

  setScratchpad: (text: string) => void

  // tldr command intelligence
  setSidePanel: (panel: SidePanel) => void
  setTldrSearchOpen: (open: boolean) => void
  setTldrStatus: (status: TldrStatus) => void
  loadTldrStatus: () => Promise<void>
  /** Raises the tldr tab on a command. The only way the panel is opened. */
  openTldr: (request: {
    command: string
    platform: string
    exact?: boolean
    /** The pane this came from. Defaults to whatever has focus. */
    sessionId?: string | null
  }) => void
  closeTldr: () => void
  /** Index-only existence check. Safe to call on a typing debounce. */
  tldrLookup: (
    command: string,
    platform: string
  ) => Promise<{ found: boolean; platform: TldrPlatform | null }>
  tldrSearch: (query: string, platform: string, limit?: number) => Promise<TldrSearchResult[]>
  tldrPage: (command: string, platform: string, exact?: boolean) => Promise<TldrPageResult>
  tldrUpdate: () => Promise<TldrStatus>
  tldrRebuild: () => Promise<TldrStatus>
  tldrClear: () => Promise<TldrStatus>
  /**
   * Sends a built command to one session. The main process re-checks both the
   * target and the risk, so a `false` confirmation is a question, not a failure.
   */
  runTldrCommand: (
    sessionId: string,
    command: string,
    confirmedDestructive?: boolean
  ) => Promise<TldrRunResult>
  toggleTldrFavourite: (command: string) => Promise<void>
  /** Hands a question to the existing assistant panel and raises it. */
  askAiAbout: (prompt: string) => void
  /** Folds one streamed chunk into the trailing assistant turn. */
  applyAssistantStream: (event: AiStreamEvent) => void
  setMacroProgress: (sessionId: string, progress: MacroProgress) => void
  setSessionLog: (sessionId: string, logPath: string | null) => void

  // Data Actions
  loadProfiles: () => Promise<void>
  saveProfile: (profile: Profile) => Promise<Profile>
  deleteProfile: (id: string) => Promise<boolean>
  testProfile: (id: string) => Promise<{ success: boolean; error?: string }>
  exportConnections: (profileIds?: string[]) => Promise<{ filePath: string; profiles: number; groups: number }>
  /** Saved connections as a SecureCRT-importable CSV. Never carries secrets. */
  exportConnectionsForSecureCrt: (input: {
    profileIds?: string[]
    includeUsernames: boolean
  }) => Promise<{
    filePath: string
    readmePath: string
    exported: number
    skipped: Array<{ name: string; reason: string }>
    unsupported: Array<{ name: string; reason: string }>
  }>
  importConnections: () => Promise<{ groups: number; profiles: number; renamed: Array<{ from: string; to: string }> }>
  /** Reads a SecureCRT session store and reports what would be imported. */
  scanSecureCrt: () => Promise<{
    folder: string
    scanned: number
    candidates: Array<{ name: string; group?: string; transport: string; host?: string }>
    skipped: Array<{ name: string; reason: string }>
    unsupported: Array<{ name: string; reason: string }>
  }>
  /** Creates the connections a scan proposed. */
  importSecureCrt: (folder: string) => Promise<{
    imported: number
    renamed: Array<{ from: string; to: string }>
    skipped: Array<{ name: string; reason: string }>
    unsupported: Array<{ name: string; reason: string }>
  }>

  loadConnectionGroups: () => Promise<void>
  saveConnectionGroup: (group: ConnectionGroup) => Promise<ConnectionGroup>
  deleteConnectionGroup: (id: string) => Promise<boolean>

  listSerialPorts: () => Promise<SerialPortInfo[]>
  listLocalShells: () => Promise<LocalShellInfo[]>

  loadSessions: () => Promise<void>
  openSession: (profileId: string) => Promise<string>
  openSessions: (profileIds: string[]) => Promise<OpenSessionOutcome[]>
  /**
   * Closes a session. Refused when a macro is running unless `force` is set —
   * the refusal comes back as `blockedBy` so the caller can name what would be
   * lost rather than asking a generic question.
   */
  closeSession: (
    sessionId: string,
    force?: boolean
  ) => Promise<{ closed: boolean; blockedBy?: RunningMacro }>
  sendToSession: (sessionId: string, text: string) => Promise<boolean>
  /** Clipboard text, sent as a paste rather than as keystrokes. */
  pasteToSession: (sessionId: string, text: string) => Promise<boolean>
  /**
   * The assistant's Insert button. Never submits what it inserts, and refuses
   * anything the remote would run line by line — see assistant-contract.ts.
   */
  insertSuggestion: (
    sessionId: string,
    text: string
  ) => Promise<{ inserted: boolean; reason?: string; lines: number }>
  broadcast: (text: string) => Promise<void>
  resizeSession: (sessionId: string, cols: number, rows: number) => Promise<boolean>

  startSessionLog: (sessionId: string) => Promise<string | null>
  stopSessionLog: (sessionId: string) => Promise<void>
  toggleSessionLog: (sessionId: string) => Promise<void>
  revealSessionLog: (sessionId: string) => Promise<void>
  refreshLogStatus: () => Promise<void>

  loadMacros: () => Promise<void>
  loadMacroSets: () => Promise<void>
  saveMacro: (macro: Macro) => Promise<Macro>
  deleteMacro: (id: string) => Promise<boolean>
  /** Duplicates a button into another set. Returns the new copy. */
  copyMacro: (id: string, targetSetId: string, name?: string) => Promise<Macro>
  /** Stars or un-stars a button. Resolves to true when it is now a favourite. */
  toggleFavourite: (id: string) => Promise<boolean>
  saveMacroSet: (macroSet: MacroSet) => Promise<MacroSet>
  deleteMacroSet: (id: string) => Promise<boolean>
  exportMacroSets: (setIds: string[]) => Promise<{
    filePath: string
    sets: number
    macros: number
  }>
  importMacroSets: () => Promise<{
    sets: number
    macros: number
    renamed: Array<{ from: string; to: string }>
    droppedReferences: number
  }>
  runMacro: (params: MacroRunParams) => Promise<{ success: boolean; error?: string }>
  cancelMacro: (sessionId: string) => Promise<void>
  resumeMacro: (sessionId: string) => Promise<void>
  submitMacroForm: (requestId: string, values: Record<string, string> | null) => Promise<void>

  loadSshKeys: () => Promise<void>
  generateSshKey: (input: {
    name: string
    type: 'rsa' | 'ed25519'
    /** RSA modulus size. Omitted for ed25519, whose size is fixed by the curve. */
    bits?: number
    comment: string
    passphrase?: string
  }) => Promise<SshKey>
  importSshKey: (input: {
    name: string
    privateKey: string
    passphrase?: string
    comment: string
  }) => Promise<SshKey>
  deleteSshKey: (id: string) => Promise<boolean>
  exportSshKey: (id: string) => Promise<string>
  deploySshKey: (input: {
    keyId: string
    profileId: string
    sessionId?: string
    password?: string
  }) => Promise<{ status: string; output: string }>

  loadAuditLogs: (filter?: LogFilter) => Promise<void>
  exportLogs: (options: ExportOptions) => Promise<{ filePath: string }>

  loadSettings: () => Promise<void>
  saveSettings: (settings: Partial<Settings>) => Promise<void>

  getSecret: (service: string, account: string) => Promise<string | null>
  setSecret: (service: string, account: string, password: string) => Promise<boolean>
  deleteSecret: (service: string, account: string) => Promise<boolean>
}

/** Unwraps an IpcResponse, throwing the main-process error message. */
async function invoke<T>(channel: any, data?: any): Promise<T> {
  const response = await window.electronAPI.invoke<T>(channel, data)
  if (!response.success) {
    throw new Error(response.error || `${channel} failed`)
  }
  return response.data as T
}

/**
 * Tells the main process which session has focus so every window agrees on the
 * target the buttons act on. Failures are non-fatal: focus is a hint, and the
 * window that opened the session already tracks it locally.
 */
function announceActiveSession(sessionId: string): void {
  void window.electronAPI
    .invoke('windows:set-active-session', { sessionId })
    .catch(() => undefined)
}

const useStore = create<AppStore>((set, get) => ({
  // Initial state
  isCommandPaletteOpen: false,
  activeSessionId: null,
  isMacroRecording: false,
  recordedCommands: [],
  sidebarCollapsed: false,
  theme: 'dark',
  layoutMode: 'tabs',
  gridColumns: 0,
  broadcastInput: false,
  sessionLogs: {},
  macroProgress: {},
  runningMacros: [],
  pendingForm: null,
  pendingConfirm: null,
  activeDialog: null,
  sessionPlacement: {},
  isDetachedWindow: false,
  scriptLibrary: { root: '', entries: [] },
  globalVars: { path: '', text: '', vars: [], problems: [] },
  assistantTurns: [],
  assistantInput: '',
  assistantRequestId: null,
  assistantPrefill: null,
  sidePanel: 'buttons',
  tldrRequest: null,
  tldrStatus: null,
  tldrSearchOpen: false,
  scratchpad: '',
  profiles: [],
  sessions: [],
  macros: [],
  macroSets: [],
  sshKeys: [],
  connectionGroups: [],
  settings: {},
  auditLogs: [],

  // UI Actions
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  setMacroRecording: (recording) => set({ isMacroRecording: recording }),
  addRecordedCommand: (command) =>
    set((state) => ({ recordedCommands: [...state.recordedCommands, command] })),
  clearRecordedCommands: () => set({ recordedCommands: [] }),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setTheme: (theme) => set({ theme }),

  setLayoutMode: (layoutMode) => {
    set({ layoutMode })
    void get().saveSettings({ layoutMode })
  },

  setGridColumns: (gridColumns) => {
    set({ gridColumns })
    void get().saveSettings({ gridColumns })
  },

  setBroadcastInput: (broadcastInput) => {
    set({ broadcastInput })
    void get().saveSettings({ broadcastInput })
  },

  setPendingForm: (pendingForm) => set({ pendingForm }),
  setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),

  setActiveDialog: (activeDialog) => set({ activeDialog }),

  setSessionPlacement: (sessionPlacement) => set({ sessionPlacement }),
  setDetachedWindow: (isDetachedWindow) => set({ isDetachedWindow }),

  /** Asks the main process which window owns each session. */
  loadSessionPlacement: async () => {
    const { placement } = await invoke<{ placement: Record<string, number> }>('windows:list')
    set({ sessionPlacement: placement })
  },

  detachSessions: async (sessionIds) => {
    await invoke('windows:detach', { sessionIds })
  },

  reattachWindow: async (windowId) => {
    await invoke('windows:reattach', { windowId })
  },

  loadAiSettings: async () => invoke<AiSettings>('ai:get-settings'),
  saveAiSettings: async (settings) => invoke<AiSettings>('ai:save-settings', settings),

  setAiKey: async (provider, apiKey) => {
    await invoke('ai:set-key', { provider, apiKey })
  },

  aiKeyStatus: async () => invoke<Record<string, boolean>>('ai:key-status'),

  askAssistant: async (ask) => {
    await invoke('ai:ask', ask)
  },

  cancelAssistant: async (requestId) => {
    await invoke('ai:cancel', { requestId })
  },

  loadScriptLibrary: async () => {
    const library = await invoke<{ root: string; entries: ScriptEntry[] }>('scripts:list')
    set({ scriptLibrary: library })
  },

  chooseScriptFolder: async () => {
    const result = await invoke<{
      cancelled: boolean
      root?: string
      entries?: ScriptEntry[]
    }>('scripts:choose-folder')

    if (result.cancelled) return false
    set({ scriptLibrary: { root: result.root ?? '', entries: result.entries ?? [] } })
    // The folder is a stored setting, so keep the settings copy in step.
    await get().loadSettings()
    return true
  },

  readScript: async (path) =>
    invoke<{ path: string; content: string; size: number }>('scripts:read', { path }),

  revealScriptFolder: async () => {
    await invoke('scripts:reveal')
  },

  loadGlobalVars: async () => {
    set({ globalVars: await invoke<GlobalVarsState>('globals:get') })
  },

  saveGlobalVars: async (text) => {
    // The main process answers with the file as it now reads, so the editor
    // shows what was actually written rather than what was typed.
    const globalVars = await invoke<GlobalVarsState>('globals:save', { text })
    set({ globalVars })
    return globalVars
  },

  revealGlobalVars: async () => {
    await invoke('globals:reveal')
  },

  runScriptOnSession: async (params) =>
    invoke<{ remotePath: string; command: string }>('scripts:run', params),

  setAssistantTurns: (update) =>
    set((state) => ({
      assistantTurns: typeof update === 'function' ? update(state.assistantTurns) : update,
    })),

  setAssistantInput: (input) => set({ assistantInput: input }),

  setAssistantRequestId: (requestId) => set({ assistantRequestId: requestId }),

  setAssistantPrefill: (assistantPrefill) => set({ assistantPrefill }),

  setScratchpad: (scratchpad) => set({ scratchpad }),

  // ------------------------------------------------------------------- tldr
  setSidePanel: (sidePanel) => set({ sidePanel }),
  setTldrSearchOpen: (tldrSearchOpen) => set({ tldrSearchOpen }),
  setTldrStatus: (tldrStatus) => set({ tldrStatus }),

  loadTldrStatus: async () => {
    try {
      set({ tldrStatus: await invoke<TldrStatus>('tldr:status') })
    } catch {
      // An older main process, or one whose service failed to construct. The
      // panel reads a null status as "documentation unavailable" and says so.
    }
  },

  openTldr: (request) =>
    set({
      // The target is captured now — the pane the command was detected in, or
      // whatever has focus when the request came from a search. Re-reading it
      // later would mean a command built for one box could be sent to whichever
      // tab happened to be in front by the time Run was pressed.
      tldrRequest: {
        command: request.command,
        platform: request.platform,
        exact: request.exact,
        sessionId: request.sessionId ?? get().activeSessionId,
      },
      sidePanel: 'tldr',
      tldrSearchOpen: false,
    }),

  closeTldr: () => set({ tldrRequest: null }),

  tldrLookup: async (command, platform) => {
    try {
      return await invoke<{ found: boolean; platform: TldrPlatform | null }>('tldr:lookup', {
        command,
        platform,
      })
    } catch {
      return { found: false, platform: null }
    }
  },

  tldrSearch: async (query, platform, limit) => {
    try {
      return await invoke<TldrSearchResult[]>('tldr:search', { query, platform, limit })
    } catch {
      return []
    }
  },

  tldrPage: async (command, platform, exact = false) => {
    try {
      return await invoke<TldrPageResult>('tldr:page', { command, platform, exact })
    } catch {
      return { page: null, related: [], platforms: [] }
    }
  },

  tldrUpdate: async () => {
    const status = await invoke<TldrStatus>('tldr:update')
    await get().loadTldrStatus()
    return status
  },

  tldrRebuild: async () => {
    const status = await invoke<TldrStatus>('tldr:rebuild')
    await get().loadTldrStatus()
    return status
  },

  tldrClear: async () => {
    const status = await invoke<TldrStatus>('tldr:clear')
    await get().loadTldrStatus()
    return status
  },

  runTldrCommand: async (sessionId, command, confirmedDestructive = false) =>
    invoke<TldrRunResult>('tldr:run', { sessionId, command, confirmedDestructive }),

  toggleTldrFavourite: async (command) => {
    const current = get().settings.tldrFavourites ?? []
    const tldrFavourites = current.includes(command)
      ? current.filter((entry) => entry !== command)
      : [...current, command]
    await get().saveSettings({ tldrFavourites })
  },

  askAiAbout: (prompt) => set({ assistantPrefill: prompt, sidePanel: 'assistant' }),

  applyAssistantStream: (event) =>
    set((state) => {
      const turns = [...state.assistantTurns]
      const last = turns[turns.length - 1]
      if (!last || last.role !== 'assistant') return state

      if (event.type === 'delta') {
        turns[turns.length - 1] = { ...last, content: last.content + (event.text ?? '') }
      } else if (event.type === 'context') {
        // Arrives before the first token and does not end the turn.
        turns[turns.length - 1] = { ...last, context: event.context }
      } else if (event.type === 'error' || event.type === 'refusal') {
        turns[turns.length - 1] = { ...last, streaming: false, error: event.error }
      } else {
        turns[turns.length - 1] = { ...last, streaming: false }
      }

      const stillRunning = event.type === 'delta' || event.type === 'context'

      return {
        assistantTurns: turns,
        assistantRequestId: stillRunning ? state.assistantRequestId : null,
      }
    }),

  setMacroProgress: (sessionId, progress) =>
    set((state) => ({ macroProgress: { ...state.macroProgress, [sessionId]: progress } })),

  setRunningMacros: (running) => set({ runningMacros: running }),

  loadRunningMacros: async () =>
    set({ runningMacros: await invoke<RunningMacro[]>('macros:running') }),

  setSessionLog: (sessionId, logPath) =>
    set((state) => {
      const sessionLogs = { ...state.sessionLogs }
      if (logPath) {
        sessionLogs[sessionId] = logPath
      } else {
        delete sessionLogs[sessionId]
      }
      return { sessionLogs }
    }),

  // Profiles
  loadProfiles: async () => set({ profiles: await invoke<Profile[]>('profiles:list') }),

  saveProfile: async (profile) => {
    const saved = await invoke<Profile>('profiles:save', profile)
    await get().loadProfiles()
    return saved
  },

  deleteProfile: async (id) => {
    const deleted = await invoke<boolean>('profiles:delete', { id })
    await get().loadProfiles()
    return deleted
  },

  testProfile: async (id) => {
    try {
      return await invoke<{ success: boolean; error?: string }>('profiles:test', { id })
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Test failed' }
    }
  },

  // Sessions
  exportConnections: async (profileIds) =>
    invoke('profiles:export', { profileIds }),

  exportConnectionsForSecureCrt: async (input) => invoke('profiles:export-securecrt', input),

  scanSecureCrt: async () => invoke('profiles:scan-securecrt', {}),

  importSecureCrt: async (folder) => invoke('profiles:import-securecrt', { folder }),

  importConnections: async () => {
    const result = await invoke<{ groups: number; profiles: number; renamed: Array<{ from: string; to: string }> }>('profiles:import')
    await get().loadProfiles()
    await get().loadConnectionGroups()
    return result
  },

  loadConnectionGroups: async () =>
    set({ connectionGroups: await invoke<ConnectionGroup[]>('groups:list') }),

  saveConnectionGroup: async (group) => {
    const saved = await invoke<ConnectionGroup>('groups:save', group)
    await get().loadConnectionGroups()
    return saved
  },

  deleteConnectionGroup: async (id) => {
    const deleted = await invoke<boolean>('groups:delete', { id })
    await get().loadConnectionGroups()
    await get().loadProfiles()
    return deleted
  },

  listSerialPorts: async () => invoke<SerialPortInfo[]>('serial:list-ports'),
  listLocalShells: async () => invoke<LocalShellInfo[]>('local:list-shells'),

  loadSessions: async () => {
    const sessions = await invoke<Session[]>('sessions:list')
    set({ sessions })

    // Keep the active session pointing at something real. Only the main window
    // does this: `sessions` is the global list, so a detached window auto-
    // selecting from it would steal focus onto a pane it does not even render.
    const { activeSessionId, isDetachedWindow } = get()
    if (isDetachedWindow) return
    if (activeSessionId && !sessions.some((s) => s.id === activeSessionId)) {
      set({ activeSessionId: sessions[0]?.id ?? null })
    } else if (!activeSessionId && sessions.length > 0) {
      set({ activeSessionId: sessions[0].id })
    }
  },

  openSession: async (profileId) => {
    const { sessionId } = await invoke<{ sessionId: string }>('sessions:open', { profileId })
    await get().loadSessions()
    set({ activeSessionId: sessionId })
    announceActiveSession(sessionId)
    return sessionId
  },

  openSessions: async (profileIds) => {
    const { opened } = await invoke<{ opened: OpenSessionOutcome[] }>('sessions:open-many', {
      profileIds,
    })
    await get().loadSessions()

    const firstOpened = opened.find((entry) => entry.sessionId)
    if (firstOpened?.sessionId) {
      set({ activeSessionId: firstOpened.sessionId })
      announceActiveSession(firstOpened.sessionId)
    }
    // More than one terminal is far more useful side by side than stacked.
    if (opened.filter((entry) => entry.sessionId).length > 1 && get().layoutMode === 'tabs') {
      get().setLayoutMode('grid')
    }
    return opened
  },

  closeSession: async (sessionId, force = false) => {
    const result = await invoke<{ closed: boolean; blockedBy?: RunningMacro }>('sessions:close', {
      sessionId,
      force,
    })

    // Refused because a macro is running: hand the detail back so the caller
    // can ask, and leave the session and its buffers alone.
    if (result.blockedBy) return result

    get().setSessionLog(sessionId, null)
    // Retained output would otherwise outlive the session it belongs to.
    clearSessionBuffer(sessionId)
    // As would the reconstructed command line, which is the more sensitive of
    // the two — it is a keystroke buffer.
    clearCommandLine(sessionId)
    await get().loadSessions()
    return result
  },

  sendToSession: async (sessionId, text) => {
    const { sent } = await invoke<{ sent: boolean }>('sessions:send', { sessionId, text })
    if (get().isMacroRecording) {
      get().addRecordedCommand(text.trim())
    }
    return sent
  },

  pasteToSession: async (sessionId, text) => {
    const { sent } = await invoke<{ sent: boolean }>('sessions:paste', { sessionId, text })
    return sent
  },

  insertSuggestion: async (sessionId, text) =>
    invoke<{ inserted: boolean; reason?: string; lines: number }>('sessions:insert-suggestion', {
      sessionId,
      text,
    }),

  broadcast: async (text) => {
    const sessionIds = get()
      .sessions.filter((session) => session.status === 'connected')
      .map((session) => session.id)
    if (sessionIds.length === 0) return
    await invoke('sessions:broadcast', { sessionIds, text })
  },

  resizeSession: async (sessionId, cols, rows) => {
    try {
      const { resized } = await invoke<{ resized: boolean }>('sessions:resize', {
        sessionId,
        cols,
        rows,
      })
      return resized
    } catch {
      return false
    }
  },

  // Session logging
  startSessionLog: async (sessionId) => {
    const { path } = await invoke<{ path: string }>('sessions:log-start', { sessionId })
    get().setSessionLog(sessionId, path)
    return path
  },

  stopSessionLog: async (sessionId) => {
    await invoke('sessions:log-stop', { sessionId })
    get().setSessionLog(sessionId, null)
  },

  toggleSessionLog: async (sessionId) => {
    if (get().sessionLogs[sessionId]) {
      await get().stopSessionLog(sessionId)
    } else {
      await get().startSessionLog(sessionId)
    }
  },

  revealSessionLog: async (sessionId) => {
    await invoke('sessions:log-reveal', { sessionId })
  },

  refreshLogStatus: async () => {
    const status = await invoke<Record<string, { path: string }>>('sessions:log-status')
    const sessionLogs: Record<string, string> = {}
    for (const [sessionId, entry] of Object.entries(status)) {
      sessionLogs[sessionId] = entry.path
    }
    set({ sessionLogs })
  },

  // Macros
  loadMacros: async () => set({ macros: await invoke<Macro[]>('macros:list') }),
  loadMacroSets: async () => set({ macroSets: await invoke<MacroSet[]>('macro-sets:list') }),

  saveMacro: async (macro) => {
    const saved = await invoke<Macro>('macros:save', macro)
    await get().loadMacros()
    return saved
  },

  deleteMacro: async (id) => {
    const deleted = await invoke<boolean>('macros:delete', { id })
    await get().loadMacros()
    return deleted
  },

  copyMacro: async (id, targetSetId, name) => {
    const copy = await invoke<Macro>('macros:copy', { id, targetSetId, name })
    await get().loadMacros()
    return copy
  },

  toggleFavourite: async (id) => {
    const result = await invoke<{ favourited: boolean; setId: string }>('macros:toggle-favourite', {
      id,
    })
    // Starring the first button creates the favourites set, so the set list has
    // to be reloaded too or the copy lands somewhere the panel cannot render.
    await get().loadMacroSets()
    await get().loadMacros()
    return result.favourited
  },

  saveMacroSet: async (macroSet) => {
    const saved = await invoke<MacroSet>('macro-sets:save', macroSet)
    await get().loadMacroSets()
    return saved
  },

  deleteMacroSet: async (id) => {
    const deleted = await invoke<boolean>('macro-sets:delete', { id })
    await get().loadMacroSets()
    await get().loadMacros()
    return deleted
  },

  exportMacroSets: async (setIds) =>
    invoke<{ filePath: string; sets: number; macros: number }>('macro-sets:export', { setIds }),

  importMacroSets: async () => {
    const result = await invoke<{
      sets: number
      macros: number
      renamed: Array<{ from: string; to: string }>
      droppedReferences: number
    }>('macro-sets:import')

    await get().loadMacroSets()
    await get().loadMacros()
    return result
  },

  runMacro: async (params) => {
    try {
      return await invoke<{ success: boolean; error?: string }>('macros:run', params)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Run failed' }
    }
  },

  cancelMacro: async (sessionId) => {
    await invoke('macros:cancel', { sessionId })
  },

  resumeMacro: async (sessionId) => {
    await invoke('macros:resume', { sessionId })
  },

  submitMacroForm: async (requestId, values) => {
    await invoke('macros:submit-form', { requestId, values })
    set({ pendingForm: null })
  },

  submitMacroConfirm: async (requestId, confirmed) => {
    await invoke('macros:submit-confirm', { requestId, confirmed })
    set({ pendingConfirm: null })
  },

  // SSH keys
  loadSshKeys: async () => set({ sshKeys: await invoke<SshKey[]>('keys:list') }),

  generateSshKey: async (input) => {
    const key = await invoke<SshKey>('keys:generate', input)
    await get().loadSshKeys()
    return key
  },

  importSshKey: async (input) => {
    const key = await invoke<SshKey>('keys:import', input)
    await get().loadSshKeys()
    return key
  },

  deleteSshKey: async (id) => {
    const deleted = await invoke<boolean>('keys:delete', { id })
    await get().loadSshKeys()
    return deleted
  },

  exportSshKey: async (id) => {
    const { filePath } = await invoke<{ filePath: string }>('keys:export-private', { id })
    return filePath
  },

  deploySshKey: async (input) =>
    invoke<{ status: string; output: string }>('keys:deploy', input),

  // Logs
  loadAuditLogs: async (filter = {}) =>
    set({ auditLogs: await invoke<AuditLog[]>('logs:query', filter) }),

  exportLogs: async (options) => invoke<{ filePath: string }>('logs:export', options),

  // Settings
  loadSettings: async () => {
    const settings = await invoke<Partial<Settings>>('settings:get')
    set({
      settings,
      theme: settings.theme ?? 'dark',
      layoutMode: settings.layoutMode ?? 'tabs',
      gridColumns: settings.gridColumns ?? 0,
      broadcastInput: settings.broadcastInput ?? false,
    })
  },

  saveSettings: async (newSettings) => {
    const settings = await invoke<Partial<Settings>>('settings:save', newSettings)
    set({ settings, theme: settings.theme ?? 'dark' })
  },

  // Secrets
  getSecret: async (service, account) => {
    const { password } = await invoke<{ password: string | null }>('secrets:get', {
      service,
      account,
    })
    return password
  },

  setSecret: async (service, account, password) => {
    await invoke('secrets:set', { service, account, password })
    return true
  },

  deleteSecret: async (service, account) => {
    await invoke('secrets:delete', { service, account })
    return true
  },
}))

export { useStore }
