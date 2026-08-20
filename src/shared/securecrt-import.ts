/**
 * Reads SecureCRT's own session store.
 *
 * SecureCRT keeps one `.ini` file per session in a folder tree under its Config
 * directory, and the folder tree *is* the session hierarchy — there is no index
 * to consult. Each file is a flat list of typed keys:
 *
 *     S:"Hostname"=10.0.0.1
 *     D:"[SSH2] Port"=00000016
 *     S:"Username"=admin
 *     S:"Protocol Name"=SSH2
 *
 * The prefix is the type: `S:` string, `D:` a DWORD written as **hex**, `B:`
 * boolean. The hex is the part that quietly goes wrong — `00000016` is 22, not
 * 16, and a parser that reads it as decimal produces sessions that look right
 * and connect to the wrong port.
 *
 * Nothing here reads credentials. SecureCRT stores `Password V2` and
 * `Passphrase V2` as encrypted blobs, and this deliberately does not decrypt,
 * import or copy them anywhere — an importer that silently carried passwords
 * across would be moving secrets between credential stores without anyone
 * asking for it.
 */

/** Keys holding secrets. Listed to be skipped explicitly, not by omission. */
const SECRET_KEYS = /password|passphrase|private ?key/i

export interface SecureCrtSession {
  /** Session name, from the filename. */
  name: string
  /** Folder path within the session store, outermost first. */
  folders: string[]
  hostname?: string
  port?: number
  username?: string
  /** As SecureCRT spells it: SSH2, SSH1, Telnet, Serial, RLogin, TAPI, Raw. */
  protocol?: string
  emulation?: string
  /** Serial sessions only. */
  serialPort?: string
  baudRate?: number
}

/**
 * Parses one `.ini`. Unknown keys are ignored rather than rejected — SecureCRT
 * writes dozens of them and the format grows between versions.
 */
export function parseSessionIni(text: string, name: string, folders: string[] = []): SecureCrtSession {
  const session: SecureCrtSession = { name, folders }

  // The files are UTF-16 or UTF-8 depending on version; the caller decodes, but
  // a stray BOM still reaches us and would corrupt the first key name. Written
  // as an escape rather than the character itself — a literal BOM in source is
  // invisible, and lint rightly refuses it.
  for (const rawLine of text.replace(new RegExp('^' + String.fromCharCode(0xfeff)), '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue

    // S:"Key"=value — the type prefix, a quoted key, then everything after the
    // first `=`, which may itself contain `=` (base64 blobs do).
    const match = line.match(/^([SDBZ]):"([^"]+)"=(.*)$/)
    if (!match) continue

    const [, type, key, value] = match
    if (SECRET_KEYS.test(key)) continue

    const normalised = key.replace(/^\[[^\]]+\]\s*/, '').trim().toLowerCase()

    if (type === 'S') {
      if (normalised === 'hostname') session.hostname = value.trim()
      else if (normalised === 'username') session.username = value.trim()
      else if (normalised === 'protocol name') session.protocol = value.trim()
      else if (normalised === 'emulation') session.emulation = value.trim()
      else if (normalised === 'port') session.serialPort = value.trim()
    } else if (type === 'D') {
      const number = parseHexDword(value)
      if (number === undefined) continue
      // "[SSH2] Port" and "Port" both normalise to "port"; on a serial session
      // the same name is a string holding COM3, handled above.
      if (normalised === 'port') session.port = number
      else if (normalised === 'baud rate') session.baudRate = number
    }
  }

  return session
}

/** SecureCRT writes DWORDs as zero-padded hex. Reading them as decimal is a bug. */
export function parseHexDword(value: string): number | undefined {
  const trimmed = value.trim()
  if (!/^[0-9a-fA-F]+$/.test(trimmed)) return undefined
  const parsed = parseInt(trimmed, 16)
  return Number.isFinite(parsed) ? parsed : undefined
}

export interface ImportCandidate {
  name: string
  /** Folder name for Smartcom, joined from the SecureCRT tree. */
  group?: string
  transport: 'ssh' | 'serial'
  host?: string
  port?: number
  username?: string
  serialPath?: string
  baudRate?: number
}

export interface ImportPlan {
  candidates: ImportCandidate[]
  /** Sessions of a kind this app has no equivalent for. */
  unsupported: Array<{ name: string; reason: string }>
  /** Sessions of a supported kind that are missing something required. */
  skipped: Array<{ name: string; reason: string }>
}

/**
 * Turns parsed sessions into things this app can actually create.
 *
 * Deliberately produces a *plan* rather than importing: the caller shows it,
 * and nothing is written until someone has seen what will land. Importing
 * hundreds of connections is not an action to discover the shape of afterwards.
 */
export function planImport(sessions: SecureCrtSession[]): ImportPlan {
  const candidates: ImportCandidate[] = []
  const unsupported: Array<{ name: string; reason: string }> = []
  const skipped: Array<{ name: string; reason: string }> = []

  for (const session of sessions) {
    // Smartcom's folders are one level, so a nested SecureCRT tree is flattened
    // into a single readable name rather than losing everything but the leaf.
    const group = session.folders.length ? session.folders.join(' / ') : undefined
    const protocol = (session.protocol ?? '').toUpperCase()

    if (protocol === 'SERIAL') {
      if (!session.serialPort) {
        skipped.push({ name: session.name, reason: 'Serial session with no port set' })
        continue
      }
      candidates.push({
        name: session.name,
        group,
        transport: 'serial',
        serialPath: session.serialPort,
        baudRate: session.baudRate,
      })
      continue
    }

    if (protocol && protocol !== 'SSH2' && protocol !== 'SSH1') {
      unsupported.push({
        name: session.name,
        reason: `${session.protocol} session. Smartcom Revisited speaks SSH and serial only.`,
      })
      continue
    }

    if (!session.hostname) {
      skipped.push({ name: session.name, reason: 'No hostname set' })
      continue
    }

    if (protocol === 'SSH1') {
      // SSH1 is broken and no modern server offers it; importing it as SSH2 is
      // the only useful reading, but say so rather than silently changing it.
      unsupported.push({
        name: session.name,
        reason: 'SSH1 session. Import it again as SSH2 if the device really needs it.',
      })
      continue
    }

    candidates.push({
      name: session.name,
      group,
      transport: 'ssh',
      host: session.hostname,
      // SecureCRT omits the port when it is the default.
      port: session.port && session.port > 0 ? session.port : 22,
      username: session.username || undefined,
    })
  }

  return { candidates, unsupported, skipped }
}

/** One-line outcome for the toast after an import. */
export function describeImport(plan: ImportPlan): string {
  const parts = [`${plan.candidates.length} connection${plan.candidates.length === 1 ? '' : 's'}`]
  if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped`)
  if (plan.unsupported.length) parts.push(`${plan.unsupported.length} unsupported`)
  return parts.join(', ')
}

/**
 * Where SecureCRT keeps its sessions, by platform.
 *
 * Offered as a starting point for the folder picker: the path is not obvious,
 * and a user who has to go and find it usually gives up.
 */
export function defaultSessionPaths(platform: NodeJS.Platform, home: string, appData?: string): string[] {
  if (platform === 'win32') {
    const base = appData || `${home}\\AppData\\Roaming`
    return [`${base}\\VanDyke\\Config\\Sessions`]
  }
  if (platform === 'darwin') {
    return [`${home}/Library/Application Support/VanDyke/SecureCRT/Config/Sessions`]
  }
  return [`${home}/.vandyke/SecureCRT/Config/Sessions`]
}
