/**
 * The tldr page model, and the parser that produces it.
 *
 * Pages arrive as the markdown the tldr-pages project publishes. Parsing them
 * happens once, centrally — in the main process when a page is asked for — so
 * the renderer never sees raw markdown and never has to know the format. The
 * parser lives here rather than in `electron/` because the placeholder rules it
 * produces are also what the command builder in the panel applies, and two
 * implementations of "what counts as a placeholder" would drift.
 *
 * Upstream format (tldr-pages client spec v2):
 *
 *     # tcpdump
 *
 *     > Dump traffic on a network.
 *     > More information: <https://www.tcpdump.org/manpages/tcpdump.1.html>.
 *
 *     - Capture the traffic of a specific interface:
 *
 *     `sudo tcpdump {{[-i|--interface]}} {{eth0}}`
 *
 * Content is CC-BY-4.0; see docs/TLDR_INTEGRATION.md for the attribution that
 * ships with the app.
 */

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/**
 * Page directories in the upstream archive. These are directory names, not our
 * invention — `osx` really is spelled `osx`, and `cisco-ios` really does exist,
 * which is why a switch session gets device documentation rather than Linux's.
 */
export const TLDR_PLATFORMS = [
  'common',
  'linux',
  'osx',
  'windows',
  'android',
  'freebsd',
  'netbsd',
  'openbsd',
  'sunos',
  'dos',
  'cisco-ios',
] as const

export type TldrPlatform = (typeof TLDR_PLATFORMS)[number]

export const isTldrPlatform = (value: string): value is TldrPlatform =>
  (TLDR_PLATFORMS as readonly string[]).includes(value)

/**
 * What a session's platform means for lookup, in preference order.
 *
 * Always ends in `common`, which is where most pages live. The order is the
 * whole point of the feature on a mixed estate: showing `linux/ip` to someone
 * at a PowerShell prompt is worse than showing nothing, because it looks
 * authoritative.
 */
export const PLATFORM_SEARCH_ORDER: Record<TldrPlatform, TldrPlatform[]> = {
  common: ['common'],
  linux: ['linux', 'common'],
  osx: ['osx', 'common', 'linux'],
  windows: ['windows', 'dos', 'common'],
  android: ['android', 'linux', 'common'],
  freebsd: ['freebsd', 'common', 'linux'],
  netbsd: ['netbsd', 'common', 'linux'],
  openbsd: ['openbsd', 'common', 'linux'],
  sunos: ['sunos', 'common', 'linux'],
  dos: ['dos', 'windows', 'common'],
  // Deliberately does not fall through to linux: `show`, `write` and `reload`
  // all exist as Linux pages and mean something entirely different on a switch.
  'cisco-ios': ['cisco-ios', 'common'],
}

/** Human labels for the platform badge in the panel. */
export const PLATFORM_LABEL: Record<TldrPlatform, string> = {
  common: 'Common',
  linux: 'Linux',
  osx: 'macOS',
  windows: 'Windows',
  android: 'Android',
  freebsd: 'FreeBSD',
  netbsd: 'NetBSD',
  openbsd: 'OpenBSD',
  sunos: 'SunOS',
  dos: 'DOS',
  'cisco-ios': 'Cisco IOS',
}

/**
 * Which platform a connection is, as far as tldr is concerned.
 *
 * Smartcom does not know what is at the far end of an SSH connection — that is
 * a property of the box, not of the protocol — so this reads the things the
 * operator has already told us: the transport, the shell they picked for a
 * local session, and the tags on the connection. Tagging a connection `cisco`
 * is what turns `show` into the IOS page.
 *
 * `hostPlatform` is this machine's `process.platform`, needed because a local
 * `bash` session is macOS documentation on a Mac and Linux documentation
 * elsewhere.
 */
export function platformForConnection(input: {
  transport?: string
  shellKind?: string
  tags?: string[]
  hostPlatform?: string
}): TldrPlatform {
  const tags = (input.tags ?? []).map((tag) => tag.toLowerCase())

  // A tag is an explicit statement about what the box is, so it wins over any
  // inference from the transport.
  if (tags.some((tag) => tag === 'cisco' || tag === 'ios' || tag === 'cisco-ios')) {
    return 'cisco-ios'
  }
  if (tags.includes('windows')) return 'windows'
  if (tags.includes('macos') || tags.includes('osx')) return 'osx'
  if (tags.includes('linux')) return 'linux'

  if (input.transport === 'local') {
    switch (input.shellKind) {
      case 'cmd':
        return 'windows'
      case 'powershell':
        // Windows PowerShell only ships on Windows; `pwsh` is cross-platform
        // and falls through to the host check below.
        return 'windows'
      case 'pwsh':
        return localFamily(input.hostPlatform)
      case 'wsl':
        return 'linux'
      default:
        return localFamily(input.hostPlatform)
    }
  }

  // Serial is usually a console cable into equipment, not a general-purpose
  // shell, so nothing platform-specific is assumed.
  if (input.transport === 'serial') return 'common'

  // SSH with nothing said about it: Linux is the overwhelming majority, and the
  // fallback to `common` covers the rest.
  return 'linux'
}

