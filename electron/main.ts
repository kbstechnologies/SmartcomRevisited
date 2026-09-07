import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron'
import { basename, join } from 'path'
import { hostname } from 'os'
import { writeFileSync, readFileSync, mkdirSync } from 'fs'
import { stat } from 'fs/promises'
import { keytar, getKeychainManager } from './keychain'
import { DatabaseManager } from './database'
import { SSHManager, buildScriptCommand, type RunningMacro } from './ssh-manager'
import { detectLocalShells } from './local-shells'
import { listLibrary, readScript } from './script-library'
import {
  ensureGlobalsFile,
  globalsFilePath,
  loadGlobals,
  readGlobalsText,
  writeGlobalsText,
} from './global-variables'
import {
  generateKeyPair,
  installPublicKeyOnClient,
  installPublicKeyViaPassword,
  publicKeyFromPrivate,
  writePrivateKeyFile,
} from './key-manager'
import { importInstructions, toSecureCrtCsv } from '../src/shared/securecrt'
import { defaultSessionPaths } from '../src/shared/securecrt-import'
import { readSecureCrtStore } from './securecrt-store'
import type { IpcResponse } from '../src/shared/ipc'
import { IpcRequestSchema } from '../src/shared/ipc'
import type { AuditLog, Settings } from '../src/shared/types'
import {
  ButtonSetBundleSchema,
  ConnectionBundleSchema,
  ProfileSchema,
  interpolate,
} from '../src/shared/types'
import { APP_NAME, REPOSITORY_URL, VAULT_SERVICE } from '../src/shared/constants'
import { UpdateService, packageKind } from './updater'
import { migrateLegacyUserData } from './migrate-legacy-data'
import { WindowManager } from './window-manager'
import { Assistant } from './ai/assistant'
import { listOllamaModels } from './ai/providers'
import { AiSettingsSchema, type AiSettings } from '../src/shared/ai'
import { TldrService, type TldrStatusEvent } from './tldr/tldr-service'
import { DEFAULT_UPDATE_INTERVAL_DAYS } from './tldr/tldr-store'
import { decideTldrRun } from '../src/shared/tldr-run'
import { isTldrPlatform } from '../src/shared/tldr'
import { CloudService } from './cloud/cloud-service'
import { SyncService } from './cloud/sync-service'
import { SftpService } from './sftp/sftp-service'
import type { SftpQueueState } from '../src/shared/sftp'
import {
  CloudSettingsSchema,
  CLOUD_DEFAULT_BASE_URL,
  type CloudState,
  type SyncStatus,
} from '../src/shared/cloud'

/** Must match `server.port` in the vite configs. */
const DEFAULT_DEV_SERVER_URL = 'http://127.0.0.1:5273'

/** Vault account names for a managed key's secrets. */
const keyVaultAccount = (id: string) => `key:${id}:private`
const keyPassphraseAccount = (id: string) => `key:${id}:passphrase`

/** AI provider keys share the same OS-encrypted vault as the SSH secrets. */
const aiKeyAccount = (provider: string) => `ai:${provider}:key`

// Squirrel only exists in Windows installer builds; absence is not an error.
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  if (require('electron-squirrel-startup')) {
    app.quit()
  }
} catch {
  /* not a Squirrel install */
}

class SmartcomRevisitedApp {
  private mainWindow: BrowserWindow | null = null
  private db!: DatabaseManager
  private sshManager!: SSHManager
  private windows!: WindowManager
  private assistant!: Assistant
  private tldr!: TldrService
  private cloud!: CloudService
  private sftp!: SftpService
  private sync!: SyncService
  private syncTimer: NodeJS.Timeout | null = null
  private updates!: UpdateService
  private userMachine: string
  /** Set once the operator has agreed to quit with macros still running. */
  private quitConfirmed = false

  constructor() {
    this.userMachine = `${process.env.USER || process.env.USERNAME || 'user'}@${hostname()}`
    this.setupEventHandlers()
  }

  /**
   * Database and vault both need `app.getPath('userData')`, which is only
   * valid once the app is ready.
   */
  private initServices() {
    // Must run before the database is opened: renaming the product moved the
    // userData directory, and this brings the previous one's contents across.
    const migration = migrateLegacyUserData()
    if (migration.migrated) {
      console.log('Migrated data from the previous app name:')
      migration.details.forEach((line) => console.log(`  ${line}`))
    }

    this.windows = new WindowManager({
      preloadPath: join(__dirname, 'preload.js'),
      devServerUrl: this.resolveDevServerUrl(),
      indexPath: join(__dirname, '../dist/index.html'),
    })

    this.db = new DatabaseManager()

    const settings = this.db.getAllSettings()
    const logDirectory = settings.sessionLogDir || join(app.getPath('userData'), 'session-logs')

    this.sshManager = new SSHManager(logDirectory)
    this.sshManager.configureLogging({
      directory: logDirectory,
      format: settings.sessionLogFormat ?? 'plain',
    })

    // Lets `callMacro` / `callSet` steps resolve their targets.
    this.sshManager.setMacroResolver({
      getMacro: (id) => this.db.getMacro(id),
      listMacrosInSet: (setId) => this.db.listMacrosInSet(setId),
    })

    // Scripts are read from the library folder at send time, so a script edited
    // outside the app ships as edited — no re-import step.
    this.sshManager.setScriptProvider(async (relativePath) => {
      const root = this.scriptLibraryRoot()
      const script = await readScript(root, relativePath)
      return { content: script.content, name: relativePath.split('/').pop() || 'script' }
    })

    // Global variables are read from the file per run, not cached here, so a
    // value edited in another editor is live on the next button press.
    this.sshManager.setGlobalVariableProvider(() => loadGlobals(this.globalsPath()).values)

    // Read per run rather than captured once, so changing the folder in
    // Settings takes effect on the next button press.
    this.sshManager.setTransferDirProvider(() => this.transferRoot())

    this.sshManager.setPrivateKeyProvider(async (keyId) => {
      const privateKey = await keytar.getPassword(VAULT_SERVICE, keyVaultAccount(keyId))
      if (!privateKey) return null
      const passphrase = await keytar.getPassword(VAULT_SERVICE, keyPassphraseAccount(keyId))
      return { privateKey, passphrase: passphrase ?? undefined }
    })

    this.sshManager.on('session-status', (sessionId: string, status: string, error?: string) => {
      this.windows.broadcast('session-status-changed', { sessionId, status, error })
    })

    this.sshManager.on('session-data', (sessionId: string, data: string) => {
      this.windows.broadcast('session-data', { sessionId, data })
    })

    this.sshManager.on('session-log-changed', (sessionId: string, logPath: string | null) => {
      this.windows.broadcast('session-log-changed', { sessionId, logPath })
    })

    this.sshManager.on('macro-progress', (sessionId: string, progress: unknown) => {
      this.windows.broadcast('macro-progress', { sessionId, progress })
    })

    // Every window needs this, not just the one that pressed the button: the
    // busy indicator and the close warning have to be right in a pop-out too.
    this.sshManager.on('macro-running-changed', (running: RunningMacro[]) => {
      this.windows.broadcast('macro-running-changed', { running })
    })

    this.sshManager.on('macro-form-request', (sessionId: string, payload: unknown) => {
      this.windows.broadcast('macro-form-request', { sessionId, ...(payload as object) })
    })

    this.sshManager.on('macro-confirm-request', (sessionId: string, payload: unknown) => {
      this.windows.broadcast('macro-confirm-request', { sessionId, ...(payload as object) })
    })

    this.sshManager.on('session-ready', (sessionId: string) => {
      void this.runStartupMacro(sessionId)
    })

    this.updates = new UpdateService((status) => this.windows.broadcast('update-status', status))

    this.setupAssistant()
    this.setupTldr()
    this.setupCloud()
    this.setupSftp()
  }

  /**
   * The SFTP explorer's queue and its record of open panes.
   *
   * In the main process because a transfer outlives the panel that started it:
   * the explorer can be popped out to another monitor, switched away from or
   * closed while a download runs, and every window has to see the same queue.
   */
  private setupSftp() {
    this.sftp = new SftpService({
      download: (sessionId, remotePath, localPath, onProgress, shouldCancel) =>
        this.sshManager.downloadFile(sessionId, remotePath, localPath, onProgress, {
          // The operator queued this, so a macro cancelled earlier on the same
          // session must not take it down with it.
          honourMacroCancel: false,
          shouldCancel,
        }),
      profileName: (sessionId) =>
        this.sshManager.getSession(sessionId)?.profile.name ?? 'Unknown host',
      log: (event, detail) => console.log(`[sftp] ${event}`, detail ?? ''),
    })

    this.sftp.on('queue-changed', (state: SftpQueueState) => {
      this.windows.broadcast('sftp-queue-changed', state)
    })

    this.sftp.on('panes-changed', (sessionIds: string[]) => {
      this.windows.broadcast('sftp-panes-changed', { sessionIds })
    })
  }

