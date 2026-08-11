import { app, shell } from 'electron'
import { RELEASES_URL } from '../src/shared/constants'
import { selfUpdateSupport, type PackageKind, type UpdateStatus } from '../src/shared/updates'

/**
 * In-app updates.
 *
 * What can actually self-update depends on how the app was installed:
 *
 *  - **Windows NSIS** and **Linux AppImage** download the new version in the
 *    background and swap it in on quit;
 *  - **macOS** can only self-update when the build is signed, which these
 *    unsigned alpha builds are not;
 *  - **`.deb` / `.rpm`** are owned by the system package manager — writing over
 *    them behind its back would corrupt its database, so the app must not try;
 *  - **portable `.exe`** is a single file the user placed themselves.
 *
 * Where self-updating is not possible the app still *notices* a new release and
 * points at the download page, so no install is ever a dead end.
 */

/**
 * How the running build was installed, which decides what updating can do.
 *
 * The environment variables are set by the launchers themselves: electron-builder's
 * portable stub exports `PORTABLE_EXECUTABLE_DIR`, and an AppImage exports
 * `APPIMAGE` with the path of the image being run.
 */
export function packageKind(): PackageKind {
  if (!app.isPackaged) return 'dev'
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') return process.env.APPIMAGE ? 'appimage' : 'deb-rpm'
  return process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'nsis'
}

/**
 * Turns an update-check failure into something a tester can act on.
 *
 * Until the first release is published there is no feed to read, and
 * electron-updater reports that as a 404 about a missing `latest.yml` — which
 * reads like the app is broken when nothing is wrong yet.
 */
export function describeCheckFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)

  if (/404|Cannot find latest|No published versions|latest\.yml/i.test(message)) {
    return 'No releases published yet'
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|net::/i.test(message)) {
    return 'Could not reach the update server'
  }
  return message
}

type Broadcast = (status: UpdateStatus) => void

export class UpdateService {
  private status: UpdateStatus = { state: 'idle' }
  private updater: any = null
  private readonly kind: PackageKind = packageKind()

  constructor(private readonly broadcast: Broadcast) {}

  getStatus(): UpdateStatus {
    return this.status
  }

  /** The page a user is sent to when the app cannot update itself. */
  async openReleasesPage(): Promise<void> {
    await shell.openExternal(RELEASES_URL)
  }

  private set(status: UpdateStatus) {
    this.status = status
    this.broadcast(status)
  }

  /**
   * Loaded lazily and defensively: `electron-updater` throws on construction in
   * an unpackaged app, and a missing update feed must never stop the app.
   */
  private load(): any | null {
    if (this.updater) return this.updater
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater')
      autoUpdater.autoDownload = false // ask the user's setting first
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.logger = null

      autoUpdater.on('update-available', (info: any) =>
        this.set({
          state: 'available',
          version: info.version,
          canInstall: selfUpdateSupport(this.kind).canInstall,
          notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
        })
      )
      autoUpdater.on('update-not-available', (info: any) =>
        this.set({ state: 'current', version: info?.version ?? app.getVersion() })
      )
      autoUpdater.on('download-progress', (progress: any) =>
        this.set({
          state: 'downloading',
          version: this.status.state === 'available' ? this.status.version : app.getVersion(),
          percent: Math.round(progress.percent ?? 0),
        })
      )
      autoUpdater.on('update-downloaded', (info: any) =>
        this.set({ state: 'ready', version: info.version })
      )
      autoUpdater.on('error', (error: Error) =>
        this.set({ state: 'error', message: error?.message ?? String(error) })
      )

      this.updater = autoUpdater
      return autoUpdater
    } catch (error) {
      this.set({ state: 'error', message: `Update check unavailable: ${error}` })
      return null
    }
  }

  /**
   * Looks for a newer release. Downloading is separate so a user on a metered
   * connection — or a package-managed install — is only ever told, not acted on.
   */
  async check(options: { download?: boolean } = {}): Promise<UpdateStatus> {
    if (this.kind === 'dev') {
      this.set({ state: 'unsupported', reason: selfUpdateSupport('dev').reason! })
      return this.status
    }

    const updater = this.load()
    if (!updater) return this.status

    this.set({ state: 'checking' })
    try {
      const result = await updater.checkForUpdates()
      const available = result?.updateInfo?.version && result.updateInfo.version !== app.getVersion()

      if (available && options.download && selfUpdateSupport(this.kind).canInstall) {
        await updater.downloadUpdate()
      }
    } catch (error) {
      this.set({ state: 'error', message: describeCheckFailure(error) })
    }
    return this.status
  }

  /** Downloads a release already known to be available. */
  async download(): Promise<UpdateStatus> {
    if (!selfUpdateSupport(this.kind).canInstall) {
      this.set({ state: 'unsupported', reason: selfUpdateSupport(this.kind).reason! })
      return this.status
    }
    const updater = this.load()
    if (!updater) return this.status

    try {
      await updater.downloadUpdate()
    } catch (error) {
      this.set({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return this.status
  }

  /** Restarts into the downloaded version. Sessions are closed by the quit. */
  install(): void {
    const updater = this.load()
    if (!updater || this.status.state !== 'ready') return
    updater.quitAndInstall()
  }
}