function localFamily(hostPlatform?: string): TldrPlatform {
  if (hostPlatform === 'win32') return 'windows'
  if (hostPlatform === 'darwin') return 'osx'
  return 'linux'
}

/** Lookup order for a platform, tolerating an unknown value. */
export function platformSearchOrder(platform: string): TldrPlatform[] {
  return isTldrPlatform(platform) ? PLATFORM_SEARCH_ORDER[platform] : ['common']
}

// ---------------------------------------------------------------------------
// The normalised page
// ---------------------------------------------------------------------------

/** How a `{{…}}` token behaves once it reaches the command builder. */
export type TldrPlaceholderKind =
  /** Free text the operator supplies: `{{eth0}}`. */
  | 'value'
  /** A short/long option pair: `{{[-i|--interface]}}`. Not typed, picked. */
  | 'option'
  /** A fixed set of alternatives: `{{table|list|csv}}`. */
  | 'choice'

export interface TldrPlaceholder {
  /** Exactly what stood between the braces — also the substitution key. */
  token: string
  /** Label shown beside the input. */
  label: string
  /** Pre-filled value: upstream tokens are real examples, so they are useful. */
  defaultValue: string
  kind: TldrPlaceholderKind
  /** Present for `option` and `choice`. */
  choices?: string[]
  /**
   * True when the token is a description of a value rather than a value —
   * `{{path/to/file}}`, `{{filename}}`. Run stays disabled until one of these
   * is actually edited, because running the example verbatim would either fail
   * or, worse, act on a path that happens to exist.
   */
  generic: boolean
}

export interface TldrExample {
  description: string
  /** The command with `{{…}}` intact, kept so the original stays visible. */
  template: string
  /** Distinct placeholders, in first-appearance order. */
  placeholders: TldrPlaceholder[]
}

export interface TldrPage {
  command: string
  platform: TldrPlatform
  /** Description paragraphs, one per `>` line, with the link line removed. */
  description: string[]
  /** Upstream documentation URL from the `More information:` line. */
  moreInfo?: string
  examples: TldrExample[]
  /** Other platforms that also document this command. Filled by the service. */
  otherPlatforms?: TldrPlatform[]
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PLACEHOLDER_PATTERN = /\{\{(.+?)\}\}/g

/**
 * Tokens that name a kind of value instead of being one.
 *
 * Upstream writes `{{eth0}}` (a usable default) and `{{filename}}` (a
 * description) with identical syntax, so the difference has to be guessed. The
 * consequence of guessing wrong is only that Run needs one more keystroke, so
 * the list is deliberately generous rather than clever.
 */
const GENERIC_TOKENS = new Set([
  'address',
  'argument',
  'arguments',
  'command',
  'destination',
  'directory',
  'file',
  'filename',
  'files',
  'folder',
  'host',
  'hostname',
  'id',
  'ip',
  'ip_address',
  'key',
  'name',
  'option',
  'options',
  'password',
  'path',
  'pattern',
  'port',
  'regex',
  'search_pattern',
  'source',
  'string',
  'target',
  'text',
  'url',
  'user',
  'username',
  'value',
])

function isGenericToken(token: string): boolean {
  const lower = token.toLowerCase()
  if (GENERIC_TOKENS.has(lower)) return true
  // `path/to/file`, `path\to\file`, `path/to/directory` and friends: upstream's
  // house style for "put a real path here".
  if (/path[\\/]to[\\/]/.test(lower)) return true
  if (/^(your|my|example)[_-]/.test(lower)) return true
  return false
}

/**
 * Turns one `{{…}}` token into a placeholder.
 *
 * Three shapes, distinguished by their own syntax rather than by guesswork:
 * `[-i|--interface]` is the spec's short/long option pair, `a|b|c` is a fixed
 * choice, anything else is free text.
 */
export function parsePlaceholderToken(token: string): TldrPlaceholder {
  const bracketed = token.match(/^\[(.+)\]$/)

  if (bracketed && bracketed[1].includes('|')) {
    const choices = bracketed[1].split('|').map((part) => part.trim()).filter(Boolean)
    return {
      token,
      label: choices.join(' / '),
      // The short form is what people type and what fits the panel.
      defaultValue: choices[0] ?? token,
      kind: 'option',
      choices,
      generic: false,
    }
  }

  if (token.includes('|') && !token.includes(' ')) {
    const choices = token.split('|').map((part) => part.trim()).filter(Boolean)
    return {
      token,
      label: choices.join(' / '),
      defaultValue: choices[0] ?? token,
      kind: 'choice',
      choices,
      generic: false,
    }
  }

  return {
    token,
    label: token,
    defaultValue: token,
    kind: 'value',
    generic: isGenericToken(token),
  }
}

/**
 * Distinct placeholders in a template, in the order they first appear.
 *
 * De-duplicated by token text on purpose: `rsync {{path/to/source}}
 * {{path/to/source}}` should ask once and fill both, which is also what makes
 * `{{eth0}}` appearing twice in one tcpdump example behave sensibly.
 */
export function extractPlaceholders(template: string): TldrPlaceholder[] {
  const seen = new Map<string, TldrPlaceholder>()
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    const token = match[1].trim()
    if (!seen.has(token)) seen.set(token, parsePlaceholderToken(token))
  }
  return [...seen.values()]
}

