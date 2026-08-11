import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron'
import { join } from 'path'
import { hostname } from 'os'
import { writeFileSync, readFileSync } from 'fs'
import { keytar, getKeychainManager } from './keychain'
import { DatabaseManager } from './database'
import { SSHManager, buildScriptCommand } from './ssh-manager'
import { listLibrary, readScript } from './script-library'
import {
  generateKeyPair,
  installPublicKeyOnClient,
  installPublicKeyViaPassword,
  publicKeyFromPrivate,
  writePrivateKeyFile,
} from './key-manager'
import type { IpcResponse } from '../src/shared/ipc'
import { IpcRequestSchema } from '../src/shared/ipc'
import type { AuditLog, Settings } from '../src/shared/types'
import { ButtonSetBundleSchema, ConnectionBundleSchema } from '../src/shared/types'
import { APP_NAME, REPOSITORY_URL, VAULT_SERVICE } from '../src/shared/constants'
import { UpdateService, packageKind } from './updater'
import { migrateLegacyUserData } from './migrate-legacy-data'
import { WindowManager } from './window-manager'
import { Assistant } from './ai/assistant'
import { listOllamaModels } from './ai/providers'
import { AiSettingsSchema, type AiSettings } from '../src/shared/ai'

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
  private updates!: UpdateService
  private userMachine: string

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
    app.on('before-quit', () => {
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
            const closed = this.sshManager.closeSession(request.data.sessionId)
            this.windows.forgetSession(request.data.sessionId)
            return { success: true, data: { closed } }
          }

          case 'sessions:scrollback':
            return {
              success: true,
              data: { data: this.sshManager.getScrollback(request.data.sessionId) },
            }

          case 'sessions:send': {
            const sent = this.sshManager.sendToSession(request.data.sessionId, request.data.text)
            return { success: true, data: { sent } }
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
            const { remotePath, name } = await this.sshManager.stageScript(
              request.data.sessionId,
              request.data.path,
              request.data.remoteDir || '/tmp'
            )

            const line = buildScriptCommand({
              remotePath,
              interpreter: request.data.interpreter,
              args: request.data.args,
              cleanup: request.data.cleanup,
            })

            await this.sshManager.sendToSession(request.data.sessionId, `${line}\n`)
            return { success: true, data: { remotePath, name, command: line } }
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
            for (const [key, value] of Object.entries(request.data)) {
              this.db.setSetting(key as keyof Settings, value)
            }

            const updated = this.db.getAllSettings()
            this.sshManager.configureLogging({
              directory: updated.sessionLogDir || undefined,
              format: updated.sessionLogFormat,
            })
            return { success: true, data: updated }
          }

          // ------------------------------------------------------------- keys
          case 'keys:list':
            return { success: true, data: this.db.listSshKeys() }

          case 'keys:generate': {
            const { name, type, bits, comment, passphrase } = request.data

            const generated = await generateKeyPair({ type, bits, comment, passphrase })

            const saved = this.db.saveSshKey({
              name,
              type,
              bits,
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
