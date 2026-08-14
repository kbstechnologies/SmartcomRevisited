import Database from 'better-sqlite3'
import { basename, dirname, join } from 'path'
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { app } from 'electron'
import { randomBytes } from 'crypto'
import type {
  Profile,
  Macro,
  MacroSet,
  AuditLog,
  Settings,
  LogFilter,
  SshKey,
  ButtonSetBundle,
  ConnectionBundle,
  ConnectionGroup,
} from '../src/shared/types'
import {
  BUTTON_SET_FORMAT,
  CONNECTION_FORMAT,
  FAVOURITES_SET_ID,
  FAVOURITES_SET_NAME,
} from '../src/shared/types'
import { remapBundle } from '../src/shared/button-sets'
import { APP_NAME, DB_FILENAME } from '../src/shared/constants'

// Simple UUID v4 generator
const uuidv4 = (): string => {
  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-')
}

/** Snapshots kept before version-changing migrations, newest first. */
const MAX_BACKUPS = 5

/**
 * The running app version. The smoke test drives the database outside a
 * packaged app, where `app.getVersion()` reports Electron's own version, so it
 * can be pinned to exercise the upgrade path.
 */
const currentAppVersion = (): string => process.env.SMARTCOM_APP_VERSION || app.getVersion()

export class DatabaseManager {
  private db: Database.Database
  private dbPath: string
  /** Snapshot taken during this startup, if the app version changed. */
  private backupPath: string | null = null
  private previousVersion: string | null = null

