/**
 * Product identity in one place. The vault service name and database filename
 * are persistence keys — changing them orphans existing secrets and data, so
 * treat them as a migration, not a rename.
 */

/** Display name, shown in the UI, window title and installers. */
export const APP_NAME = 'Smartcom Revisited'

/** Slug for filenames, log prefixes and the npm package. */
export const APP_SLUG = 'smartcom-revisited'

/** Service name every secret is filed under in the OS-encrypted vault. */
export const VAULT_SERVICE = APP_SLUG

/** SQLite database filename inside the app's userData directory. */
export const DB_FILENAME = `${APP_SLUG}.db`

/** Custom URL scheme registered by the Windows installer. */
export const URL_PROTOCOL = 'smartcom'

/** Where releases are published; also the update feed and the About link. */
export const REPOSITORY_URL = 'https://github.com/kbstechnologies/SmartcomRevisited'
export const RELEASES_URL = `${REPOSITORY_URL}/releases`

/**
 * User-data directories left behind by earlier releases, newest first.
 *
 * `app.getPath('userData')` is the app data directory plus `app.getName()`,
 * which Electron takes from the packaged `package.json` — `productName` in
 * preference to `name`. Renaming the app therefore moves everything the user
 * owns, so each rename that shipped is listed here and copied across once.
 *
 * Note that this is *not* the same string as electron-builder's
 * `build.productName`, which only names the installer and the install
 * directory. They deliberately differ: the install directory must not contain a
 * space (Electron's zygote splits the path and dies with
 * `failed to execvp: /opt/Smartcom`), while the data directory keeps the
 * readable name. Verified against a built .deb — the packaging rename to
 * `SmartcomRevisited` left the data directory untouched.
 */
export const LEGACY_DATA_DIRS = [
  { directory: 'EdgeSSH', dbFilename: 'edgessh.db', vaultService: 'edgessh' },
] as const

/** @deprecated Kept for the older single-directory migration call sites. */
export const LEGACY_APP_NAME = 'EdgeSSH'
export const LEGACY_VAULT_SERVICE = 'edgessh'
export const LEGACY_DB_FILENAME = 'edgessh.db'