  /**
   * Brings up the optional SmartCom Cloud account.
   *
   * Constructed unconditionally so the IPC handlers always have something to
   * talk to, but it makes no request unless the feature is on — `initialize()`
   * returns immediately when it is off, and every method refuses without
   * touching the network. A build that nobody enables never contacts a
   * SmartCom server.
   *
   * `initialize()` only reads the OS keystore, so an install that opens on a
   * train still shows "signed in" rather than announcing a sign-out it has no
   * evidence for.
   */
  private setupCloud() {
    this.cloud = new CloudService({
      getSettings: () => this.cloudSettings(),
      // Not in SettingsSchema on purpose: the settings form round-trips every
      // field it holds, and a stale form saving a blank id would hand this
      // machine a new identity and burn a slot in the account's device limit.
      getDeviceId: () => (this.db.getSetting('cloudDeviceId' as never) as string | null) || null,
      setDeviceId: (deviceId) => this.db.setSetting('cloudDeviceId' as never, deviceId),
      appVersion: app.getVersion(),
      platform: process.platform,
      defaultDeviceName: hostname(),
      log: (event, detail) => console.log(`[cloud] ${event}`, detail ?? ''),
    })

    this.cloud.on('status', (state: CloudState) => {
      this.windows.broadcast('cloud-status', state)
    })

    // Sync is layered on top and is a separate decision from having an
    // account: signing in for the device list and billing does not imply that
    // this machine's connections should leave it.
    this.sync = new SyncService({
      post: (path, body) => this.cloud.postWithStatus(path, body),
      canReach: () => this.cloud.canReachServer(),
      isEnabled: () =>
        this.cloudSettings().enabled && this.db.getAllSettings().cloudSyncEnabled === true,
      getWorkspaceId: () => (this.db.getSetting('cloudWorkspaceId' as never) as string) || null,
      setWorkspace: (id, name) => {
        this.db.setSetting('cloudWorkspaceId' as never, id)
        this.db.setSetting('cloudWorkspaceName' as never, name)
      },
      // Blank rather than deleted: the settings table has no delete, and a
      // blank reads as null through the getter above.
      forgetWorkspace: () => {
        this.db.setSetting('cloudWorkspaceId' as never, '')
        this.db.setSetting('cloudWorkspaceName' as never, '')
      },
      listLocalChanges: (limit) => this.db.listLocalChanges(limit),
      countLocalChanges: () => this.db.countLocalChanges(),
      markSynced: (entries) => this.db.markSynced(entries),
      applyRemoteChange: (change) => this.db.applyRemoteChange(change),
      getCursor: (workspaceId) => this.db.getSyncCursor(workspaceId),
      setCursor: (workspaceId, cursor) => this.db.setSyncCursor(workspaceId, cursor),
      getLastSyncAt: (workspaceId) => this.db.getLastSyncAt(workspaceId),
      log: (event, detail) => console.log(`[sync] ${event}`, detail ?? ''),
    })

    this.sync.on('status', (status: SyncStatus) => {
      this.windows.broadcast('cloud-sync-status', status)
    })

    void this.cloud.initialize().catch((error) => {
      console.error('[cloud] initialize failed', error)
    })

    this.scheduleSync()
  }

  /**
   * The background sync timer.
   *
   * Deliberately unhurried, and started well after the window is up. Sync is a
   * convenience layered on a terminal: it must never compete with a connection
   * being opened, and an interval short enough to feel "live" would be an
   * interval that wakes a laptop's radio every minute for no benefit.
   */
  private scheduleSync() {
    if (this.syncTimer) clearInterval(this.syncTimer)

    const minutes = this.db.getAllSettings().cloudSyncIntervalMinutes ?? 15
    if (minutes <= 0) return

    this.syncTimer = setInterval(
      () => {
        void this.sync.syncNow()
      },
      minutes * 60_000
    )

    // A first pass once the app has settled, so a machine that was off while
    // another was edited catches up without anybody pressing anything.
    setTimeout(() => void this.sync.syncNow(), 20_000)
  }

  /** The three user-facing settings, normalised into what the service wants. */
  private cloudSettings() {
    const settings = this.db.getAllSettings()

    return CloudSettingsSchema.parse({
      enabled: settings.cloudEnabled ?? false,
      baseUrl: settings.cloudBaseUrl?.trim() || CLOUD_DEFAULT_BASE_URL,
      deviceName: settings.cloudDeviceName ?? '',
    })
  }

  /**
   * Brings up the tldr documentation service.
   *
   * Constructed here but never awaited: `ensureCache` is fired well after the
   * window is up, and its failures are swallowed on purpose. Documentation is
   * a convenience layered on a terminal — no part of this may delay start-up,
   * and no part of it may stop the app if the network is absent, filtered or
   * pointed at an internal mirror that has never heard of GitHub.
   */
  private setupTldr() {
    this.tldr = new TldrService({
      cacheDir: join(app.getPath('userData'), 'tldr'),
      log: (event, detail) => console.log(`[tldr] ${event}`, detail ?? ''),
    })

    this.tldr.on('status', (event: TldrStatusEvent) => {
      this.windows.broadcast('tldr-status', event)
    })

    // Well behind the update check, and behind the first paint: a cold start
    // that has to fetch three megabytes should do it while the operator is
    // already connecting to something.
    setTimeout(() => {
      const settings = this.db.getAllSettings()
      if (settings.tldrEnabled === false) return
      void this.tldr.ensureCache({
        // A missing cache is still fetched with auto-update off; the setting
        // governs *refreshing* a dataset that already works, not having one.
        // An interval no cache can reach expresses that without a second flag.
        intervalDays:
          settings.tldrAutoUpdate === false
            ? Number.MAX_SAFE_INTEGER
            : (settings.tldrUpdateIntervalDays ?? DEFAULT_UPDATE_INTERVAL_DAYS),
        force: false,
      })
    }, 12_000)
  }

  /**
   * Looks for a new release shortly after start-up, once the window is up and
   * the user is not waiting on anything. Silent by design: the result appears
   * in About and the status bar rather than in a modal. Off when the user has
   * turned automatic checks off.
   */
  private scheduleUpdateCheck() {
    const settings = this.db.getAllSettings()
    if (settings.autoUpdateCheck === false) return
    if (packageKind() === 'dev') return

    setTimeout(() => {
      void this.updates.check({ download: settings.autoUpdateDownload !== false })
    }, 8_000)
  }

  /**
   * Wires the assistant to the live session state so its answers are grounded
   * in this box rather than in general knowledge about the platform.
   */
  private setupAssistant() {
    this.assistant = new Assistant()

    this.assistant.setContextProvider((sessionId) => {
      const session = this.sshManager.getSession(sessionId)
      if (!session) return null

      const macroSets = this.db.listMacroSets()

      return {
        profile: session.profile,
        recentOutput: this.sshManager.getTranscript(sessionId),
        // Commands that already succeeded here are stronger evidence of the
        // platform than anything the model recalls about the vendor.
        recentCommands: this.db
          .queryLogs({ profileId: session.profile.id, result: 'success' })
          .flatMap((entry) => entry.commands)
          .filter(Boolean),
        availableButtons: this.db.listMacros().map((macro) => ({
          set: macroSets.find((set) => set.id === macro.setId)?.name ?? '?',
          name: macro.name,
          description: macro.description,
        })),
      }
    })

    this.assistant.on('stream', (event: unknown) => {
      this.windows.broadcast('ai-stream', event)
    })
  }

  /** Configured script library folder, or '' when the user has not set one. */
  private scriptLibraryRoot(): string {
    return (this.db.getAllSettings().scriptLibraryDir as string) || ''
  }

  /**
   * Folder that `upload` and `download` steps are confined to.
   *
   * Unlike the script library this always resolves to something: a transfer
   * button that failed because no folder was configured would be a poor first
   * experience, and the default sits in the app's own data directory where
   * nothing sensitive lives. The confinement is the security property — see
   * file-transfer.ts — so it must never fall back to "anywhere".
   */
  private transferRoot(): string {
    const configured = (this.db.getAllSettings().transferDir as string) || ''
    const root = configured || join(app.getPath('userData'), 'transfers')
    mkdirSync(root, { recursive: true })
    return root
  }

  /**
   * The global variables file. It lives in userData beside the database rather
   * than in the install directory so it survives an upgrade and is the user's
   * to edit, back up or keep in sync themselves.
   */
  private globalsPath(): string {
    return globalsFilePath(app.getPath('userData'))
  }

  private aiSettings(): AiSettings {
    const stored = this.db.getSetting('assistant' as never)
    return AiSettingsSchema.parse(stored ?? {})
  }

