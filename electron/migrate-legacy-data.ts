import { app } from 'electron'
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { DB_FILENAME, LEGACY_DATA_DIRS, VAULT_SERVICE } from '../src/shared/constants'

/**
 * Carries data over from a previous release's data directory.
 *
 * `app.getPath('userData')` is derived from productName, so every rename of the
 * product moves the whole directory and would silently orphan existing
 * connections, button sets and stored secrets. Each rename that shipped is
 * listed in `LEGACY_DATA_DIRS`; the newest one that still has a database wins.
 *
 * Copies, never moves: if anything here is wrong the old directory is still
 * sitting there untouched.
 */
export function migrateLegacyUserData(): { migrated: boolean; details: string[] } {
  const details: string[] = []
  const userData = app.getPath('userData')
  const targetDb = join(userData, DB_FILENAME)

  // Never overwrite live data: only migrate into a directory with no database.
  if (existsSync(targetDb)) return { migrated: false, details }

  const parent = dirname(userData)
  const source = LEGACY_DATA_DIRS.map((legacy) => ({
    ...legacy,
    path: join(parent, legacy.directory),
    db: join(parent, legacy.directory, legacy.dbFilename),
  })).find((legacy) => legacy.path !== userData && existsSync(legacy.db))

  if (!source) return { migrated: false, details }

  mkdirSync(userData, { recursive: true })

  try {
    // The -wal and -shm siblings must travel with the database, otherwise
    // recently written pages still sitting in the WAL are lost.
    for (const [from, to] of [
      [source.db, targetDb],
      [`${source.db}-wal`, `${targetDb}-wal`],
      [`${source.db}-shm`, `${targetDb}-shm`],
    ]) {
      if (existsSync(from)) {
        copyFileSync(from, to)
        details.push(`copied ${from} -> ${to}`)
      }
    }

    // Secrets stay encrypted; only the service label they are filed under can
    // change, so rewrite that as the vault is copied.
    const legacyVault = join(source.path, 'credentials.json')
    const targetVault = join(userData, 'credentials.json')

    if (existsSync(legacyVault) && !existsSync(targetVault)) {
      const entries = JSON.parse(readFileSync(legacyVault, 'utf8')) as Array<{ service: string }>
      const relabelled = entries.map((entry) =>
        entry.service === source.vaultService ? { ...entry, service: VAULT_SERVICE } : entry
      )
      writeFileSync(targetVault, JSON.stringify(relabelled, null, 2), { mode: 0o600 })
      details.push(`migrated ${relabelled.length} vault entries from "${source.directory}"`)
    }

    return { migrated: true, details }
  } catch (error) {
    // A failed migration must not stop the app starting with a fresh database.
    details.push(`migration failed: ${error instanceof Error ? error.message : error}`)
    return { migrated: false, details }
  }
}