  constructor() {
    const userDataPath = app.getPath('userData')
    this.dbPath = process.env.DB_PATH || join(userDataPath, DB_FILENAME)

    this.db = new Database(this.dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')

    // Upgrades run migrations against data the user cannot afford to lose, so
    // snapshot it first — while the schema is still the one that wrote it.
    //
    // Versions before this bookkeeping existed left no marker, so an existing
    // database with no recorded version is also an upgrade — that is exactly
    // the case the earliest testers hit, and the one worth protecting.
    this.previousVersion = this.readSchemaMeta('app_version') ?? (this.hasUserData() ? 'unknown' : null)

    if (this.previousVersion && this.previousVersion !== currentAppVersion()) {
      this.backupPath = this.backupBeforeMigration(this.previousVersion)
    }

    this.runMigrations()
    this.writeSchemaMeta('app_version', currentAppVersion())
  }

  /** Where the database lives, for support questions and the About screen. */
  getDatabasePath(): string {
    return this.dbPath
  }

  /**
   * What happened at startup: the version that previously wrote this database
   * and the snapshot taken before migrating it, if this run was an upgrade.
   */
  getUpgradeInfo(): { previousVersion: string | null; backupPath: string | null } {
    return { previousVersion: this.previousVersion, backupPath: this.backupPath }
  }

  /** True when this file already holds a user's data from a previous run. */
  private hasUserData(): boolean {
    const table = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profiles'")
      .get()
    return table !== undefined
  }

  private readSchemaMeta(key: string): string | null {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)')
    const row = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  private writeSchemaMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO schema_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  /**
   * Writes a consistent copy next to the database. `VACUUM INTO` is used rather
   * than copying the file: in WAL mode the `.db` on its own is not a complete
   * database, and a plain copy can miss the most recent commits.
   */
  private backupBeforeMigration(fromVersion: string): string | null {
    try {
      const directory = join(dirname(this.dbPath), 'backups')
      mkdirSync(directory, { recursive: true })

      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(directory, `${basename(this.dbPath, '.db')}-v${fromVersion}-${stamp}.db`)

      this.db.prepare('VACUUM INTO ?').run(target)
      DatabaseManager.pruneBackups(directory)
      return target
    } catch (error) {
      // A failed backup must not stop the app from starting; the migrations
      // themselves are additive, so the risk being hedged here is small.
      console.error('Could not back up the database before migrating:', error)
      return null
    }
  }

  /** Keeps the newest few snapshots so upgrades cannot fill the disk. */
  private static pruneBackups(directory: string) {
    const snapshots = readdirSync(directory)
      .filter((name) => name.endsWith('.db'))
      .map((name) => ({ name, time: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)

    for (const stale of snapshots.slice(MAX_BACKUPS)) {
      try {
        unlinkSync(join(directory, stale.name))
      } catch {
        /* another instance may have removed it already */
      }
    }
  }

  private runMigrations() {
    this.db.exec(`
      -- Profiles table
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        username TEXT NOT NULL,
        auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'key', 'agent')),
        key_path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Macro sets table
      CREATE TABLE IF NOT EXISTS macro_sets (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Macros table
      CREATE TABLE IF NOT EXISTS macros (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        set_id TEXT NOT NULL REFERENCES macro_sets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        steps_json TEXT NOT NULL,
        placeholders_json TEXT NOT NULL DEFAULT '[]',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Audit logs table
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_machine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        -- Nullable and SET NULL: deleting a connection must not delete the
        -- record of what was run on it. profile_label keeps it readable.
        profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        profile_label TEXT,
        -- Same reasoning as profile_id: deleting a button must not delete the
        -- record of it having been run. macro_name keeps the entry readable.
        macro_id TEXT REFERENCES macros(id) ON DELETE SET NULL,
        macro_name TEXT,
        commands_json TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('success', 'timeout', 'error')),
        stdout_snippet TEXT,
        stderr_snippet TEXT
      );

      -- Settings table
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Folders for the connection list.
      CREATE TABLE IF NOT EXISTS connection_groups (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Managed SSH keys. Private key material lives in the encrypted vault,
      -- keyed by 'key:<id>:private'; only metadata is stored here.
      CREATE TABLE IF NOT EXISTS ssh_keys (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        name TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK (type IN ('rsa', 'ed25519')),
        bits INTEGER NOT NULL DEFAULT 4096,
        public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        has_passphrase INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_macros_set_id ON macros(set_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_profile_id ON audit_logs(profile_id);
      CREATE INDEX IF NOT EXISTS idx_audit_logs_macro_id ON audit_logs(macro_id);

      -- Create triggers for updated_at
      CREATE TRIGGER IF NOT EXISTS profiles_updated_at 
        AFTER UPDATE ON profiles BEGIN
        UPDATE profiles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS macro_sets_updated_at 
        AFTER UPDATE ON macro_sets BEGIN
        UPDATE macro_sets SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS macros_updated_at 
        AFTER UPDATE ON macros BEGIN
        UPDATE macros SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
      END;

      CREATE TRIGGER IF NOT EXISTS settings_updated_at 
        AFTER UPDATE ON settings BEGIN
        UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
      END;
    `)

    this.addMissingColumns()
    this.repairAuditForeignKeys()
  }

  /**
   * Rebuilds `audit_logs` when its foreign keys still block deletes.
   *
   * As shipped, `profile_id` was `NOT NULL REFERENCES profiles(id)` and
   * `macro_id` referenced `macros(id)` — both without an `ON DELETE` rule. So
   * SQLite refused to delete any connection that had been used, or any button
   * that had been run (and any set containing one), rather than orphaning the
   * audit rows. Both now clear themselves instead, and the denormalised
   * `profile_label` / `macro_name` keep the entry meaningful afterwards.
   *
   * SQLite cannot alter a foreign key in place, so the table is recreated and
   * copied — which is why this runs after a snapshot has already been taken.
   */
  private repairAuditForeignKeys() {
    const schema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_logs'")
      .get() as { sql: string } | undefined
    if (!schema) return

    const profileBlocks = /profile_id\s+TEXT\s+NOT\s+NULL/i.test(schema.sql)
    const macroBlocks = !/macro_id[^,]*ON\s+DELETE\s+SET\s+NULL/i.test(schema.sql)
    if (!profileBlocks && !macroBlocks) return

    // Rebuilding a table is the riskiest thing this class does, and it can be
    // triggered by a fix within the same version — where the version-change
    // snapshot would not have fired. Take one now if none was taken already.
    if (!this.backupPath) {
      this.backupPath = this.backupBeforeMigration(this.previousVersion ?? 'pre-repair')
    }

    // Foreign keys must be off for the swap, and cannot be toggled inside a
    // transaction — hence the explicit ordering here.
    this.db.pragma('foreign_keys = OFF')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE audit_logs_rebuilt (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            user_machine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
            profile_label TEXT,
            macro_id TEXT REFERENCES macros(id) ON DELETE SET NULL,
            macro_name TEXT,
            commands_json TEXT NOT NULL,
            result TEXT NOT NULL CHECK (result IN ('success', 'timeout', 'error')),
            stdout_snippet TEXT,
            stderr_snippet TEXT
          );

          -- Existing rows have no label, so build one from the connection they
          -- still point at while it is there to be read.
          INSERT INTO audit_logs_rebuilt
            (id, timestamp, user_machine, session_id, profile_id, profile_label,
             macro_id, macro_name, commands_json, result, stdout_snippet, stderr_snippet)
          SELECT l.id, l.timestamp, l.user_machine, l.session_id, l.profile_id,
                 CASE
                   WHEN p.id IS NULL THEN NULL
                   WHEN p.transport = 'serial' THEN p.name || ' (' || COALESCE(p.serial_path, '') || ')'
                   ELSE p.name || ' (' || p.username || '@' || p.host || ':' || p.port || ')'
                 END,
                 l.macro_id, l.macro_name, l.commands_json, l.result,
                 l.stdout_snippet, l.stderr_snippet
          FROM audit_logs l
          LEFT JOIN profiles p ON p.id = l.profile_id;

          DROP TABLE audit_logs;
          ALTER TABLE audit_logs_rebuilt RENAME TO audit_logs;
        `)
      })()
    } finally {
      this.db.pragma('foreign_keys = ON')
    }
  }

  /**
   * Additive migrations for databases created by earlier versions. SQLite has
   * no `ADD COLUMN IF NOT EXISTS`, so existing columns are checked first.
   */
  private addMissingColumns() {
    const columnsOf = (table: string): Set<string> =>
      new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name
        )
      )

    const ensure = (table: string, column: string, definition: string) => {
      if (!columnsOf(table).has(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
    }

    // Form-builder fields superseded the plain `placeholders_json` list.
    ensure('macros', 'fields_json', "TEXT NOT NULL DEFAULT '[]'")
    ensure('macros', 'color', 'TEXT')
    ensure('macros', 'icon', 'TEXT')
    ensure('macros', 'confirm_before_run', 'INTEGER NOT NULL DEFAULT 0')
    // Provenance for copied and starred buttons.
    ensure('macros', 'source_macro_id', 'TEXT')
    ensure('macro_sets', 'color', 'TEXT')
    ensure('profiles', 'key_id', 'TEXT')
    ensure('profiles', 'startup_macro_id', 'TEXT')
    // Serial support and connection folders.
    ensure('profiles', 'transport', "TEXT NOT NULL DEFAULT 'ssh'")
    ensure('profiles', 'group_id', 'TEXT')
    ensure('profiles', 'serial_path', 'TEXT')
    ensure('profiles', 'baud_rate', 'INTEGER NOT NULL DEFAULT 115200')
    ensure('profiles', 'data_bits', 'INTEGER NOT NULL DEFAULT 8')
    ensure('profiles', 'stop_bits', 'INTEGER NOT NULL DEFAULT 1')
    ensure('profiles', 'parity', "TEXT NOT NULL DEFAULT 'none'")
    ensure('profiles', 'flow_control', "TEXT NOT NULL DEFAULT 'none'")
    // Per-connection button sets. Existing rows default to `[]`, which means
    // "show everything" — an upgrade must not hide buttons someone was using.
    ensure('profiles', 'macro_set_ids', "TEXT NOT NULL DEFAULT '[]'")
  }

  /**
   * Column list shared by the profile reads, so a new field cannot be added to
   * one and forgotten in the other.
   */
  private static readonly PROFILE_COLUMNS = `
    id, name, transport, group_id as groupId,
    host, port, username, auth_method as authMethod,
    key_path as keyPath, key_id as keyId,
    serial_path as serialPath, baud_rate as baudRate, data_bits as dataBits,
    stop_bits as stopBits, parity, flow_control as flowControl,
    startup_macro_id as startupMacroId, macro_set_ids as macroSetIds,
    created_at as createdAt, updated_at as updatedAt
  `

  /**
   * Turns a stored profile row into a Profile.
   *
   * `macro_set_ids` is JSON in a TEXT column, and a row written by an older
   * build (or edited by hand) can hold anything — so a value that does not
   * parse as an array of strings becomes `[]` rather than throwing, since an
   * unreadable preference should show every button set, not break the panel.
   */
  private static toProfile(row: Record<string, unknown>): Profile {
    const raw = row.macroSetIds
    let macroSetIds: string[] = []
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          macroSetIds = [...new Set(parsed.filter((id): id is string => typeof id === 'string'))]
        }
      } catch {
        /* keep the empty list */
      }
    }

    return {
      ...(DatabaseManager.stripNulls(row) as unknown as Profile),
      macroSetIds,
    }
  }

  // Profile operations
  listProfiles(): Profile[] {
    return this.db
      .prepare(`SELECT ${DatabaseManager.PROFILE_COLUMNS} FROM profiles ORDER BY name`)
      .all()
      .map((row) => DatabaseManager.toProfile(row as Record<string, unknown>))
  }

  getProfile(id: string): Profile | null {
    const row = this.db
      .prepare(`SELECT ${DatabaseManager.PROFILE_COLUMNS} FROM profiles WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined

    return row ? DatabaseManager.toProfile(row) : null
  }

  saveProfile(profile: Profile): Profile {
    const id = profile.id ?? uuidv4()

    // INSERT OR REPLACE keeps one statement for both paths now that the column
    // list spans two transports.
    this.db.prepare(`
      INSERT OR REPLACE INTO profiles
        (id, name, transport, group_id, host, port, username, auth_method,
         key_path, key_id, serial_path, baud_rate, data_bits, stop_bits,
         parity, flow_control, startup_macro_id, macro_set_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      profile.name,
      profile.transport,
      profile.groupId ?? null,
      profile.host,
      profile.port,
      profile.username,
      profile.authMethod,
      profile.keyPath ?? null,
      profile.keyId ?? null,
      profile.serialPath ?? null,
      profile.baudRate,
      profile.dataBits,
      profile.stopBits,
      profile.parity,
      profile.flowControl,
      profile.startupMacroId ?? null,
      // Sets that have since been deleted are dropped on the way in, so a
      // stale id cannot sit in the row forever and silently come back to life
      // if the same id is ever reissued.
      JSON.stringify(
        [...new Set(profile.macroSetIds ?? [])].filter((setId) => this.getMacroSet(setId) !== null)
      )
    )

    return this.getProfile(id)!
  }

  // --- Connection export / import --------------------------------------------

  /**
   * Bundles connections and the folders they live in.
   *
   * Secrets are never included: passwords and key passphrases stay in the OS
   * vault, so an exported file is safe to share and the recipient re-enters
   * credentials themselves.
   */
  exportConnections(profileIds?: string[]): ConnectionBundle {
    const all = this.listProfiles()
    const profiles = profileIds?.length
      ? all.filter((profile) => profileIds.includes(profile.id!))
      : all

    const usedGroupIds = new Set(profiles.map((p) => p.groupId).filter(Boolean))
    const groups = this.listConnectionGroups().filter((group) => usedGroupIds.has(group.id))

    return {
      format: CONNECTION_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: APP_NAME,
      groups,
      profiles,
    }
  }

  /** Recreates a connection bundle under fresh ids, renaming on collision. */
  importConnections(bundle: ConnectionBundle): {
    groups: number
    profiles: number
    renamed: Array<{ from: string; to: string }>
  } {
    const groupIdMap = new Map<string, string>()
    const renamed: Array<{ from: string; to: string }> = []

    const nameTaken = (table: string, name: string) =>
      this.db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(name) !== undefined

    const claimed = new Set<string>()
    const freeName = (table: string, name: string) => {
      if (!claimed.has(name) && !nameTaken(table, name)) return name
      let counter = 2
      let candidate = `${name} (imported)`
      while (claimed.has(candidate) || nameTaken(table, candidate)) {
        candidate = `${name} (imported ${counter++})`
      }
      renamed.push({ from: name, to: candidate })
      return candidate
    }

    this.db.transaction(() => {
      for (const group of bundle.groups) {
        const newId = uuidv4()
        if (group.id) groupIdMap.set(group.id, newId)

        const name = freeName('connection_groups', group.name)
        claimed.add(name)
        this.saveConnectionGroup({ ...group, id: newId, name })
      }

      for (const profile of bundle.profiles) {
        const name = freeName('profiles', profile.name)
        claimed.add(name)
        this.saveProfile({
          ...profile,
          id: uuidv4(),
          name,
          groupId: profile.groupId ? groupIdMap.get(profile.groupId) : undefined,
          // A startup macro from another machine will not exist here.
          startupMacroId: profile.startupMacroId
            ? (this.getMacro(profile.startupMacroId) ? profile.startupMacroId : undefined)
            : undefined,
          // Same for assigned button sets — importing a bundle mints fresh set
          // ids, so ids from the exporting machine almost never match. Keeping
          // only the ones that resolve means a partial match still works and a
          // total miss falls back to showing every set, rather than to a panel
          // that is mysteriously empty on the imported connections.
          macroSetIds: (profile.macroSetIds ?? []).filter((setId) => this.getMacroSet(setId) !== null),
          // Managed keys live in this machine's vault, so a foreign id is dropped.
          keyId: profile.keyId ? (this.getSshKey(profile.keyId) ? profile.keyId : undefined) : undefined,
        })
      }
    })()

    return { groups: bundle.groups.length, profiles: bundle.profiles.length, renamed }
  }

  // --- Connection groups -----------------------------------------------------

  listConnectionGroups(): ConnectionGroup[] {
    return this.db
      .prepare(`
        SELECT id, name, description, color, sort_order as sortOrder,
               created_at as createdAt, updated_at as updatedAt
        FROM connection_groups ORDER BY sort_order, name
      `)
      .all()
      .map((row) => DatabaseManager.stripNulls(row as Record<string, unknown>)) as unknown as ConnectionGroup[]
  }

  saveConnectionGroup(group: ConnectionGroup): ConnectionGroup {
    const id = group.id ?? uuidv4()
    this.db
      .prepare(`
        INSERT OR REPLACE INTO connection_groups (id, name, description, color, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(id, group.name, group.description ?? null, group.color ?? null, group.sortOrder)

    return this.listConnectionGroups().find((g) => g.id === id)!
  }

  deleteConnectionGroup(id: string): boolean {
    // Connections outlive their folder; they simply become ungrouped.
    this.db.prepare('UPDATE profiles SET group_id = NULL WHERE group_id = ?').run(id)
    return this.db.prepare('DELETE FROM connection_groups WHERE id = ?').run(id).changes > 0
  }

  deleteProfile(id: string): boolean {
    const result = this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id)
    return result.changes > 0
  }

  // Macro Set operations
  listMacroSets(): MacroSet[] {
    return this.db.prepare(`
      SELECT id, name, description, color, created_at as createdAt, updated_at as updatedAt
      FROM macro_sets ORDER BY name
    `).all().map((row) => DatabaseManager.stripNulls(row as Record<string, unknown>)) as unknown as MacroSet[]
  }

  saveMacroSet(macroSet: MacroSet): MacroSet {
    if (macroSet.id) {
      this.db.prepare(`
        UPDATE macro_sets SET name = ?, description = ?, color = ? WHERE id = ?
      `).run(macroSet.name, macroSet.description ?? null, macroSet.color ?? null, macroSet.id)
    } else {
      macroSet.id = uuidv4()
      this.db.prepare(`
        INSERT INTO macro_sets (id, name, description, color) VALUES (?, ?, ?, ?)
      `).run(macroSet.id, macroSet.name, macroSet.description ?? null, macroSet.color ?? null)
    }
    return macroSet
  }

  // SSH key operations (metadata only; private keys live in the vault)
  listSshKeys(): SshKey[] {
    return this.db
      .prepare(`
        SELECT id, name, type, bits, public_key as publicKey, fingerprint, comment,
               has_passphrase, created_at as createdAt
        FROM ssh_keys ORDER BY name
      `)
      .all()
      .map((row: any) => ({ ...row, hasPassphrase: Boolean(row.has_passphrase) })) as SshKey[]
  }

  getSshKey(id: string): SshKey | null {
    const row = this.db
      .prepare(`
        SELECT id, name, type, bits, public_key as publicKey, fingerprint, comment,
               has_passphrase, created_at as createdAt
        FROM ssh_keys WHERE id = ?
      `)
      .get(id) as any

    return row ? ({ ...row, hasPassphrase: Boolean(row.has_passphrase) } as SshKey) : null
  }

  saveSshKey(key: SshKey): SshKey {
    const id = key.id ?? uuidv4()
    this.db.prepare(`
      INSERT OR REPLACE INTO ssh_keys
        (id, name, type, bits, public_key, fingerprint, comment, has_passphrase)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      key.name,
      key.type,
      key.bits,
      key.publicKey,
      key.fingerprint,
      key.comment ?? '',
      key.hasPassphrase ? 1 : 0
    )
    return this.getSshKey(id)!
  }

  deleteSshKey(id: string): boolean {
    // Profiles pointing at this key fall back to their other auth settings.
    this.db.prepare('UPDATE profiles SET key_id = NULL WHERE key_id = ?').run(id)
    return this.db.prepare('DELETE FROM ssh_keys WHERE id = ?').run(id).changes > 0
  }

  getMacroSet(id: string): MacroSet | null {
    const row = this.db
      .prepare(
        `SELECT id, name, description, color, created_at as createdAt, updated_at as updatedAt
         FROM macro_sets WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined

    return row ? (DatabaseManager.stripNulls(row) as unknown as MacroSet) : null
  }

  // --- Export / import -------------------------------------------------------

  /** Bundles the given sets together with every button they contain. */
  exportMacroSets(setIds: string[]): ButtonSetBundle {
    const sets = setIds
      .map((id) => this.getMacroSet(id))
      .filter((set): set is MacroSet => set !== null)

    const macros = sets.flatMap((set) => this.listMacrosInSet(set.id!))

    return {
      format: BUTTON_SET_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      exportedBy: APP_NAME,
      sets,
      macros,
    }
  }

  /**
   * Recreates a bundle under fresh ids. The id rewriting lives in
   * `shared/button-sets.ts` as a pure function so it can be unit tested without
   * a database; this method only persists the result.
   */
  importMacroSets(bundle: ButtonSetBundle): {
    sets: number
    macros: number
    renamed: Array<{ from: string; to: string }>
    droppedReferences: number
  } {
    const remapped = remapBundle(bundle, {
      newId: uuidv4,
      isSetNameTaken: (name) =>
        this.db.prepare('SELECT 1 FROM macro_sets WHERE name = ?').get(name) !== undefined,
    })

    // One transaction: a partly imported set would be worse than none.
    this.db.transaction(() => {
      for (const set of remapped.sets) {
        this.db
          .prepare('INSERT INTO macro_sets (id, name, description, color) VALUES (?, ?, ?, ?)')
          .run(set.id, set.name, set.description ?? null, set.color ?? null)
      }
      for (const macro of remapped.macros) {
        this.saveMacroRow(macro)
      }
    })()

    return {
      sets: remapped.sets.length,
      macros: remapped.macros.length,
      renamed: remapped.renamed,
      droppedReferences: remapped.droppedReferences,
    }
  }

  /** Insert helper shared by saveMacro and import, with the id already chosen. */
  private saveMacroRow(macro: Macro): void {
    this.db
      .prepare(
        `INSERT INTO macros
           (id, set_id, name, description, steps_json, placeholders_json, fields_json, color, icon, confirm_before_run, source_macro_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        macro.id,
        macro.setId,
        macro.name,
        macro.description ?? null,
        JSON.stringify(macro.steps ?? []),
        JSON.stringify(macro.placeholders ?? []),
        JSON.stringify(macro.fields ?? []),
        macro.color ?? null,
        macro.icon ?? null,
        macro.confirmBeforeRun ? 1 : 0,
        // An id from the exporting machine means nothing here.
        null
      )
  }

  deleteMacroSet(id: string): boolean {
    const result = this.db.prepare('DELETE FROM macro_sets WHERE id = ?').run(id)
    return result.changes > 0
  }

  // Macro operations
  private static readonly MACRO_COLUMNS = `
    id, set_id as setId, name, description, steps_json, placeholders_json,
    fields_json, color, icon, confirm_before_run, source_macro_id as sourceMacroId,
    created_at as createdAt, updated_at as updatedAt
  `

  /**
   * SQLite NULL arrives as `null`, which the zod schemas treat as absent-but-
   * wrong. Dropping the keys entirely keeps round-tripping a loaded row back
   * through IPC valid.
   */
  private static stripNulls<T extends Record<string, any>>(row: T): T {
    const clean: Record<string, any> = {}
    for (const [key, value] of Object.entries(row)) {
      if (value !== null) clean[key] = value
    }
    return clean as T
  }

  /** Tolerates rows written before a column existed or hand-edited JSON. */
  private static parseJson<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string' || raw.length === 0) return fallback
    try {
      return JSON.parse(raw) as T
    } catch {
      return fallback
    }
  }

  private static rowToMacro(row: any): Macro {
    const { steps_json, placeholders_json, fields_json, confirm_before_run, ...rest } = DatabaseManager.stripNulls(row)
    return {
      ...rest,
      steps: DatabaseManager.parseJson(steps_json, []),
      placeholders: DatabaseManager.parseJson(placeholders_json, []),
      fields: DatabaseManager.parseJson(fields_json, []),
      confirmBeforeRun: Boolean(confirm_before_run),
    } as Macro
  }

  listMacros(): Macro[] {
    return this.db
      .prepare(`SELECT ${DatabaseManager.MACRO_COLUMNS} FROM macros ORDER BY name`)
      .all()
      .map(DatabaseManager.rowToMacro)
  }

  /** Ordered members of a set — the expansion used by `callSet` steps. */
  listMacrosInSet(setId: string): Macro[] {
    return this.db
      .prepare(`SELECT ${DatabaseManager.MACRO_COLUMNS} FROM macros WHERE set_id = ? ORDER BY name`)
      .all(setId)
      .map(DatabaseManager.rowToMacro)
  }

  getMacro(id: string): Macro | null {
    const row = this.db
      .prepare(`SELECT ${DatabaseManager.MACRO_COLUMNS} FROM macros WHERE id = ?`)
      .get(id) as any

    return row ? DatabaseManager.rowToMacro(row) : null
  }

  saveMacro(macro: Macro): Macro {
    const values = [
      macro.setId,
      macro.name,
      macro.description ?? null,
      JSON.stringify(macro.steps ?? []),
      JSON.stringify(macro.placeholders ?? []),
      JSON.stringify(macro.fields ?? []),
      macro.color ?? null,
      macro.icon ?? null,
      macro.confirmBeforeRun ? 1 : 0,
      macro.sourceMacroId ?? null,
    ]

    if (macro.id) {
      this.db.prepare(`
        UPDATE macros
        SET set_id = ?, name = ?, description = ?, steps_json = ?, placeholders_json = ?,
            fields_json = ?, color = ?, icon = ?, confirm_before_run = ?, source_macro_id = ?
        WHERE id = ?
      `).run(...values, macro.id)
    } else {
      macro.id = uuidv4()
      this.db.prepare(`
        INSERT INTO macros
          (set_id, name, description, steps_json, placeholders_json, fields_json, color, icon, confirm_before_run, source_macro_id, id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values, macro.id)
    }
    return this.getMacro(macro.id!)!
  }

  deleteMacro(id: string): boolean {
    const result = this.db.prepare('DELETE FROM macros WHERE id = ?').run(id)
    return result.changes > 0
  }

  // --- Favourites and copies -------------------------------------------------

  /**
   * Returns the favourites set, creating it the first time something is starred.
   *
   * Created on demand rather than at install time so a user who never stars
   * anything is not given an empty set to wonder about, and so the row cannot
   * be resurrected by a migration after someone deliberately deletes it.
   */
  ensureFavouritesSet(): MacroSet {
    const existing = this.getMacroSet(FAVOURITES_SET_ID)
    if (existing) return existing

    this.db
      .prepare('INSERT INTO macro_sets (id, name, description) VALUES (?, ?, ?)')
      .run(FAVOURITES_SET_ID, FAVOURITES_SET_NAME, 'Buttons you starred. Shown on every connection.')

    return this.getMacroSet(FAVOURITES_SET_ID)!
  }

  /**
   * Copies a button into another set.
   *
   * The copy is a snapshot: steps, fields and guards are duplicated, so editing
   * either afterwards leaves the other alone. That is the behaviour you want
   * for "copy this Cisco button and tweak it for Arista", and it is also what
   * makes a starred favourite safe to edit down to just the bits you use.
   */
  copyMacro(macroId: string, targetSetId: string, name?: string): Macro {
    const source = this.getMacro(macroId)
    if (!source) throw new Error('Button not found')
    if (!this.getMacroSet(targetSetId)) throw new Error('Target button set not found')

    return this.saveMacro({
      ...source,
      id: undefined,
      setId: targetSetId,
      name: name?.trim() || this.freeMacroName(targetSetId, source.name),
      sourceMacroId: source.id,
    })
  }

  /**
   * A name not already used in the target set.
   *
   * Two buttons in one set with the same name are legal but confusing — the
   * panel shows the name and nothing else — so a copy landing beside its
   * original gets "(copy)", while a copy into a different set keeps the name it
   * is known by.
   */
  private freeMacroName(setId: string, name: string): string {
    const taken = (candidate: string) =>
      this.db
        .prepare('SELECT 1 FROM macros WHERE set_id = ? AND name = ?')
        .get(setId, candidate) !== undefined

    if (!taken(name)) return name
    if (!taken(`${name} (copy)`)) return `${name} (copy)`

    let counter = 2
    while (taken(`${name} (copy ${counter})`)) counter++
    return `${name} (copy ${counter})`
  }

  /**
   * Stars or un-stars a button, returning the favourites set so the caller can
   * refresh without a second round trip.
   *
   * Starring an already-starred button removes the favourite rather than making
   * a second copy — the star in the panel is a toggle, and two identical
   * favourites would be indistinguishable.
   */
  toggleFavourite(macroId: string): { favourited: boolean; setId: string } {
    const existing = this.db
      .prepare('SELECT id FROM macros WHERE set_id = ? AND source_macro_id = ?')
      .all(FAVOURITES_SET_ID, macroId) as Array<{ id: string }>

    if (existing.length > 0) {
      const remove = this.db.prepare('DELETE FROM macros WHERE id = ?')
      this.db.transaction(() => existing.forEach((row) => remove.run(row.id)))()
      return { favourited: false, setId: FAVOURITES_SET_ID }
    }

    this.ensureFavouritesSet()
    this.copyMacro(macroId, FAVOURITES_SET_ID)
    return { favourited: true, setId: FAVOURITES_SET_ID }
  }

  // Audit log operations
  logAudit(log: Omit<AuditLog, 'id' | 'timestamp'>): void {
    // The label is denormalised on purpose: the connection it names can be
    // deleted later, and an entry reading "unknown host" would be useless.
    const label = log.profileLabel ?? this.describeProfile(log.profileId)

    this.db.prepare(`
      INSERT INTO audit_logs
      (user_machine, session_id, profile_id, profile_label, macro_id, macro_name, commands_json, result, stdout_snippet, stderr_snippet)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.userMachine, log.sessionId, log.profileId ?? null, label, log.macroId, log.macroName,
      JSON.stringify(log.commands), log.result, log.stdoutSnippet, log.stderrSnippet
    )
  }

  /** "name (user@host:port)" — how a connection is named in the audit log. */
  private describeProfile(profileId: string | undefined): string | null {
    if (!profileId) return null
    const profile = this.getProfile(profileId)
    if (!profile) return null

    return profile.transport === 'serial'
      ? `${profile.name} (${profile.serialPath})`
      : `${profile.name} (${profile.username}@${profile.host}:${profile.port})`
  }

  queryLogs(filter: LogFilter): AuditLog[] {
    let query = `
      SELECT id, timestamp, user_machine as userMachine, session_id as sessionId,
             profile_id as profileId, profile_label as profileLabel,
             macro_id as macroId, macro_name as macroName,
             commands_json, result, stdout_snippet as stdoutSnippet, stderr_snippet as stderrSnippet
      FROM audit_logs WHERE 1=1
    `
    const params: any[] = []

    if (filter.startDate) {
      query += ' AND timestamp >= ?'
      params.push(filter.startDate)
    }
    if (filter.endDate) {
      query += ' AND timestamp <= ?'
      params.push(filter.endDate)
    }
    if (filter.profileId) {
      query += ' AND profile_id = ?'
      params.push(filter.profileId)
    }
    if (filter.result) {
      query += ' AND result = ?'
      params.push(filter.result)
    }
    if (filter.searchText) {
      query += ' AND (commands_json LIKE ? OR stdout_snippet LIKE ? OR stderr_snippet LIKE ?)'
      params.push(`%${filter.searchText}%`, `%${filter.searchText}%`, `%${filter.searchText}%`)
    }

    query += ' ORDER BY timestamp DESC LIMIT 1000'

    return this.db.prepare(query).all(...params).map((row: any) => ({
      ...row,
      commands: JSON.parse(row.commands_json)
    })) as AuditLog[]
  }

  // Settings operations
  getSetting(key: keyof Settings): any {
    const row = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as any
    return row ? JSON.parse(row.value_json) : null
  }

  setSetting(key: keyof Settings, value: any): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)
    `).run(key, JSON.stringify(value))
  }

  getAllSettings(): Partial<Settings> {
    const rows = this.db.prepare('SELECT key, value_json FROM settings').all() as any[]
    const settings: any = {}
    for (const row of rows) {
      settings[row.key] = JSON.parse(row.value_json)
    }
    return settings
  }

  close(): void {
    this.db.close()
  }
}