  /** Runs a profile's attached startup script once its shell is ready. */
  private async runStartupMacro(sessionId: string) {
    const session = this.sshManager.getSession(sessionId)
    if (!session?.profile.startupMacroId) return

    const macro = this.db.getMacro(session.profile.startupMacroId)
    if (!macro) return

    const result = await this.sshManager.runMacro(sessionId, macro, {})

    this.logAudit({
      userMachine: this.userMachine,
      sessionId,
      profileId: session.profile.id!,
      macroId: macro.id,
      macroName: `${macro.name} (startup)`,
      commands: result.commands,
      result: result.success ? 'success' : 'error',
      stderrSnippet: result.error,
    })

    if (!result.error) return
    this.windows.broadcast('session-data', {
      sessionId,
      data: `\r\n\x1b[33m[startup script] ${result.error}\x1b[0m\r\n`,
    })
  }

  private setupEventHandlers() {
    app.on('ready', () => {
      this.initServices()
      this.setupIpcHandlers()
      this.createWindow()
      this.scheduleUpdateCheck()
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createWindow()
      }
    })
    app.on('before-quit', (event) => {
      // Asked once and then allowed through: `app.quit()` fires this again, and
      // without the flag the dialog would reappear forever.
      if (!this.quitConfirmed) {
        const running = this.sshManager?.listRunningMacros() ?? []
        if (running.length > 0) {
          event.preventDefault()
          void this.confirmQuitWhileRunning(running)
          return
        }
      }

      this.assistant?.cancelAll()
      this.windows?.closeAll()
      this.sshManager?.shutdown()
      this.db?.close()
    })
  }

  /**
   * Unpackaged always means "dev": load the vite server rather than the built
   * bundle, otherwise a stale dist/ silently masks the code being edited.
   */
  /**
   * Refuses to add a key under a name already in use.
   *
   * Nothing here overwrites silently — `saveSshKey` mints a fresh id, so a
   * duplicate name would create a *second* key rather than replace the first —
   * but two keys called "prod-admin" are indistinguishable in every picker that
   * shows a name, and picking the wrong one fails authentication somewhere
   * inconvenient. Refusing outright is the only outcome that cannot lose a key
   * the user still needs; deleting the old one stays a deliberate act.
   */
  /**
   * Asks before quitting with macros in flight.
   *
   * Deliberately specific about what is and is not lost. Quitting kills the
   * *macro*, not the work it started: a capture running on the far end carries
   * on quite happily, and what actually disappears is the rest of the script —
   * the wait, and whatever it was going to do with the result. Saying "a macro
   * is running" would leave the operator guessing which of those it meant.
   */
  private async confirmQuitWhileRunning(running: RunningMacro[]): Promise<void> {
    const list = running
      .map((item) => `  • ${item.macroName} — ${item.profileName}`)
      .join('\n')

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Quit anyway', 'Keep running'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Buttons still running',
      message:
        running.length === 1
          ? 'A button is still running.'
          : `${running.length} buttons are still running.`,
      detail:
        `${list}\n\n` +
        'Quitting stops the remaining steps. Anything already started on the ' +
        'host keeps running there — a capture will carry on — but the steps ' +
        'that were going to wait for it, collect files or clean up will not happen.',
    })

    if (response === 0) {
      this.quitConfirmed = true
      app.quit()
    }
  }

  /**
   * Asks for the SecureCRT session folder, starting where it usually lives.
   *
   * The default path matters more than it looks: `%APPDATA%\VanDyke\Config\
   * Sessions` is not somewhere anyone navigates to from memory, and an import
   * that opens on the desktop is one most people abandon.
   */
  private async pickSecureCrtFolder(): Promise<string | null> {
    const [suggested] = defaultSessionPaths(
      process.platform,
      app.getPath('home'),
      process.env.APPDATA
    )

    const exists = await stat(suggested)
      .then(() => true)
      .catch(() => false)

    const result = await dialog.showOpenDialog(this.mainWindow!, {
      title: 'Choose the SecureCRT Sessions folder',
      defaultPath: exists ? suggested : app.getPath('home'),
      properties: ['openDirectory'],
      message: 'Usually Config\\Sessions inside the VanDyke folder',
    })

    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }

  private assertKeyNameFree(name: string): void {
    const clash = this.db.listSshKeys().find((key) => key.name === name.trim())
    if (clash) {
      throw new Error(
        `A key named "${clash.name}" already exists (${clash.type}, ${clash.fingerprint}). ` +
          'Choose another name, or delete that key first.'
      )
    }
  }

  private resolveDevServerUrl(): string | undefined {
    if (app.isPackaged) return undefined
    return (
      (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined'
        ? MAIN_WINDOW_VITE_DEV_SERVER_URL
        : process.env.VITE_DEV_SERVER_URL) || DEFAULT_DEV_SERVER_URL
    )
  }

  private async createWindow() {
    this.mainWindow = new BrowserWindow({
      height: 800,
      width: 1200,
      minWidth: 800,
      minHeight: 600,
      backgroundColor: '#111827',
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
      show: false,
    })

    this.windows.setMainWindow(this.mainWindow)

    const devServerUrl = this.resolveDevServerUrl()

    if (devServerUrl) {
      try {
        await this.mainWindow.loadURL(devServerUrl)
        this.mainWindow.webContents.openDevTools({ mode: 'detach' })
      } catch (error) {
        // Better a visible message than a blank window.
        console.error(`Dev server not reachable at ${devServerUrl}:`, error)
        await this.mainWindow.loadURL(
          'data:text/html,' +
            encodeURIComponent(
              `<body style="font:14px system-ui;background:#111827;color:#e5e7eb;padding:2rem">
                 <h2>Dev server not reachable</h2>
                 <p>Expected Vite at <code>${devServerUrl}</code>.</p>
                 <p>Run <code>npm run dev</code>, or <code>npm run build &amp;&amp; npx electron .</code>
                    to run against the built bundle.</p>
               </body>`
            )
        )
      }
    } else {
      await this.mainWindow.loadFile(join(__dirname, '../dist/index.html'))
    }

    this.mainWindow.once('ready-to-show', () => this.mainWindow?.show())

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  private logAudit(entry: Omit<AuditLog, 'id' | 'timestamp'>) {
    try {
      this.db.logAudit(entry)
    } catch (error) {
      console.error('Failed to write audit log:', error)
    }
  }

  private setupIpcHandlers() {
    ipcMain.handle('ipc-request', async (_event, rawRequest): Promise<IpcResponse> => {
      try {
        const request = IpcRequestSchema.parse(rawRequest)

        switch (request.channel) {
          // ---------------------------------------------------------- profiles
          case 'profiles:list':
            return { success: true, data: this.db.listProfiles() }

          case 'profiles:get':
            return { success: true, data: this.db.getProfile(request.data.id) }

          case 'profiles:save':
            return { success: true, data: this.db.saveProfile(request.data) }

          case 'profiles:delete': {
            await getKeychainManager().deleteAllForAccount(`${request.data.id}:`)
            return { success: true, data: this.db.deleteProfile(request.data.id) }
          }

          case 'profiles:test': {
            const profile = this.db.getProfile(request.data.id)
            if (!profile) return { success: false, error: 'Profile not found' }
            return { success: true, data: await this.sshManager.testConnection(profile) }
          }

          case 'profiles:scan-securecrt': {
            const folder = request.data.folder || (await this.pickSecureCrtFolder())
            if (!folder) return { success: false, error: 'Import cancelled' }

            const plan = await readSecureCrtStore(folder)
            return { success: true, data: { folder, ...plan } }
          }

          case 'profiles:import-securecrt': {
            const plan = await readSecureCrtStore(request.data.folder)

            // Folders are created first so the connections can point at them,
            // and reused by name — importing twice must not leave two "Core"
            // groups with half the hosts in each.
            const groupIds = new Map<string, string>()
            for (const group of this.db.listConnectionGroups()) {
              groupIds.set(group.name, group.id!)
            }

            let imported = 0
            const renamed: Array<{ from: string; to: string }> = []
            const existingNames = new Set(this.db.listProfiles().map((p) => p.name))

            for (const candidate of plan.candidates) {
              let groupId: string | undefined
              if (candidate.group) {
                if (!groupIds.has(candidate.group)) {
                  const created = this.db.saveConnectionGroup({
                    name: candidate.group,
                    sortOrder: 0,
                  } as never)
                  groupIds.set(candidate.group, created.id!)
                }
                groupId = groupIds.get(candidate.group)
              }

              // Connection names are unique in the database, so a clash has to
              // be resolved rather than allowed to fail the whole import.
              let name = candidate.name
              if (existingNames.has(name)) {
                let counter = 2
                while (existingNames.has(`${candidate.name} (${counter})`)) counter++
                name = `${candidate.name} (${counter})`
                renamed.push({ from: candidate.name, to: name })
              }
              existingNames.add(name)

              this.db.saveProfile(
                ProfileSchema.parse({
                  name,
                  groupId,
                  transport: candidate.transport,
                  host: candidate.host ?? '',
                  port: candidate.port ?? 22,
                  // The schema requires a username for SSH; SecureCRT often has
                  // none because the operator types it at connect time.
                  username: candidate.username || 'root',
                  authMethod: 'password',
                  serialPath: candidate.serialPath,
                  baudRate: candidate.baudRate ?? 115200,
                })
              )
              imported++
            }

            return {
              success: true,
              data: {
                imported,
                renamed,
                skipped: plan.skipped,
                unsupported: plan.unsupported,
              },
            }
          }

          case 'profiles:export-securecrt': {
            // Saved connections only — buttons, audit history, logs, globals and
            // assistant settings have no SecureCRT equivalent and are not tried.
            const bundle = this.db.exportConnections(request.data.profileIds)
            if (bundle.profiles.length === 0) {
              return { success: false, error: 'No connections to export' }
            }

            const { csv, summary } = toSecureCrtCsv(bundle.profiles, bundle.groups, {
              includeUsernames: request.data.includeUsernames,
            })

            if (summary.exported === 0) {
              return {
                success: false,
                error:
                  'None of the selected connections can be imported by SecureCRT. ' +
                  `${summary.unsupported.length} unsupported, ${summary.skipped.length} incomplete.`,
              }
            }

            const stamp = new Date().toISOString().split('T')[0]
            const result = await dialog.showSaveDialog(this.mainWindow!, {
              title: 'Export connections for SecureCRT',
              defaultPath: `smartcom-connections-${stamp}.csv`,
              filters: [{ name: 'CSV', extensions: ['csv'] }],
            })
            if (result.canceled || !result.filePath) {
              return { success: false, error: 'Export cancelled' }
            }

            writeFileSync(result.filePath, csv, 'utf8')

            // The instructions sit beside the file because an export is often
            // carried to another machine and imported days later by someone
            // else, who will not have seen whatever the UI said at the time.
            const readmePath = result.filePath.replace(/\.csv$/i, '') + '-README.txt'
            writeFileSync(
              readmePath,
              importInstructions(summary, basename(result.filePath)),
              'utf8'
            )

            return {
              success: true,
              data: { filePath: result.filePath, readmePath, ...summary },
            }
          }

          case 'profiles:export': {
            const bundle = this.db.exportConnections(request.data.profileIds)
            if (bundle.profiles.length === 0) {
              return { success: false, error: 'No connections to export' }
            }

            const result = await dialog.showSaveDialog(this.mainWindow!, {
              title: 'Export connections',
              defaultPath: `connections-${new Date().toISOString().split('T')[0]}.connections.json`,
              filters: [{ name: 'Connections', extensions: ['json'] }],
            })
            if (result.canceled || !result.filePath) {
              return { success: false, error: 'Export cancelled' }
            }

            writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf8')
            return {
              success: true,
              data: {
                filePath: result.filePath,
                profiles: bundle.profiles.length,
                groups: bundle.groups.length,
              },
            }
          }

          case 'profiles:import': {
            const result = await dialog.showOpenDialog(this.mainWindow!, {
              title: 'Import connections',
              properties: ['openFile'],
              filters: [{ name: 'Connections', extensions: ['json'] }],
            })
            if (result.canceled || result.filePaths.length === 0) {
              return { success: false, error: 'Import cancelled' }
            }

            let bundle
            try {
              bundle = ConnectionBundleSchema.parse(
                JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
              )
            } catch (parseError) {
              return {
                success: false,
                error: `Not a valid connections file: ${
                  parseError instanceof Error ? parseError.message.split('\n')[0] : parseError
                }`,
              }
            }

            const imported = this.db.importConnections(bundle)
            return { success: true, data: { ...imported, filePath: result.filePaths[0] } }
          }

          // ---------------------------------------------------- connection groups
          case 'groups:list':
            return { success: true, data: this.db.listConnectionGroups() }

          case 'groups:save':
            return { success: true, data: this.db.saveConnectionGroup(request.data) }

          case 'groups:delete':
            return { success: true, data: this.db.deleteConnectionGroup(request.data.id) }

          // ----------------------------------------------------------- serial
          case 'serial:list-ports': {
            try {
              const { SerialPort } = await import('serialport')
              const ports = await SerialPort.list()
              return {
                success: true,
                data: ports.map((port) => ({
                  path: port.path,
                  manufacturer: port.manufacturer,
                  serialNumber: port.serialNumber,
                  friendlyName: (port as { friendlyName?: string }).friendlyName,
                  productId: port.productId,
                  vendorId: port.vendorId,
                })),
              }
            } catch (error) {
              return {
                success: false,
                error: `Could not enumerate serial ports: ${
                  error instanceof Error ? error.message : error
                }`,
              }
            }
          }

          // ----------------------------------------------------- local shells
          case 'local:list-shells': {
            try {
              return { success: true, data: await detectLocalShells() }
            } catch (error) {
              return {
                success: false,
                error: `Could not list local shells: ${
                  error instanceof Error ? error.message : error
                }`,
              }
            }
          }

          // ---------------------------------------------------------- sessions
          case 'sessions:list':
            return { success: true, data: this.sshManager.listSessions() }

          case 'sessions:open': {
            const profile = this.db.getProfile(request.data.profileId)
            if (!profile) return { success: false, error: 'Profile not found' }

            const settings = this.db.getAllSettings()
            const sessionId = await this.sshManager.createSession(profile, {
              autoLog: settings.autoStartSessionLog ?? false,
            })
            return { success: true, data: { sessionId } }
          }

          case 'sessions:open-many': {
            const settings = this.db.getAllSettings()
            const autoLog = settings.autoStartSessionLog ?? false

            // Opened concurrently so a slow host does not hold up the rest;
            // each entry reports its own outcome.
            const opened = await Promise.all(
              request.data.profileIds.map(async (profileId) => {
                const profile = this.db.getProfile(profileId)
                if (!profile) {
                  return { profileId, error: 'Profile not found' as const }
                }
                try {
                  const sessionId = await this.sshManager.createSession(profile, { autoLog })
                  return { profileId, sessionId, profileName: profile.name }
                } catch (error) {
                  return {
                    profileId,
                    profileName: profile.name,
                    error: error instanceof Error ? error.message : 'Failed to open session',
                  }
                }
              })
            )

            return { success: true, data: { opened } }
          }

          case 'sessions:close': {
            const { sessionId, force } = request.data

            // Closing kills the shell the macro is writing into, so the run
            // dies with it. Refuse and report rather than asking here: a dialog
            // raised from the main process would block every window, and the
            // renderer can say what is being lost in its own words.
            // Refusal is a result, not an error: the renderer's `invoke` throws
            // on `success: false` and drops the payload, so reporting it that
            // way would lose the very detail the warning needs to be specific.
            const busy = this.sshManager.listRunningMacros().find((m) => m.sessionId === sessionId)
            if (busy && !force) {
              return { success: true, data: { closed: false, blockedBy: busy } }
            }

            const closed = this.sshManager.closeSession(sessionId)
            this.windows.forgetSession(sessionId)
            // The explorer pane goes with the session, and anything still
            // queued for it is cancelled: those transfers cannot succeed, and
            // a queue full of items that will never move is worse than none.
            this.sftp.forgetSession(sessionId)
            return { success: true, data: { closed } }
          }

          case 'macros:running':
            return { success: true, data: this.sshManager.listRunningMacros() }

          case 'sessions:scrollback':
            return {
              success: true,
              data: { data: this.sshManager.getScrollback(request.data.sessionId) },
            }

          case 'sessions:send': {
            const sent = this.sshManager.sendToSession(request.data.sessionId, request.data.text)
            return { success: true, data: { sent } }
          }

          case 'sessions:paste': {
            const sent = this.sshManager.pasteToSession(request.data.sessionId, request.data.text)
            return { success: true, data: { sent } }
          }

          case 'sessions:insert-suggestion':
            return {
              success: true,
              data: this.sshManager.insertSuggestion(request.data.sessionId, request.data.text),
            }

          case 'sessions:broadcast': {
            const results = request.data.sessionIds.map((id) => ({
              sessionId: id,
              sent: this.sshManager.sendToSession(id, request.data.text),
            }))
            return { success: true, data: { results } }
          }

          case 'sessions:resize':
            return {
              success: true,
              data: {
                resized: this.sshManager.resizeSession(
                  request.data.sessionId,
                  request.data.cols,
                  request.data.rows
                ),
              },
            }

          /**
           * Fetches one file from the host, for the operator.
           *
           * Deliberately not confined to the transfer folder, unlike the
           * `download` macro step. That confinement exists because a button
           * from the exchange supplies its own paths and could write anywhere;
           * here the remote path is typed by the person at the keyboard and the
           * destination is chosen in the operating system's own save dialog.
           * Both ends are a deliberate choice made in the moment, which is the
           * same trust model as any browser download — and confining it would
           * make the feature useless for its actual purpose, which is getting a
           * capture or a config off a device and into wherever the work is.
           */
          case 'sessions:download-file': {
            const { sessionId, remotePath } = request.data
            const session = this.sshManager.getSession(sessionId)

            if (!session) return { success: false, error: 'Session not found' }

            // Trailing slashes and stray whitespace are the two things people
            // paste in from a terminal; neither is a path SFTP will stat.
            const remote = remotePath.trim().replace(/\/+$/, '')
            if (!remote) return { success: false, error: 'Enter the path of the file to download.' }

            // Ask the host about the file *before* asking where to put it.
            // Choosing a destination and only then being told the path was
            // wrong is a pointless round of a file dialog, and it is the
            // mistake people make most — a typo, or a path copied with the
            // prompt still attached.
            try {
              const stats = await this.sshManager.statRemoteFile(sessionId, remote)

              if (stats.isDirectory) {
                return {
                  success: false,
                  error: `${remote} is a folder. Downloads take one file at a time.`,
                }
              }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }

            const suggested = remote.split('/').pop() || 'download'

            const target = await dialog.showSaveDialog(this.mainWindow!, {
              title: `Save ${suggested} from ${session.profile.name}`,
              defaultPath: join(app.getPath('downloads'), suggested),
            })

            if (target.canceled || !target.filePath) {
              return { success: false, error: 'Download cancelled' }
            }

            // `fastGet` reports every chunk, which for a hundred-megabyte
            // capture is thousands of callbacks. Throttled to something a
            // progress bar can actually use — the renderer cannot paint faster
            // than this anyway, and flooding IPC to say "0.03% more" competes
            // with the terminal for the same thread.
            let lastReport = 0

            try {
              const { bytes } = await this.sshManager.downloadFile(
                sessionId,
                remote,
                target.filePath,
                (transferred, total) => {
                  const now = Date.now()
                  if (transferred < total && now - lastReport < 100) return
                  lastReport = now

                  this.windows.broadcast('file-transfer-progress', {
                    sessionId,
                    remotePath: remote,
                    transferred,
                    total,
                  })
                },
                // The operator started this, so a macro cancelled earlier on
                // this session must not abort it.
                { honourMacroCancel: false }
              )

              // Auditable like anything else that touched the device. The path
              // is recorded, never the contents.
              this.logAudit({
                userMachine: this.userMachine,
                sessionId,
                profileId: session.profile.id!,
                macroName: 'File download',
                commands: [`sftp get ${remote} -> ${target.filePath}`],
                result: 'success',
              })

              return {
                success: true,
                data: { bytes, localPath: target.filePath, remotePath: remote },
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)

              this.logAudit({
                userMachine: this.userMachine,
                sessionId,
                profileId: session.profile.id!,
                macroName: 'File download',
                commands: [`sftp get ${remote}`],
                result: 'error',
                stderrSnippet: message,
              })

              return { success: false, error: message }
            }
          }

          // ---------------------------------------------------- SFTP explorer
          case 'sftp:list': {
            try {
              return {
                success: true,
                data: await this.sshManager.listRemoteDirectory(
                  request.data.sessionId,
                  request.data.path
                ),
              }
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }
            }
          }

          case 'sftp:panes':
            return { success: true, data: { sessionIds: this.sftp.listPanes() } }

          case 'sftp:open-pane':
            return {
              success: true,
              data: { sessionIds: this.sftp.openPane(request.data.sessionId) },
            }

          case 'sftp:close-pane':
            return {
              success: true,
              data: { sessionIds: this.sftp.closePane(request.data.sessionId) },
            }

          case 'sftp:enqueue': {
            const { sessionId, files } = request.data
            const session = this.sshManager.getSession(sessionId)

            if (!session) return { success: false, error: 'Session not found' }

            // The destination is chosen once, in the system's own picker.
            // Prompting per file is unusable for a queue, and confining it to
            // the transfer folder would defeat the point of a file browser —
            // this is the operator downloading, not a shared button writing.
            const chosen = await dialog.showOpenDialog(this.mainWindow!, {
              title: `Save ${files.length} file${files.length === 1 ? '' : 's'} from ${session.profile.name}`,
              defaultPath: app.getPath('downloads'),
              properties: ['openDirectory', 'createDirectory'],
              buttonLabel: 'Save here',
            })

            if (chosen.canceled || !chosen.filePaths[0]) {
              return { success: false, error: 'Download cancelled' }
            }

            const ids = this.sftp.enqueue(sessionId, chosen.filePaths[0], files)

            this.logAudit({
              userMachine: this.userMachine,
              sessionId,
              profileId: session.profile.id!,
              macroName: 'File download',
              commands: files.map((file) => `sftp get ${file.remotePath}`),
              result: 'success',
            })

            return { success: true, data: { queued: ids.length, directory: chosen.filePaths[0] } }
          }

          case 'sftp:queue':
            return { success: true, data: this.sftp.getQueue() }

          case 'sftp:cancel':
            this.sftp.cancel(request.data.transferId)
            return { success: true, data: this.sftp.getQueue() }

          case 'sftp:cancel-all':
            this.sftp.cancelAll()
            return { success: true, data: this.sftp.getQueue() }

          case 'sftp:clear-finished':
            this.sftp.clearFinished()
            return { success: true, data: this.sftp.getQueue() }

          case 'sftp:retry':
            this.sftp.retry(request.data.transferId)
            return { success: true, data: this.sftp.getQueue() }

          case 'sftp:reveal': {
            const transfer = this.sftp
              .getQueue()
              .transfers.find((item) => item.id === request.data.transferId)

            if (!transfer || transfer.status !== 'done') {
              return { success: false, error: 'That download has not finished.' }
            }

            shell.showItemInFolder(transfer.localPath)
            return { success: true, data: { revealed: true } }
          }

          // --------------------------------------------------- session logging
          case 'sessions:log-start': {
            const settings = this.db.getAllSettings()
            const started = this.sshManager.startLogging(
              request.data.sessionId,
              request.data.filePath,
              request.data.format ?? settings.sessionLogFormat ?? 'plain'
            )
            return { success: true, data: started }
          }

          case 'sessions:log-stop':
            return {
              success: true,
              data: { stopped: this.sshManager.stopLogging(request.data.sessionId) },
            }

          case 'sessions:log-status':
            return { success: true, data: this.sshManager.getLogStatus() }

          case 'sessions:log-reveal': {
            const status = this.sshManager.getLogStatus()[request.data.sessionId]
            if (!status) return { success: false, error: 'No active log for this session' }
            shell.showItemInFolder(status.path)
            return { success: true, data: { path: status.path } }
          }

          // ------------------------------------------------------------ macros
          case 'macros:list':
            return { success: true, data: this.db.listMacros() }

          case 'macros:get':
            return { success: true, data: this.db.getMacro(request.data.id) }

          case 'macros:save':
            return { success: true, data: this.db.saveMacro(request.data) }

          case 'macros:delete':
            return { success: true, data: this.db.deleteMacro(request.data.id) }

          case 'macros:copy':
            return {
              success: true,
              data: this.db.copyMacro(request.data.id, request.data.targetSetId, request.data.name),
            }

          case 'macros:toggle-favourite':
            return { success: true, data: this.db.toggleFavourite(request.data.id) }

          case 'macros:cancel':
            this.sshManager.cancelMacro(request.data.sessionId)
            return { success: true, data: { cancelled: true } }

          case 'macros:resume':
            return {
              success: true,
              data: { resumed: this.sshManager.resumeMacro(request.data.sessionId) },
            }

          case 'macros:submit-form':
            return {
              success: true,
              data: {
                delivered: this.sshManager.submitMacroForm(
                  request.data.requestId,
                  request.data.values
                ),
              },
            }

          case 'scripts:list': {
            const root = this.scriptLibraryRoot()
            return { success: true, data: { root, entries: await listLibrary(root) } }
          }

          case 'scripts:read':
            return {
              success: true,
              data: await readScript(this.scriptLibraryRoot(), request.data.path),
            }

          case 'scripts:choose-folder': {
            const result = await dialog.showOpenDialog({
              title: 'Choose the folder holding your scripts',
              properties: ['openDirectory', 'createDirectory'],
              defaultPath: this.scriptLibraryRoot() || undefined,
            })
            if (result.canceled || !result.filePaths[0]) {
              return { success: true, data: { cancelled: true } }
            }

            const chosen = result.filePaths[0]
            this.db.setSetting('scriptLibraryDir' as keyof Settings, chosen)
            return {
              success: true,
              data: { cancelled: false, root: chosen, entries: await listLibrary(chosen) },
            }
          }

          case 'scripts:reveal': {
            const root = this.scriptLibraryRoot()
            if (root) await shell.openPath(root)
            return { success: true, data: { revealed: Boolean(root) } }
          }

          case 'scripts:run': {
            // Globals apply here too, so `--log {{KBSTECHLOG}}` in the arguments
            // box behaves the same as it does inside a button.
            const globals = loadGlobals(this.globalsPath()).values

            const { remotePath, name } = await this.sshManager.stageScript(
              request.data.sessionId,
              request.data.path,
              interpolate(request.data.remoteDir || '/tmp', globals)
            )

            const line = buildScriptCommand({
              remotePath,
              interpreter: interpolate(request.data.interpreter ?? '', globals) || undefined,
              args: interpolate(request.data.args ?? '', globals) || undefined,
              cleanup: request.data.cleanup,
            })

            await this.sshManager.sendToSession(request.data.sessionId, `${line}\n`)
            return { success: true, data: { remotePath, name, command: line } }
          }

          // -------------------------------------------------- global variables
          case 'globals:get': {
            const filePath = this.globalsPath()
            const text = readGlobalsText(filePath)
            const parsed = loadGlobals(filePath)
            return {
              success: true,
              data: { path: filePath, text, vars: parsed.vars, problems: parsed.problems },
            }
          }

          case 'globals:save': {
            const filePath = this.globalsPath()
            writeGlobalsText(filePath, request.data.text)

            const parsed = loadGlobals(filePath)
            return {
              success: true,
              data: {
                path: filePath,
                text: readGlobalsText(filePath),
                vars: parsed.vars,
                problems: parsed.problems,
              },
            }
          }

          case 'globals:reveal': {
            // Created first: opening a path that does not exist yet just fails
            // silently, which reads as the button doing nothing.
            const filePath = ensureGlobalsFile(this.globalsPath())
            await shell.openPath(filePath)
            return { success: true, data: { path: filePath } }
          }

          case 'macros:submit-confirm':
            return {
              success: true,
              data: {
                delivered: this.sshManager.submitMacroConfirm(
                  request.data.requestId,
                  request.data.confirmed
                ),
              },
            }

          case 'macros:run': {
            const { macroId, sessionId, variables } = request.data
            const macro = this.db.getMacro(macroId)
            const session = this.sshManager.getSession(sessionId)

            if (!macro) return { success: false, error: 'Macro not found' }
            if (!session) return { success: false, error: 'Session not found' }

            const result = await this.sshManager.runMacro(sessionId, macro, variables)

            this.logAudit({
              userMachine: this.userMachine,
              sessionId,
              profileId: session.profile.id!,
              macroId: macro.id,
              macroName: macro.name,
              // Commands actually issued, including those from called sets.
              commands: result.commands,
              result: result.success ? 'success' : 'error',
              stderrSnippet: result.error,
            })

            return { success: true, data: result }
          }

          // -------------------------------------------------------- macro sets
          case 'macro-sets:list':
            return { success: true, data: this.db.listMacroSets() }

          case 'macro-sets:save':
            return { success: true, data: this.db.saveMacroSet(request.data) }

          case 'macro-sets:delete':
            return { success: true, data: this.db.deleteMacroSet(request.data.id) }

          case 'macro-sets:export': {
            const bundle = this.db.exportMacroSets(request.data.setIds)
            if (bundle.sets.length === 0) {
              return { success: false, error: 'No matching button sets to export' }
            }

            const suggested =
              bundle.sets.length === 1
                ? `${bundle.sets[0].name.replace(/[^\w.-]+/g, '_')}.buttons.json`
                : `button-sets-${new Date().toISOString().split('T')[0]}.buttons.json`

            const result = await dialog.showSaveDialog(this.mainWindow!, {
              title: 'Export button sets',
              defaultPath: suggested,
              filters: [{ name: 'Button set', extensions: ['json'] }],
            })
            if (result.canceled || !result.filePath) {
              return { success: false, error: 'Export cancelled' }
            }

            writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), 'utf8')
            return {
              success: true,
              data: {
                filePath: result.filePath,
                sets: bundle.sets.length,
                macros: bundle.macros.length,
              },
            }
          }

          case 'macro-sets:import': {
            const result = await dialog.showOpenDialog(this.mainWindow!, {
              title: 'Import button sets',
              properties: ['openFile'],
              filters: [{ name: 'Button set', extensions: ['json'] }],
            })
            if (result.canceled || result.filePaths.length === 0) {
              return { success: false, error: 'Import cancelled' }
            }

            let bundle
            try {
              bundle = ButtonSetBundleSchema.parse(
                JSON.parse(readFileSync(result.filePaths[0], 'utf8'))
              )
            } catch (parseError) {
              // A clear message beats a raw zod dump for a hand-edited file.
              return {
                success: false,
                error: `Not a valid button set file: ${
                  parseError instanceof Error ? parseError.message.split('\n')[0] : parseError
                }`,
              }
            }

            const imported = this.db.importMacroSets(bundle)
            return { success: true, data: { ...imported, filePath: result.filePaths[0] } }
          }

          // -------------------------------------------------------- audit logs
          case 'logs:query':
            return { success: true, data: this.db.queryLogs(request.data) }

          case 'logs:export': {
            const rows = this.db.queryLogs(request.data.filters)
            const result = await dialog.showSaveDialog(this.mainWindow!, {
              defaultPath: `smartcom-revisited-logs-${new Date().toISOString().split('T')[0]}.${request.data.format}`,
              filters: [
                {
                  name: request.data.format.toUpperCase(),
                  extensions: [request.data.format],
                },
              ],
            })

            if (result.canceled || !result.filePath) {
              return { success: false, error: 'Export cancelled' }
            }

            const content =
              request.data.format === 'csv'
                ? this.exportToCsv(rows)
                : JSON.stringify(rows, null, 2)

            writeFileSync(result.filePath, content, 'utf8')
            return { success: true, data: { filePath: result.filePath } }
          }

          // ---------------------------------------------------------- settings
          case 'settings:get':
            return { success: true, data: this.db.getAllSettings() }

          case 'settings:save': {
            const cloudBefore = this.cloudSettings()

            for (const [key, value] of Object.entries(request.data)) {
              this.db.setSetting(key as keyof Settings, value)
            }

            const updated = this.db.getAllSettings()
            this.sshManager.configureLogging({
              directory: updated.sessionLogDir || undefined,
              format: updated.sessionLogFormat,
            })

            // The Settings dialog can change the cloud server and the enabled
            // flag, and it writes them through this generic path rather than
            // `cloud:save-settings`. Without this the service keeps the
            // previous server's binding, and "signed in" would go on being
            // reported from a credential belonging to a host the app is no
            // longer talking to.
            const cloudAfter = this.cloudSettings()

            if (
              cloudAfter.baseUrl !== cloudBefore.baseUrl ||
              cloudAfter.enabled !== cloudBefore.enabled
            ) {
              await this.cloud.initialize()
              if (cloudAfter.enabled) void this.cloud.loadAccount()
            }

            // The interval is a setting, so the timer has to be rebuilt when it
            // changes — otherwise turning sync down to manual leaves the old
            // timer running until the app is restarted.
            if ('cloudSyncIntervalMinutes' in request.data) {
              this.scheduleSync()
            }

            return { success: true, data: updated }
          }

          // ------------------------------------------------------------- keys
          case 'keys:list':
            return { success: true, data: this.db.listSshKeys() }

          case 'keys:generate': {
            const { name, type, bits, comment, passphrase } = request.data

            this.assertKeyNameFree(name)

            const generated = await generateKeyPair({ type, bits, comment, passphrase })

            const saved = this.db.saveSshKey({
              name,
              type,
              // ed25519 has no size to choose — the curve fixes it — so record 0
              // rather than the RSA default, which the key list would print as
              // a meaningless "ed25519 4096".
              bits: type === 'ed25519' ? 0 : bits,
              publicKey: generated.publicKey,
              fingerprint: generated.fingerprint,
              comment,
              hasPassphrase: Boolean(passphrase),
            })

            await keytar.setPassword(VAULT_SERVICE, keyVaultAccount(saved.id!), generated.privateKeyPem)
            if (passphrase) {
              await keytar.setPassword(VAULT_SERVICE, keyPassphraseAccount(saved.id!), passphrase)
            }

            return { success: true, data: saved }
          }

          case 'keys:import': {
            const { name, privateKey, passphrase, comment } = request.data

            this.assertKeyNameFree(name)

            const derived = await publicKeyFromPrivate(privateKey, passphrase, comment || name)

            const saved = this.db.saveSshKey({
              name,
              type: derived.type,
              bits: 0,
              publicKey: derived.publicKey,
              fingerprint: derived.fingerprint,
              comment,
              hasPassphrase: Boolean(passphrase),
            })

            await keytar.setPassword(VAULT_SERVICE, keyVaultAccount(saved.id!), privateKey)
            if (passphrase) {
              await keytar.setPassword(VAULT_SERVICE, keyPassphraseAccount(saved.id!), passphrase)
            }

            return { success: true, data: saved }
          }

          case 'keys:delete': {
            await keytar.deletePassword(VAULT_SERVICE, keyVaultAccount(request.data.id))
            await keytar.deletePassword(VAULT_SERVICE, keyPassphraseAccount(request.data.id))
            return { success: true, data: this.db.deleteSshKey(request.data.id) }
          }

          case 'keys:get-public': {
            const key = this.db.getSshKey(request.data.id)
            if (!key) return { success: false, error: 'Key not found' }
            return { success: true, data: { publicKey: key.publicKey, fingerprint: key.fingerprint } }
          }

          case 'keys:export-private': {
            const key = this.db.getSshKey(request.data.id)
            if (!key) return { success: false, error: 'Key not found' }

            const pem = await keytar.getPassword(VAULT_SERVICE, keyVaultAccount(key.id!))
            if (!pem) return { success: false, error: 'Private key missing from the vault' }

            const result = await dialog.showSaveDialog(this.mainWindow!, {
              title: 'Export private key',
              defaultPath: `id_${key.type}_${key.name.replace(/[^\w.-]+/g, '_')}`,
            })
            if (result.canceled || !result.filePath) {
              return { success: false, error: 'Export cancelled' }
            }

            writePrivateKeyFile(result.filePath, pem)
            writeFileSync(`${result.filePath}.pub`, `${key.publicKey}\n`, 'utf8')
            return { success: true, data: { filePath: result.filePath } }
          }

          case 'keys:deploy': {
            const { keyId, profileId, sessionId, password } = request.data

            const key = this.db.getSshKey(keyId)
            if (!key) return { success: false, error: 'Key not found' }

            const profile = this.db.getProfile(profileId)
            if (!profile) return { success: false, error: 'Profile not found' }

            // Prefer an already-authenticated session so the user is not asked
            // for a password they have already supplied.
            if (sessionId) {
              const session = this.sshManager.getSession(sessionId)
              if (!session || session.status !== 'connected') {
                return { success: false, error: 'Session is not connected' }
              }
              const deployed = await installPublicKeyOnClient(session.client, key.publicKey)
              return deployed.success
                ? { success: true, data: deployed }
                : { success: false, error: deployed.error }
            }

            const resolvedPassword =
              password ?? (await keytar.getPassword(VAULT_SERVICE, `${profileId}:password`))
            if (!resolvedPassword) {
              return { success: false, error: 'A password is required to install the key' }
            }

            const deployed = await installPublicKeyViaPassword(
              profile,
              resolvedPassword,
              key.publicKey
            )
            return deployed.success
              ? { success: true, data: deployed }
              : { success: false, error: deployed.error }
          }

          // ---------------------------------------------------------- secrets
          case 'secrets:get':
            return {
              success: true,
              data: {
                password: await keytar.getPassword(request.data.service, request.data.account),
              },
            }

          case 'secrets:set':
            await keytar.setPassword(
              request.data.service,
              request.data.account,
              request.data.password
            )
            return { success: true, data: { success: true } }

          case 'secrets:delete':
            await keytar.deletePassword(request.data.service, request.data.account)
            return { success: true, data: { success: true } }

          // ---------------------------------------------------------- dialogs
          case 'dialog:pick-directory': {
            const result = await dialog.showOpenDialog(this.mainWindow!, {
              properties: ['openDirectory', 'createDirectory'],
            })
            if (result.canceled || result.filePaths.length === 0) {
              return { success: false, error: 'Selection cancelled' }
            }
            return { success: true, data: { path: result.filePaths[0] } }
          }

          case 'dialog:pick-file': {
            const result = await dialog.showOpenDialog(this.mainWindow!, {
              properties: ['openFile'],
            })
            if (result.canceled || result.filePaths.length === 0) {
              return { success: false, error: 'Selection cancelled' }
            }
            const path = result.filePaths[0]
            return {
              success: true,
              data: { path, contents: readFileSync(path, 'utf8') },
            }
          }

          // -------------------------------------------------------- assistant
          case 'ai:ask': {
            const settings = this.aiSettings()
            const apiKey =
              settings.provider === 'ollama'
                ? ''
                : (await keytar.getPassword(VAULT_SERVICE, aiKeyAccount(settings.provider))) ?? ''

            // Streams over `ai-stream`; this resolves when the turn completes.
            const result = await this.assistant.ask(request.data, settings, apiKey)
            return { success: true, data: result }
          }

          case 'ai:cancel':
            return {
              success: true,
              data: { cancelled: this.assistant.cancel(request.data.requestId) },
            }

          case 'ai:get-settings':
            return { success: true, data: this.aiSettings() }

          case 'ai:save-settings': {
            const merged = AiSettingsSchema.parse({ ...this.aiSettings(), ...request.data })
            this.db.setSetting('assistant' as never, merged)
            return { success: true, data: merged }
          }

          case 'ai:set-key': {
            const { provider, apiKey } = request.data
            if (apiKey) {
              await keytar.setPassword(VAULT_SERVICE, aiKeyAccount(provider), apiKey)
            } else {
              await keytar.deletePassword(VAULT_SERVICE, aiKeyAccount(provider))
            }
            return { success: true, data: { saved: Boolean(apiKey) } }
          }

          case 'ai:key-status': {
            // Only whether a key exists — never the key itself.
            const status: Record<string, boolean> = {}
            for (const provider of ['anthropic', 'openai'] as const) {
              status[provider] = Boolean(
                await keytar.getPassword(VAULT_SERVICE, aiKeyAccount(provider))
              )
            }
            return { success: true, data: status }
          }

          case 'ai:list-models': {
            const settings = this.aiSettings()
            if (settings.provider !== 'ollama') {
              return { success: true, data: { models: [], note: 'Enumeration is Ollama only' } }
            }
            try {
              return { success: true, data: { models: await listOllamaModels(settings.baseUrl) } }
            } catch (error) {
              return {
                success: false,
                error: `Could not reach Ollama: ${
                  error instanceof Error ? error.message : error
                }`,
              }
            }
          }

          // ------------------------------------------------------------- tldr
          case 'tldr:status':
            return {
              success: true,
              data: { ...this.tldr.getStatus(), cacheBytes: this.tldr.getCacheSize() },
            }

          case 'tldr:lookup':
            return {
              success: true,
              data: this.tldr.lookup(request.data.command, request.data.platform),
            }

          case 'tldr:search':
            return {
              success: true,
              data: this.tldr.search(request.data.query, request.data.platform, request.data.limit),
            }

          case 'tldr:page': {
            const { command, platform, exact } = request.data
            const page =
              exact && isTldrPlatform(platform)
                ? this.tldr.getExactPage(command, platform)
                : this.tldr.getPage(command, platform)

            return {
              success: true,
              data: {
                page,
                related: page ? this.tldr.getRelated(page.command, platform) : [],
                platforms: this.tldr.getPlatforms(command),
              },
            }
          }

          case 'tldr:update':
            return { success: true, data: await this.tldr.update() }

          case 'tldr:rebuild':
            return { success: true, data: await this.tldr.rebuildIndex() }

          case 'tldr:clear':
            return { success: true, data: await this.tldr.clear() }

          /**
           * Runs a command the operator built in the tldr panel, on one session.
           *
           * Both safety properties live here rather than in the renderer,
           * because a renderer bug — a stale target, a panel that stayed open
           * while the operator switched tabs — is exactly what this guards
           * against:
           *
           *  - The command goes to the session named in the request and to no
           *    other. There is no broadcast path and no "active session"
           *    fallback: an unknown or disconnected id is refused, never
           *    quietly redirected to whatever happens to be in front.
           *  - Anything classified as destructive is refused until the caller
           *    states the operator was shown it and agreed.
           *
           * tldr is documentation, not a safety review — it documents `rm -rf`
           * as cheerfully as it documents `ls`.
           */
          case 'tldr:run': {
            const { sessionId, command, confirmedDestructive } = request.data
            const session = this.sshManager.getSession(sessionId)

            // The decision itself is a pure function so it can be tested
            // without a process, a connection or a UI — see tldr-run.ts.
            const decision = decideTldrRun({
              target: session
                ? { name: session.profile.name, status: session.status }
                : null,
              command,
              confirmedDestructive,
            })

            if (!decision.allow) {
              if (decision.kind === 'needs-confirmation') {
                return {
                  success: true,
                  data: { ran: false, requiresConfirmation: true, reasons: decision.reasons },
                }
              }
              return { success: false, error: decision.message }
            }

            const sent = this.sshManager.sendToSession(sessionId, `${command}\n`)
            if (!sent) {
              return { success: false, error: 'The session did not accept the command.' }
            }

            console.log('[tldr] command executed', { sessionId, destructive: decision.destructive })
            this.logAudit({
              userMachine: this.userMachine,
              sessionId,
              profileId: session!.profile.id!,
              macroName: decision.destructive ? 'tldr (confirmed)' : 'tldr',
              commands: [command],
              result: 'success',
            })

            return { success: true, data: { ran: true, requiresConfirmation: false, reasons: [] } }
          }

          // ------------------------------------------------ SmartCom Cloud
          //
          // Nothing below returns a token. `cloud:status` is display data, and
          // the two billing channels return a URL that is opened in the system
          // browser — the app renders no payment form, ever.
          case 'cloud:status':
            return { success: true, data: this.cloud.getState() }

          case 'cloud:get-settings':
            return { success: true, data: this.cloudSettings() }

          case 'cloud:save-settings': {
            const previous = this.cloudSettings()
            const { enabled, baseUrl, deviceName } = request.data

            if (enabled !== undefined) this.db.setSetting('cloudEnabled', enabled)
            if (baseUrl !== undefined) this.db.setSetting('cloudBaseUrl', baseUrl.trim())
            if (deviceName !== undefined) this.db.setSetting('cloudDeviceName', deviceName.trim())

            const current = this.cloudSettings()

            // Changing the server is changing accounts, so the service rebinds
            // and reads whatever credential belongs to the new host. Turning
            // the feature on is the one moment it is worth reaching out
            // unprompted — the panel that follows would only do it anyway.
            if (current.baseUrl !== previous.baseUrl || current.enabled !== previous.enabled) {
              await this.cloud.initialize()

              if (current.enabled) void this.cloud.loadAccount()
            }

            return { success: true, data: current }
          }

          case 'cloud:sign-in': {
            const state = await this.cloud.signIn(request.data.email, request.data.password)

            // A sign-in is a security event on this machine, and the audit log
            // is where an operator looks for those. The address is recorded
            // because it names the account; the password is not touched, and
            // no token is written anywhere near this log.
            this.logAudit({
              userMachine: this.userMachine,
              sessionId: 'cloud',
              macroName: 'SmartCom Cloud sign-in',
              commands: [`sign-in ${request.data.email} → ${this.cloud.getState().baseUrl}`],
              result: state.signedIn ? 'success' : 'error',
              stderrSnippet: state.signedIn ? undefined : state.error.message,
            })

            return state.signedIn
              ? { success: true, data: state }
              : { success: false, error: state.error.message || 'Sign-in failed.' }
          }

          case 'cloud:sign-out':
            return { success: true, data: await this.cloud.signOut(request.data.everywhere) }

          case 'cloud:refresh':
            return { success: true, data: await this.cloud.loadAccount() }

          case 'cloud:devices':
            return { success: true, data: { devices: await this.cloud.listDevices() } }

          case 'cloud:rename-device': {
            const device = await this.cloud.renameDevice(request.data.deviceId, request.data.name)
            return device
              ? { success: true, data: device }
              : { success: false, error: this.cloud.getState().error.message || 'Rename failed.' }
          }

          case 'cloud:revoke-device': {
            const revoked = await this.cloud.revokeDevice(request.data.deviceId)
            return revoked
              ? { success: true, data: { revoked } }
              : { success: false, error: this.cloud.getState().error.message || 'Revoke failed.' }
          }

          case 'cloud:checkout': {
            const url = await this.cloud.checkoutUrl(request.data.plan)
            if (!url) {
              return {
                success: false,
                error: this.cloud.getState().error.message || 'Could not start checkout.',
              }
            }

            await shell.openExternal(url)
            return { success: true, data: { opened: true } }
          }

          case 'cloud:portal': {
            const url = await this.cloud.portalUrl()
            if (!url) {
              return {
                success: false,
                error: this.cloud.getState().error.message || 'Could not open the billing portal.',
              }
            }

            await shell.openExternal(url)
            return { success: true, data: { opened: true } }
          }

          case 'cloud:open-signup':
            await shell.openExternal(this.cloud.signupUrl())
            return { success: true, data: { opened: true } }

          case 'cloud:sync-status':
            return { success: true, data: this.sync.getStatus() }

          case 'cloud:sync-now': {
            const status = await this.sync.syncNow()
            return status.lastError
              ? { success: false, error: status.lastError }
              : { success: true, data: status }
          }

          case 'cloud:sync-everything': {
            const queued = this.db.markEverythingDirty()
            const status = await this.sync.syncNow()
            return { success: true, data: { queued, status } }
          }

          // ------------------------------------------------- detached windows
          case 'windows:detach': {
            const info = await this.windows.detach(request.data.sessionIds)
            return { success: true, data: info }
          }

          case 'windows:list':
            return {
              success: true,
              data: { windows: this.windows.list(), placement: this.windows.placement() },
            }

          case 'windows:reattach':
            return {
              success: true,
              data: { reattached: this.windows.reattach(request.data.windowId) },
            }

          case 'windows:set-active-session':
            this.windows.setActiveSession(request.data.sessionId)
            return { success: true, data: { activeSessionId: this.windows.getActiveSessionId() } }

          // -------------------------------------------------------- clipboard
          case 'clipboard:write':
            clipboard.writeText(request.data.text)
            return { success: true, data: { written: request.data.text.length } }

          case 'clipboard:read':
            return { success: true, data: { text: clipboard.readText() } }

          // ---------------------------------------------------------- updates
          case 'updates:status':
            return { success: true, data: this.updates.getStatus() }

          case 'updates:check':
            return { success: true, data: await this.updates.check(request.data ?? {}) }

          case 'updates:download':
            return { success: true, data: await this.updates.download() }

          case 'updates:install':
            this.updates.install()
            return { success: true, data: { installing: true } }

          case 'updates:open-releases':
            await this.updates.openReleasesPage()
            return { success: true, data: { opened: true } }

          // -------------------------------------------------------------- app
          case 'app:get-version':
            return { success: true, data: { version: app.getVersion() } }

          case 'app:get-info': {
            const settings = this.db.getAllSettings()
            return {
              success: true,
              data: {
                name: APP_NAME,
                version: app.getVersion(),
                electron: process.versions.electron,
                chrome: process.versions.chrome,
                node: process.versions.node,
                v8: process.versions.v8,
                platform: process.platform,
                arch: process.arch,
                packaged: app.isPackaged,
                userMachine: this.userMachine,
                dataDirectory: app.getPath('userData'),
                databasePath: this.db.getDatabasePath(),
                logDirectory:
                  settings.sessionLogDir || join(app.getPath('userData'), 'session-logs'),
                encryptionAvailable: getKeychainManager().isEncryptionAvailable(),
                encryptionBackend: getKeychainManager().describeBackend(),
                // What this startup did to the data, so an upgrade that goes
                // wrong can be traced — and the snapshot found — from the UI.
                ...this.db.getUpgradeInfo(),
                packageKind: packageKind(),
                repositoryUrl: REPOSITORY_URL,
              },
            }
          }

          case 'app:open-path': {
            const error = await shell.openPath(request.data.path)
            // openPath resolves with a message string on failure, '' on success.
            return error ? { success: false, error } : { success: true, data: {} }
          }

          case 'app:open-external': {
            // Restricted to web URLs so a crafted link cannot launch a local
            // handler (file:, smartcom:, etc).
            const { protocol } = new URL(request.data.url)
            if (protocol !== 'https:' && protocol !== 'http:') {
              return { success: false, error: 'Only http(s) links can be opened' }
            }
            await shell.openExternal(request.data.url)
            return { success: true, data: {} }
          }

          case 'app:quit':
            app.quit()
            return { success: true, data: {} }

          default:
            return { success: false, error: 'Unknown channel' }
        }
      } catch (error) {
        console.error('IPC Error:', error)
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      }
    })
  }

  private exportToCsv(logs: Record<string, unknown>[]): string {
    if (logs.length === 0) return ''

    const headers = Object.keys(logs[0])
    const escape = (value: unknown): string => {
      const text = Array.isArray(value)
        ? value.join('; ')
        : value && typeof value === 'object'
          ? JSON.stringify(value)
          : String(value ?? '')
      return `"${text.replace(/"/g, '""')}"`
    }

    return [
      headers.join(','),
      ...logs.map((log) => headers.map((header) => escape(log[header])).join(',')),
    ].join('\n')
  }
}

declare global {
  const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined
  const MAIN_WINDOW_VITE_NAME: string | undefined
}

new SmartcomRevisitedApp()