/**
 * Substitutes placeholder values into a template.
 *
 * A token with no supplied value falls back to its default, so the preview is
 * always a runnable-looking command rather than a half-filled template. Unknown
 * tokens are left as they were — better a visible `{{…}}` than a command that
 * silently lost an argument.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (whole, raw: string) => {
    const token = raw.trim()
    if (Object.prototype.hasOwnProperty.call(values, token)) {
      const value = values[token]
      if (value !== '') return value
    }
    const placeholder = parsePlaceholderToken(token)
    return placeholder.defaultValue || whole
  })
}

/** Default values for an example, ready to seed the builder's inputs. */
export function defaultValues(example: TldrExample): Record<string, string> {
  const values: Record<string, string> = {}
  for (const placeholder of example.placeholders) {
    values[placeholder.token] = placeholder.defaultValue
  }
  return values
}

/**
 * Whether the generated command is safe to *offer* as runnable.
 *
 * Only generic placeholders block it, and only while they still hold the
 * example text. `tcpdump -i eth0` is a real command; `rm {{path/to/file}}` with
 * the default left alone is not, and Run must not pretend otherwise.
 */
export function unresolvedPlaceholders(
  example: TldrExample,
  values: Record<string, string>
): TldrPlaceholder[] {
  return example.placeholders.filter((placeholder) => {
    if (!placeholder.generic) return false
    const value = values[placeholder.token] ?? placeholder.defaultValue
    return value.trim() === '' || value === placeholder.defaultValue
  })
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

/**
 * Upstream marks the letter that forms a short option with square brackets —
 * "showing contents ([A]SCII)". Rendered literally that reads as a typo, so the
 * brackets come off; only single alphanumerics are touched, which leaves real
 * bracketed prose alone.
 */
function tidyProse(text: string): string {
  return text.replace(/\[([A-Za-z0-9])\]/g, '$1').trim()
}

const MORE_INFO = /^More information:\s*<?(.+?)>?\.?$/i

/**
 * Parses one tldr page.
 *
 * Tolerant by design: a page that has drifted from the spec should lose the
 * part that could not be read, not the whole page. A parse that finds no
 * examples still yields a usable description, and a page with no title falls
 * back to the filename the caller already knows.
 */
export function parseTldrPage(
  markdown: string,
  fallback: { command: string; platform: TldrPlatform }
): TldrPage {
  const lines = markdown.split(/\r?\n/)

  let command = ''
  const description: string[] = []
  let moreInfo: string | undefined
  const examples: TldrExample[] = []

  /** Description of the example whose command line we are still waiting for. */
  let pendingDescription: string | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    if (!command && line.startsWith('# ')) {
      command = line.slice(2).trim()
      continue
    }

    if (line.startsWith('> ')) {
      const body = line.slice(2).trim()
      const link = body.match(MORE_INFO)
      if (link) {
        moreInfo = link[1].trim()
      } else {
        description.push(tidyProse(body))
      }
      continue
    }

    if (line.startsWith('- ')) {
      pendingDescription = tidyProse(line.slice(2).replace(/:$/, ''))
      continue
    }

    if (line.startsWith('`') && line.endsWith('`') && line.length > 1) {
      const template = line.slice(1, -1).trim()
      if (!template) continue
      examples.push({
        // A command line with no preceding bullet is malformed upstream; keep
        // the command rather than dropping it, and say so plainly.
        description: pendingDescription ?? 'Example',
        template,
        placeholders: extractPlaceholders(template),
      })
      pendingDescription = null
    }
  }

  return {
    command: command || fallback.command,
    platform: fallback.platform,
    description,
    moreInfo,
    examples,
  }
}

/** One-line summary for search results and the indicator's tooltip. */
export function pageSummary(page: Pick<TldrPage, 'description'>): string {
  return page.description[0] ?? ''
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export interface TldrSearchResult {
  command: string
  platform: TldrPlatform
  description: string
  /** Higher is better. Only meaningful relative to the same query. */
  score: number
  /** Which field matched, so the list can say why a result is there. */
  matched: 'command' | 'description' | 'example' | 'fuzzy'
}

/** Cache state, as the settings screen and the indicator both need it. */
export interface TldrCacheStatus {
  /** A usable index exists on disk. */
  ready: boolean
  /** Currently downloading or indexing. */
  busy: boolean
  lastUpdated: string | null
  datasetVersion: string | null
  languages: string[]
  platforms: string[]
  indexVersion: number
  pageCount: number
  cacheDir: string
  /** Why the last update attempt failed, if it did. */
  error: string | null
  /** `process.platform` of this machine, for platform inference. */
  hostPlatform: string
}
