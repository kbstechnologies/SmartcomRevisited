import { create } from 'zustand'
import { clearSessionBuffer } from '../lib/sessionStream'
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
  ScriptEntry,
} from '@shared/types'
import type { AiSettings, AiAsk, AiStreamEvent, AssistantTurn } from '@shared/ai'
import type { GlobalVar, GlobalVarProblem } from '@shared/global-vars'

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
  importConnections: () => Promise<{ groups: number; profiles: number; renamed: Array<{ from: string; to: string }> }>

  loadConnectionGroups: () => Promise<void>
  saveConnectionGroup: (group: ConnectionGroup) => Promise<ConnectionGroup>
  deleteConnectionGroup: (id: string) => Promise<boolean>

  listSerialPorts: () => Promise<SerialPortInfo[]>

  loadSessions: () => Promise<void>
  openSession: (profileId: string) => Promise<string>
  openSessions: (profileIds: string[]) => Promise<OpenSessionOutcome[]>
  closeSession: (sessionId: string) => Promise<boolean>
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
    bits: number
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

  closeSession: async (sessionId) => {
    const { closed } = await invoke<{ closed: boolean }>('sessions:close', { sessionId })
    get().setSessionLog(sessionId, null)
    // Retained output would otherwise outlive the session it belongs to.
    clearSessionBuffer(sessionId)
    await get().loadSessions()
    return closed
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
