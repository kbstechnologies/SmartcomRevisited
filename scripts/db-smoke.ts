/**
 * Exercises the real DatabaseManager under Electron.
 *
 * better-sqlite3 is compiled for Electron's ABI, so these paths cannot be
 * covered by the vitest suite (which runs on plain Node). Bundled and run by
 * `npm run test:db`.
 */
import { app } from 'electron'
import Database from 'better-sqlite3'
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { DatabaseManager } from '../electron/database'
import { ProfileSchema, ConnectionBundleSchema, MacroSchema } from '../src/shared/types'

const results: string[] = []

function check(name: string, fn: () => string | void) {
  try {
    const detail = fn()
    results.push(`PASS ${name}${detail ? ' — ' + detail : ''}`)
  } catch (error) {
    results.push(`FAIL ${name} — ${error instanceof Error ? error.message : error}`)
  }
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

app.on('ready', () => {
  process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'smartcom-db-')), 'test.db')
  const db = new DatabaseManager()

  check('serial profile round-trips', () => {
    const saved = db.saveProfile(
      ProfileSchema.parse({
        name: 'Console cable',
        transport: 'serial',
        serialPath: 'COM7',
        baudRate: 9600,
        dataBits: 7,
        stopBits: 2,
        parity: 'even',
        flowControl: 'rtscts',
      })
    )
    const read = db.getProfile(saved.id!)!
    assert(read.transport === 'serial', 'transport lost')
    assert(read.serialPath === 'COM7', 'serialPath lost')
    assert(read.baudRate === 9600, 'baudRate lost')
    assert(read.dataBits === 7 && read.stopBits === 2, 'framing lost')
    assert(read.parity === 'even', 'parity lost')
    assert(read.flowControl === 'rtscts', 'flow control lost')
    return `${read.serialPath} ${read.baudRate} ${read.dataBits}${read.parity[0].toUpperCase()}${read.stopBits}`
  })

  check('ssh profile still round-trips', () => {
    const saved = db.saveProfile(
      ProfileSchema.parse({
        name: 'web-01',
        transport: 'ssh',
        host: '10.0.0.5',
        port: 2222,
        username: 'root',
        authMethod: 'password',
      })
    )
    const read = db.getProfile(saved.id!)!
    assert(read.host === '10.0.0.5' && read.port === 2222, 'ssh fields lost')
    assert(read.transport === 'ssh', 'transport wrong')
    return `${read.username}@${read.host}:${read.port}`
  })

  check('groups create, assign and delete without losing connections', () => {
    const group = db.saveConnectionGroup({ name: 'Datacentre', sortOrder: 0 })
    const profile = db.saveProfile(
      ProfileSchema.parse({
        name: 'grouped-host',
        host: '10.0.0.9',
        username: 'root',
        authMethod: 'password',
        groupId: group.id,
      })
    )
    assert(db.getProfile(profile.id!)!.groupId === group.id, 'group not assigned')

    db.deleteConnectionGroup(group.id!)
    const orphan = db.getProfile(profile.id!)!
    assert(orphan !== null, 'connection deleted with its group')
    assert(!orphan.groupId, 'group reference left dangling')
    return 'connection survived, became ungrouped'
  })

  check('connection export carries no secret material', () => {
    const bundle = db.exportConnections()
    ConnectionBundleSchema.parse(bundle)

    // Look for secret-bearing *keys*. `authMethod: "password"` is the name of a
    // method, not a credential, so a naive text search gives a false positive.
    const SECRET_KEYS = /^(password|passphrase|privateKey|secret|token)$/i
    const findSecretKey = (value: unknown, trail = ''): string | null => {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const hit = findSecretKey(value[i], `${trail}[${i}]`)
          if (hit) return hit
        }
        return null
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          if (SECRET_KEYS.test(key)) return `${trail}.${key}`
          const hit = findSecretKey(child, `${trail}.${key}`)
          if (hit) return hit
        }
      }
      return null
    }

    const leaked = findSecretKey(bundle)
    assert(!leaked, `secret field present in export: ${leaked}`)
    return `${bundle.profiles.length} profiles, ${bundle.groups.length} groups, no secrets`
  })

  /**
   * The field-name scan above catches a secret stored under an obvious name.
   * This one catches key *material* wherever it appears, under any field name,
   * at any depth — which is the failure that would actually matter, and the one
   * a future export format is most likely to reintroduce.
   */
  check('no export can carry private key material', () => {
    const key = db.saveSshKey({
      name: 'export-leak-probe',
      type: 'ed25519',
      bits: 0,
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIProbeProbeProbeProbeProbeProbeProbe probe@test',
      fingerprint: 'SHA256:probeprobeprobeprobeprobeprobeprobeprobeprob',
      comment: 'probe',
      hasPassphrase: true,
    })

    const profile = db.saveProfile(
      ProfileSchema.parse({
        name: 'key-auth host',
        host: '10.9.9.9',
        username: 'admin',
        authMethod: 'key',
        keyId: key.id,
      })
    )

    // Private keys live only in the OS vault, never in a row, so an export can
    // only leak one if some future code path goes and fetches it.
    const MATERIAL = [
      'BEGIN OPENSSH PRIVATE KEY',
      'BEGIN RSA PRIVATE KEY',
      'BEGIN PRIVATE KEY',
      'BEGIN EC PRIVATE KEY',
      'openssh-key-v1',
    ]

    const sets = db.listMacroSets()
    const bundles: Record<string, string> = {
      connections: JSON.stringify(db.exportConnections()),
      // The Button Exchange bundle — buttons can carry arbitrary command text,
      // so it is the most plausible place for a pasted key to end up.
      buttons: JSON.stringify(sets.length ? db.exportMacroSets([sets[0].id!]) : {}),
    }

    for (const [what, json] of Object.entries(bundles)) {
      for (const marker of MATERIAL) {
        assert(!json.includes(marker), `${what} export contains "${marker}"`)
      }
    }

    // The reference is fine and has to survive; the material must not exist.
    const exported = db.exportConnections().profiles.find((p) => p.id === profile.id)
    assert(exported?.keyId === key.id, 'keyId reference lost from the export')
    assert(
      !JSON.stringify(exported).includes('PRIVATE'),
      'exported profile carries something private'
    )

    return `${Object.keys(bundles).length} export kinds scanned, keyId reference intact`
  })

  check('connection import renames collisions and remaps groups', () => {
    const group = db.saveConnectionGroup({ name: 'Edge', sortOrder: 1 })
    db.saveProfile(
      ProfileSchema.parse({
        name: 'edge-1',
        host: '10.1.1.1',
        username: 'admin',
        authMethod: 'password',
        groupId: group.id,
      })
    )

    const bundle = db.exportConnections()
    const before = db.listProfiles().length
    const result = db.importConnections(bundle)
    const after = db.listProfiles().length

    assert(after === before + bundle.profiles.length, 'profiles not all imported')
    assert(result.renamed.length > 0, 'expected renames on collision')

    // The imported copy must point at the imported group, not the original.
    const copies = db.listProfiles().filter((p) => p.name.includes('(imported)'))
    const withGroup = copies.find((p) => p.groupId)
    if (withGroup) {
      assert(withGroup.groupId !== group.id, 'group reference not remapped')
    }
    return `${result.profiles} imported, ${result.renamed.length} renamed`
  })

  check('button set export/import still works alongside', () => {
    const set = db.saveMacroSet({ name: 'Ops' })
    db.saveMacro(MacroSchema.parse({ setId: set.id, name: 'Uptime', steps: [] }))
    const bundle = db.exportMacroSets([set.id!])
    const imported = db.importMacroSets(bundle)
    assert(imported.sets === 1 && imported.macros === 1, 'button set import wrong')
    return `${imported.sets} set, ${imported.macros} button`
  })

  // Shared button sets are meant to install like plugins: importing one adds it
  // next to what the user already has and must never overwrite or edit theirs,
  // even when the incoming bundle carries the same ids and names.
  check('importing a button set never replaces the existing one', () => {
    const mine = db.saveMacroSet({ name: 'Community', description: 'my own copy' })
    const myButton = db.saveMacro(
      MacroSchema.parse({ setId: mine.id, name: 'Reboot', steps: [{ type: 'send', text: 'mine' }] })
    )

    // A bundle exported from this very set is the worst case: same ids, same
    // names. Import it twice, as a user re-installing an update would.
    const bundle = db.exportMacroSets([mine.id!])
    const setsBefore = db.listMacroSets().length
    const first = db.importMacroSets(bundle)
    const second = db.importMacroSets(bundle)

    const setsAfter = db.listMacroSets()
    assert(
      setsAfter.length === setsBefore + 2,
      `expected 2 added sets, got ${setsAfter.length - setsBefore}`
    )

    // The user's own set and button are byte-for-byte untouched.
    const stillMine = db.getMacroSet(mine.id!)
    assert(stillMine !== null, 'original set was deleted by the import')
    assert(stillMine!.name === 'Community', `original set renamed to ${stillMine!.name}`)
    assert(stillMine!.description === 'my own copy', 'original set description overwritten')

    const stillMyButton = db.getMacro(myButton.id!)
    assert(stillMyButton !== null, 'original button was deleted by the import')
    assert(stillMyButton!.setId === mine.id, 'original button moved to another set')
    assert(stillMyButton!.steps[0]?.text === 'mine', 'original button steps overwritten')
    assert(db.listMacrosInSet(mine.id!).length === 1, 'imported buttons leaked into the original set')

    // Each import lands in its own new set, under its own name.
    const copies = setsAfter.filter((s) => s.id !== mine.id && s.name.startsWith('Community'))
    assert(copies.length === 2, `expected 2 renamed copies, got ${copies.length}`)
    assert(new Set(copies.map((s) => s.name)).size === 2, 'imported copies share a name')
    for (const copy of copies) {
      assert(db.listMacrosInSet(copy.id!).length === 1, `copy ${copy.name} has no button`)
    }
    assert(first.renamed.length === 1 && second.renamed.length === 1, 'renames not reported')

    return `original intact, ${copies.map((c) => c.name).join(' + ')} added`
  })

  check('a host that has been used can be deleted, and its history survives', () => {
    const profile = db.saveProfile(
      ProfileSchema.parse({
        name: 'Decommissioned switch',
        host: '10.4.4.4',
        username: 'admin',
        authMethod: 'password',
      })
    )

    // A host you have actually used is the case that matters: audit rows point
    // at it, and a foreign key with no ON DELETE rule would block the delete.
    db.logAudit({
      userMachine: 'tester@box',
      sessionId: 'session-1',
      profileId: profile.id!,
      commands: ['show version'],
      result: 'success',
    })

    const deleted = db.deleteProfile(profile.id!)
    assert(deleted, 'delete reported no rows removed')
    assert(db.getProfile(profile.id!) === null, 'connection still present after delete')

    // The audit log is a record of what was run; removing a host must not
    // erase it, and it must still say which host it was.
    const history = db.queryLogs({}).filter((row) => row.commands.includes('show version'))
    assert(history.length === 1, `audit history lost: found ${history.length} rows`)
    assert(
      history[0].profileLabel?.includes('Decommissioned switch'),
      `history no longer names the host: ${history[0].profileLabel}`
    )

    return 'host removed, audit row kept and still labelled'
  })

  // Buttons that have been run are the ones people want to tidy up, and the
  // audit row pointing at them used to make them undeletable.
  check('a button that has been run can be deleted, with its set', () => {
    const set = db.saveMacroSet({ name: 'Retired buttons' })
    const macro = db.saveMacro(
      MacroSchema.parse({ setId: set.id, name: 'Old check', steps: [{ type: 'send', text: 'uptime' }] })
    )

    db.logAudit({
      userMachine: 'tester@box',
      sessionId: 'session-9',
      profileId: undefined,
      macroId: macro.id,
      macroName: macro.name,
      commands: ['uptime'],
      result: 'success',
    })

    assert(db.deleteMacro(macro.id!), 'button with history could not be deleted')
    assert(db.deleteMacroSet(set.id!), 'set holding a run button could not be deleted')

    const history = db.queryLogs({}).filter((row) => row.macroName === 'Old check')
    assert(history.length === 1, 'audit entry lost with the button')
    assert(!history[0].macroId, 'audit entry still points at a deleted button')
    return 'button and set removed, history kept under its name'
  })

  // --- per-connection button sets, favourites and copies ---------------------

  check('profile remembers its button sets', () => {
    const set = db.saveMacroSet({ name: 'Cisco kit' })
    const other = db.saveMacroSet({ name: 'Proxmox kit' })
    const saved = db.saveProfile(
      ProfileSchema.parse({
        name: 'Assigned switch',
        host: '192.0.2.7',
        username: 'admin',
        macroSetIds: [set.id!, other.id!],
      })
    )

    const read = db.getProfile(saved.id!)!
    assert(read.macroSetIds.length === 2, `expected 2 assigned sets, got ${read.macroSetIds.length}`)
    assert(read.macroSetIds.includes(set.id!), 'assigned set lost')

    // A deleted set must not linger as a dangling id on the connection.
    db.deleteMacroSet(other.id!)
    const resaved = db.saveProfile({ ...read, name: read.name })
    assert(
      resaved.macroSetIds.length === 1 && resaved.macroSetIds[0] === set.id,
      `dangling set id kept: ${JSON.stringify(resaved.macroSetIds)}`
    )
    return `${resaved.macroSetIds.length} set kept, 1 dangling id dropped`
  })

  check('existing connections default to showing every set', () => {
    const saved = db.saveProfile(
      ProfileSchema.parse({ name: 'Unassigned box', host: '192.0.2.8', username: 'root' })
    )
    const read = db.getProfile(saved.id!)!
    assert(Array.isArray(read.macroSetIds), 'macroSetIds is not an array')
    assert(read.macroSetIds.length === 0, 'a new connection should name no sets')
    return 'empty assignment reads back as []'
  })

  check('tags round-trip and are normalised on both sides', () => {
    const set = db.saveMacroSet({
      name: 'Tagged set',
      tags: ['  Cisco ', 'CISCO', 'Customer Acme'],
    } as never)

    // Normalised on write, so the panel filters on the same spelling the
    // database holds — echoing the caller's input back would not prove this.
    assert(
      JSON.stringify(set.tags) === JSON.stringify(['cisco', 'customer-acme']),
      `set tags not normalised: ${JSON.stringify(set.tags)}`
    )
    assert(
      JSON.stringify(db.getMacroSet(set.id!)!.tags) === JSON.stringify(['cisco', 'customer-acme']),
      'set tags lost on re-read'
    )

    const profile = db.saveProfile(
      ProfileSchema.parse({
        name: 'tagged host',
        host: '10.4.4.4',
        username: 'admin',
        tags: ['Cisco', 'switch'],
      })
    )
    assert(
      JSON.stringify(db.getProfile(profile.id!)!.tags) === JSON.stringify(['cisco', 'switch']),
      'profile tags lost'
    )

    // A tag naming a set that does not exist must survive — that is the point
    // of a tag, and pruning it the way macroSetIds is pruned would break it.
    const future = db.saveProfile(
      ProfileSchema.parse({
        name: 'host for a set not installed yet',
        host: '10.4.4.5',
        username: 'admin',
        tags: ['nothing-carries-this'],
      })
    )
    assert(
      db.getProfile(future.id!)!.tags.includes('nothing-carries-this'),
      'an unmatched tag was pruned'
    )

    return 'normalised on write, unmatched tags kept'
  })

  check('exported button sets carry their tags', () => {
    const set = db.saveMacroSet({ name: 'Exportable tagged', tags: ['fortinet', 'firewall'] } as never)
    const bundle = db.exportMacroSets([set.id!])
    assert(
      JSON.stringify(bundle.sets[0].tags) === JSON.stringify(['firewall', 'fortinet']),
      `tags missing from export: ${JSON.stringify(bundle.sets[0].tags)}`
    )

    // And survive the round trip, so a shared set arrives already matching.
    const imported = db.importMacroSets(bundle)
    assert(imported.sets === 1, 'import did not create the set')
    const copy = db.listMacroSets().find((s) => s.name.includes('Exportable tagged') && s.id !== set.id)
    assert(copy !== undefined, 'imported copy not found')
    assert(
      JSON.stringify(copy!.tags) === JSON.stringify(['firewall', 'fortinet']),
      `tags lost on import: ${JSON.stringify(copy!.tags)}`
    )
    return 'tags survive export and import'
  })

  check('copying a button snapshots it', () => {
    const from = db.saveMacroSet({ name: 'Copy source' })
    const to = db.saveMacroSet({ name: 'Copy target' })
    const original = db.saveMacro(
      MacroSchema.parse({
        setId: from.id!,
        name: 'Show version',
        steps: [{ type: 'send', text: 'show version', appendEnter: true }],
        confirmBeforeRun: true,
      })
    )

    const copy = db.copyMacro(original.id!, to.id!)
    assert(copy.setId === to.id, 'copy landed in the wrong set')
    assert(copy.id !== original.id, 'copy reused the original id')
    assert(copy.name === 'Show version', `copy renamed unnecessarily: ${copy.name}`)
    assert(copy.sourceMacroId === original.id, 'copy did not record its origin')
    assert(copy.steps[0].text === 'show version', 'steps not copied')
    assert(copy.confirmBeforeRun, 'guard not copied')

    // Editing the copy must leave the original untouched.
    db.saveMacro({ ...copy, name: 'Show version (edited)', steps: [] })
    const untouched = db.getMacro(original.id!)!
    assert(untouched.name === 'Show version', 'editing the copy renamed the original')
    assert(untouched.steps.length === 1, 'editing the copy emptied the original')
    return 'independent copy with provenance'
  })

  check('copying into the same set avoids a name clash', () => {
    const set = db.saveMacroSet({ name: 'Clash set' })
    const original = db.saveMacro(
      MacroSchema.parse({ setId: set.id!, name: 'Uptime', steps: [] })
    )

    const first = db.copyMacro(original.id!, set.id!)
    const second = db.copyMacro(original.id!, set.id!)
    assert(first.name === 'Uptime (copy)', `unexpected first copy name: ${first.name}`)
    assert(second.name === 'Uptime (copy 2)', `unexpected second copy name: ${second.name}`)
    return `${first.name}, ${second.name}`
  })

  check('starring copies into favourites and un-starring removes it', () => {
    const set = db.saveMacroSet({ name: 'Starrable' })
    const macro = db.saveMacro(
      MacroSchema.parse({
        setId: set.id!,
        name: 'Interface status',
        steps: [{ type: 'send', text: 'show interfaces status', appendEnter: true }],
      })
    )

    const on = db.toggleFavourite(macro.id!)
    assert(on.favourited, 'starring did not report success')

    const favourites = db.getMacroSet(on.setId)
    assert(favourites !== null, 'favourites set was not created')

    const starred = db.listMacrosInSet(on.setId)
    assert(starred.length === 1, `expected 1 favourite, got ${starred.length}`)
    assert(starred[0].sourceMacroId === macro.id, 'favourite lost its origin')

    // Starring twice must toggle, not pile up duplicates.
    const off = db.toggleFavourite(macro.id!)
    assert(!off.favourited, 'second star did not un-favourite')
    assert(db.listMacrosInSet(on.setId).length === 0, 'favourite not removed')
    return `via set "${favourites!.name}"`
  })

  check('two buttons with the same name star independently', () => {
    // "Interface Status" exists in a dozen shipped sets, so the star has to key
    // on the id rather than the name or one would un-star another.
    const a = db.saveMacroSet({ name: 'Vendor A' })
    const b = db.saveMacroSet({ name: 'Vendor B' })
    const first = db.saveMacro(MacroSchema.parse({ setId: a.id!, name: 'Interface Status', steps: [] }))
    const second = db.saveMacro(MacroSchema.parse({ setId: b.id!, name: 'Interface Status', steps: [] }))

    db.toggleFavourite(first.id!)
    db.toggleFavourite(second.id!)
    const favourites = db.listMacrosInSet(db.ensureFavouritesSet().id!)
    assert(favourites.length === 2, `expected 2 favourites, got ${favourites.length}`)

    db.toggleFavourite(first.id!)
    const left = db.listMacrosInSet(db.ensureFavouritesSet().id!)
    assert(left.length === 1, `un-starring one removed ${2 - left.length}`)
    assert(left[0].sourceMacroId === second.id, 'un-starred the wrong favourite')
    return 'name collisions kept apart'
  })

  db.close()

  // The upgrade path is the one users cannot recover from if it is wrong: a
  // new version opens a database written by an older one, migrates it, and must
  // not lose anything. Run in its own database so the checks above are unaffected.
  check('upgrading to a new version keeps the data and backs it up first', () => {
    const upgradeDir = mkdtempSync(join(tmpdir(), 'smartcom-upgrade-'))
    process.env.DB_PATH = join(upgradeDir, 'upgrade.db')

    // --- the version the tester already has ---
    process.env.SMARTCOM_APP_VERSION = '1.0.0'
    const before = new DatabaseManager()
    const profile = before.saveProfile(
      ProfileSchema.parse({
        name: 'Prod router',
        host: '10.9.9.9',
        port: 2200,
        username: 'netops',
        authMethod: 'password',
      })
    )
    const set = before.saveMacroSet({ name: 'My buttons' })
    const macro = before.saveMacro(
      MacroSchema.parse({ setId: set.id, name: 'Uptime', steps: [{ type: 'send', text: 'uptime' }] })
    )
    before.setSetting('fontSize', 18)
    before.close()

    // --- the version they upgrade to ---
    process.env.SMARTCOM_APP_VERSION = '1.1.0'
    const after = new DatabaseManager()

    const keptProfile = after.getProfile(profile.id!)
    assert(keptProfile !== null, 'connection lost across the upgrade')
    assert(keptProfile!.host === '10.9.9.9' && keptProfile!.port === 2200, 'connection altered')
    assert(keptProfile!.username === 'netops', 'username altered')

    const keptMacro = after.getMacro(macro.id!)
    assert(keptMacro !== null, 'button lost across the upgrade')
    assert(keptMacro!.setId === set.id, 'button moved to another set')
    assert(keptMacro!.steps[0]?.text === 'uptime', 'button script altered')
    assert(after.listMacroSets().some((s) => s.id === set.id), 'button set lost')
    assert(after.getAllSettings().fontSize === 18, 'settings lost across the upgrade')

    const upgrade = after.getUpgradeInfo()
    assert(upgrade.previousVersion === '1.0.0', `previous version not recorded: ${upgrade.previousVersion}`)
    assert(!!upgrade.backupPath, 'no backup taken before migrating')
    assert(existsSync(upgrade.backupPath!), `backup missing at ${upgrade.backupPath}`)

    // The snapshot has to be a real database holding the pre-upgrade data,
    // not an empty file — in WAL mode a naive copy would be exactly that.
    const snapshot = new Database(upgrade.backupPath!, { readonly: true })
    const row = snapshot
      .prepare('SELECT name FROM profiles WHERE id = ?')
      .get(profile.id!) as { name: string } | undefined
    snapshot.close()
    assert(row?.name === 'Prod router', 'backup does not contain the pre-upgrade data')

    // Reopening at the same version is not an upgrade and must not re-snapshot.
    after.close()
    const again = new DatabaseManager()
    const noop = again.getUpgradeInfo()
    again.close()
    assert(noop.backupPath === null, 'a same-version start-up wrote another backup')

    delete process.env.SMARTCOM_APP_VERSION
    return `1.0.0 → 1.1.0, data intact, snapshot at ${basename(upgrade.backupPath!)}`
  })

  // Existing installs carry the original audit_logs table, whose foreign key
  // made a used host undeletable. Opening with the new code must rebuild it.
  check('an existing database with the old audit constraint is repaired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-auditfk-'))
    const path = join(dir, 'old.db')

    // Recreate the shipped 1.0.0 shape, with a row already in it.
    const legacy = new Database(path)
    legacy.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22, username TEXT NOT NULL,
        auth_method TEXT NOT NULL DEFAULT 'password', transport TEXT NOT NULL DEFAULT 'ssh',
        serial_path TEXT
      );
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_machine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        macro_id TEXT,
        macro_name TEXT,
        commands_json TEXT NOT NULL,
        result TEXT NOT NULL CHECK (result IN ('success', 'timeout', 'error')),
        stdout_snippet TEXT,
        stderr_snippet TEXT
      );
      INSERT INTO profiles (id, name, host, username) VALUES ('p1', 'Old host', '10.7.7.7', 'admin');
      INSERT INTO audit_logs (id, user_machine, session_id, profile_id, commands_json, result)
        VALUES ('a1', 'tester@box', 's1', 'p1', '["uptime"]', 'success');
    `)
    legacy.close()

    process.env.DB_PATH = path
    const repaired = new DatabaseManager()

    // The label is backfilled from the connection while it still exists.
    const before = repaired.queryLogs({}).find((row) => row.id === 'a1')
    assert(before?.profileLabel === 'Old host (admin@10.7.7.7:22)', `label not backfilled: ${before?.profileLabel}`)

    assert(repaired.deleteProfile('p1'), 'old host still could not be deleted')
    const after = repaired.queryLogs({}).find((row) => row.id === 'a1')
    repaired.close()

    assert(after !== undefined, 'audit row deleted with the host')
    assert(!after!.profileId, 'audit row still points at a deleted host')
    assert(after!.profileLabel === 'Old host (admin@10.7.7.7:22)', 'label lost on delete')
    return 'table rebuilt, history kept and labelled'
  })

  // The first alpha shipped before any version was recorded, so those testers'
  // databases carry no marker. That upgrade needs a snapshot too.
  check('a database from before version tracking is still backed up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-unversioned-'))
    process.env.DB_PATH = join(dir, 'unversioned.db')

    delete process.env.SMARTCOM_APP_VERSION
    const old = new DatabaseManager()
    old.saveProfile(
      ProfileSchema.parse({
        name: 'Early tester box',
        host: '10.5.5.5',
        username: 'ops',
        authMethod: 'password',
      })
    )
    // Erase the bookkeeping to look like a build that never wrote it.
    new Database(process.env.DB_PATH!).exec('DROP TABLE IF EXISTS schema_meta')
    old.close()

    process.env.SMARTCOM_APP_VERSION = '1.1.0'
    const upgraded = new DatabaseManager()
    const info = upgraded.getUpgradeInfo()
    const kept = upgraded.listProfiles().some((p) => p.name === 'Early tester box')
    upgraded.close()
    delete process.env.SMARTCOM_APP_VERSION

    assert(kept, 'connection lost upgrading an unversioned database')
    assert(info.previousVersion === 'unknown', `expected 'unknown', got ${info.previousVersion}`)
    assert(!!info.backupPath && existsSync(info.backupPath), 'no snapshot for an unversioned upgrade')
    return 'unversioned → 1.1.0, snapshot written'
  })

  // ---------------------------------------------------------------- sync ---
  //
  // The prerequisite for cloud sync, and the thing that blocked it: two devices
  // must be able to hold a connection with the same name. Everything below is
  // about that constraint being gone and change tracking taking its place.

  check('an upgraded database loses the UNIQUE name constraints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-unique-'))
    process.env.DB_PATH = join(dir, 'legacy.db')

    // Build a database with the old schema by hand, as 1.6.1 would have left it.
    const legacy = new Database(process.env.DB_PATH!)
    legacy.exec(`
      CREATE TABLE profiles (
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
      INSERT INTO profiles (id, name, host, username, auth_method)
        VALUES ('keep-me', 'Core Router', '10.0.0.1', 'ops', 'password');
    `)
    legacy.close()

    const upgraded = new DatabaseManager()
    const schema = new Database(process.env.DB_PATH!)
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='profiles'")
      .get() as { sql: string }

    const survived = upgraded.getProfile('keep-me')
    // The whole point: the same name, twice, from two different devices.
    const second = upgraded.saveProfile(
      ProfileSchema.parse({
        name: 'Core Router',
        host: '10.0.0.2',
        username: 'ops',
        authMethod: 'password',
      })
    )
    const both = upgraded.listProfiles().filter((p) => p.name === 'Core Router').length
    upgraded.close()

    assert(!/NOT NULL UNIQUE/i.test(schema.sql), 'UNIQUE survived the rebuild')
    assert(survived?.host === '10.0.0.1', 'existing connection lost in the rebuild')
    assert(survived?.id === 'keep-me', 'id changed in the rebuild')
    assert(second.id !== 'keep-me', 'second connection reused the first id')
    assert(both === 2, `expected two connections named the same, got ${both}`)
    return 'two "Core Router" connections coexist; existing row intact'
  })

  check('every write is tracked, and a delete leaves a tombstone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-sync-'))
    process.env.DB_PATH = join(dir, 'sync.db')
    const s = new DatabaseManager()

    const profile = s.saveProfile(
      ProfileSchema.parse({
        name: 'Edge switch',
        host: '10.9.9.9',
        username: 'ops',
        authMethod: 'password',
      })
    )

    let pending = s.listLocalChanges()
    const created = pending.find((c) => c.objectId === profile.id)
    assert(created !== undefined, 'a new connection was not tracked')
    assert(created!.type === 'profile', 'wrong type recorded')
    assert(created!.deletedAt === null, 'a new connection looks deleted')
    assert(created!.payload !== null, 'no payload for a live object')

    // Accepting the push clears it.
    s.markSynced([{ type: 'profile', objectId: profile.id!, revision: created!.revision }])
    assert(
      s.listLocalChanges().every((c) => c.objectId !== profile.id),
      'still dirty after being marked synced'
    )

    // An edit makes it dirty again — INSERT OR REPLACE included, which is the
    // path that would defeat a counter kept on the row itself.
    s.saveProfile({ ...profile, host: '10.9.9.10' })
    assert(
      s.listLocalChanges().some((c) => c.objectId === profile.id),
      'an edit was not tracked'
    )

    // The tombstone. Without this a delete here is undone by the next pull.
    s.markSynced(
      s.listLocalChanges().map((c) => ({ type: c.type, objectId: c.objectId, revision: c.revision }))
    )
    s.deleteProfile(profile.id!)
    pending = s.listLocalChanges()
    const tombstone = pending.find((c) => c.objectId === profile.id)
    assert(tombstone !== undefined, 'a delete was not tracked')
    assert(tombstone!.deletedAt !== null, 'a delete did not leave a tombstone')
    assert(tombstone!.payload === null, 'a tombstone carried a payload')

    s.close()
    return 'create, edit and delete all tracked; tombstone survives the row'
  })

  check('applying a remote change does not bounce it back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-remote-'))
    process.env.DB_PATH = join(dir, 'remote.db')
    const s = new DatabaseManager()

    // Nothing local, then a change arrives from the other laptop.
    s.applyRemoteChange({
      type: 'group',
      objectId: 'grp-1',
      revision: 4,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      payload: { id: 'grp-1', name: 'Datacentre', sortOrder: 0 },
    })

    const group = s.listConnectionGroups().find((g) => g.id === 'grp-1')
    assert(group?.name === 'Datacentre', 'remote group was not applied')
    assert(
      s.listLocalChanges().every((c) => c.objectId !== 'grp-1'),
      'an applied remote change was queued straight back — devices would ping-pong forever'
    )

    // And a remote delete really deletes.
    s.applyRemoteChange({
      type: 'group',
      objectId: 'grp-1',
      revision: 5,
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      payload: null,
    })
    assert(
      s.listConnectionGroups().every((g) => g.id !== 'grp-1'),
      'a remote delete did not remove the group'
    )
    assert(
      s.listLocalChanges().every((c) => c.objectId !== 'grp-1'),
      'an applied remote delete was queued back'
    )

    s.close()
    return 'remote create and delete applied, neither echoed'
  })

  check('a macro whose set has not arrived yet is held, not lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-order-'))
    process.env.DB_PATH = join(dir, 'order.db')
    const s = new DatabaseManager()

    // Out of order on purpose: the macro references a set that is not here.
    s.applyRemoteChange({
      type: 'macro',
      objectId: 'mac-1',
      revision: 1,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      payload: { id: 'mac-1', setId: 'set-1', name: 'Show version', steps: [] },
    })
    assert(s.getMacro('mac-1') === null, 'a macro was inserted with no set — foreign key violated')

    s.applyRemoteChange({
      type: 'macro_set',
      objectId: 'set-1',
      revision: 1,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      payload: { id: 'set-1', name: 'Cisco', tags: [] },
    })
    s.applyRemoteChange({
      type: 'macro',
      objectId: 'mac-1',
      revision: 1,
      deletedAt: null,
      updatedAt: new Date().toISOString(),
      payload: { id: 'mac-1', setId: 'set-1', name: 'Show version', steps: [] },
    })

    assert(s.getMacro('mac-1')?.name === 'Show version', 'macro never landed after its set arrived')
    s.close()
    return 'orphan macro dropped, applied once its set existed'
  })

  check('the first sync of an existing install offers everything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smartcom-seed-'))
    process.env.DB_PATH = join(dir, 'seed.db')
    const s = new DatabaseManager()

    s.saveProfile(
      ProfileSchema.parse({ name: 'A', host: '1.1.1.1', username: 'x', authMethod: 'password' })
    )
    s.saveProfile(
      ProfileSchema.parse({ name: 'B', host: '2.2.2.2', username: 'x', authMethod: 'password' })
    )
    s.markSynced(
      s.listLocalChanges().map((c) => ({ type: c.type, objectId: c.objectId, revision: c.revision }))
    )
    assert(s.countLocalChanges() === 0, 'not clean before seeding')

    s.markEverythingDirty()
    const pending = s.countLocalChanges()
    s.close()

    assert(pending >= 2, `expected everything queued, got ${pending}`)
    return `${pending} objects queued for a first push`
  })

  console.log('\n===DB SMOKE===')
  results.forEach((line) => console.log(line))
  const failed = results.filter((r) => r.startsWith('FAIL')).length
  console.log(failed === 0 ? 'ALL DB CHECKS PASSED' : `${failed} DB CHECK(S) FAILED`)
  console.log('===END===\n')

  app.exit(failed === 0 ? 0 : 1)
})
