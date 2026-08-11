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
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unsupported'; reason: string }

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
