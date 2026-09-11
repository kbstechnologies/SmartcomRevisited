/**
 * Update contract shared by both processes.
 *
 * What an install can do about a new version depends entirely on how it was
 * installed, so that decision lives here as a pure function — the main process
 * detects the install kind, the renderer only renders the consequence.
 */

export type PackageKind = 'nsis' | 'appimage' | 'deb-rpm' | 'mac' | 'portable' | 'dev'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; version: string }
  | { state: 'available'; version: string; canInstall: boolean; notes?: string }
  | { state: 'downloading'; version: string; percent: number }
  /**
   * Downloaded and waiting. `installerPath` is set only when the person has to
   * run it themselves — see `installsManually`.
   */
  | { state: 'ready'; version: string; installerPath?: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; reason: string }

/**
 * True when the app downloads the update but leaves running it to the person.
 *
 * Windows builds are unsigned, so SmartScreen challenges the installer. When
 * electron-updater launches it on quit, that challenge arrives detached from
 * anything the person did — the app has closed, and a warning about an
 * unrecognised publisher appears on its own. Half of them will click "Don't
 * run", and the update silently never happens.
 *
 * Downloading and then showing them the file puts the challenge where it makes
 * sense: they double-click an installer they asked for, see the warning, and
 * choose. It is one more step and it is an honest one.
 *
 * **This goes away when the builds are signed** — it exists only because they
 * are not. `deleteAppDataOnUninstall` means the installer must still be run as
 * an upgrade rather than an uninstall/reinstall, which is what it does.
 */
export function installsManually(kind: PackageKind): boolean {
  return kind === 'nsis'
}

export interface SelfUpdateSupport {
  /** True when the app can download a new version and swap itself for it. */
  canInstall: boolean
  /** Shown to the user when it cannot, so the dead end is explained. */
  reason?: string
}

export function selfUpdateSupport(kind: PackageKind): SelfUpdateSupport {
  switch (kind) {
    // electron-updater replaces these in place and restarts.
    case 'nsis':
    case 'appimage':
      return { canInstall: true }

    // Owned by dpkg/rpm. Writing over them behind the package manager's back
    // would leave its database describing files that no longer match.
    case 'deb-rpm':
      return {
        canInstall: false,
        reason: 'Installed from a .deb/.rpm — update it with your package manager',
      }

    // Squirrel.Mac refuses unsigned bundles, and these builds are unsigned.
    case 'mac':
      return {
        canInstall: false,
        reason: 'These macOS builds are unsigned, so they cannot update themselves',
      }

    // A single file the user put somewhere themselves; replacing it is theirs.
    case 'portable':
      return { canInstall: false, reason: 'Portable build — replace the .exe to update' }

    case 'dev':
      return { canInstall: false, reason: 'Running from source' }
  }
}
