/**
 * Working out what the operator is actually running, and whether it bites.
 *
 * Two jobs that both operate on one line of shell text:
 *
 *  - **Detection** turns `sudo -u root tcpdump -i eth0 | tail -20` into
 *    `tcpdump`, which is the thing that has documentation. Naively taking the
 *    first word finds `sudo` every time, which would make the whole feature
 *    useless on exactly the commands people need help with.
 *  - **Classification** decides whether a command gets `Run` or `Review & Run`.
 *
 * Neither is, or can be, exact. A shell is a programming language and this is a
 * few hundred lines of string handling. Detection failing means no tldr page,
 * which costs nothing; classification failing open is the one that matters, so
 * the patterns below are broad and the confirmation they trigger is cheap.
 */

// ---------------------------------------------------------------------------
// Tokenising
// ---------------------------------------------------------------------------

/**
 * Splits a line into words, respecting quotes and backslash escapes.
 *
 * Only as clever as it needs to be for finding the executable: quoted regions
 * become one token so `grep "foo | bar" file` is not read as a pipeline.
 */
export function tokenise(line: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]

    if (quote) {
      if (char === '\\' && quote === '"' && index + 1 < line.length) {
        current += line[index + 1]
        index += 1
        continue
      }
      if (char === quote) {
        quote = null
        continue
      }
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }

    if (char === '\\' && index + 1 < line.length) {
      current += line[index + 1]
      index += 1
      started = true
      continue
    }

    if (/\s/.test(char)) {
      if (current || started) tokens.push(current)
      current = ''
      started = false
      continue
    }

    current += char
    started = true
  }

  if (current || started) tokens.push(current)
  return tokens
}

/**
 * Splits a line into the commands it chains together.
 *
 * Separators are matched outside quotes only. `&` alone is left in place: a
 * trailing `&` backgrounds the command it belongs to rather than starting a new
 * one, and splitting on it would produce an empty second segment.
 */
export function splitSegments(line: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]

    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === '\\' && next) {
      current += char + next
      index += 1
      continue
    }

    if (char === '|' || char === ';' || (char === '&' && next === '&')) {
      const doubled = (char === '|' && next === '|') || char === '&'
      segments.push(current)
      current = ''
      if (doubled) index += 1
      continue
    }

    current += char
  }

  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Commands that run another command, and are almost never what help is wanted
 * for. `sudo` is the reason this feature needs a detector at all.
 */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'pkexec',
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'setsid',
  'time',
  'timeout',
  'watch',
  'nice',
  'ionice',
  'stdbuf',
  'xargs',
  'strace',
  'ltrace',
  'proxychains',
  'proxychains4',
  'unbuffer',
  'script',
  'sg',
  'runuser',
  'nix-shell',
])

/**
 * Wrapper flags that swallow the following token.
 *
 * Without this, `sudo -u root tcpdump` detects `root`. Keyed by wrapper so a
 * flag that takes a value for one and not another cannot cross over.
 */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-T', '--user', '--group', '--prompt']),
  doas: new Set(['-u', '-C']),
  pkexec: new Set(['--user']),
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  watch: new Set(['-n', '--interval', '-d', '--differences']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-n', '-P', '-I', '-d', '-s', '-a', '-E']),
  strace: new Set(['-o', '-p', '-e', '-s']),
  ltrace: new Set(['-o', '-p', '-e']),
  runuser: new Set(['-u', '-g', '-s']),
  sg: new Set([]),
  script: new Set(['-c', '--command']),
  'nix-shell': new Set(['-p', '--packages', '-I', '--run']),
}

/**
 * Wrappers that take a positional operand before the command they run.
 *
 * `timeout 30 cmd` is the one that matters: its duration is not a flag, so the
 * flag-skipping loop stops on it and reports `30` as the command.
 */
const WRAPPER_POSITIONAL: Record<string, (token: string) => boolean> = {
  timeout: (token) => /^\d+(?:\.\d+)?[smhd]?$/.test(token),
  // `sg <group> -c '<command>'`
  sg: () => true,
}

/** `FOO=bar` in command position is an environment assignment, not a command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Strips a path and a Windows extension off an executable.
 *
 * `/usr/bin/tcpdump`, `./backup.sh` and `C:\Windows\System32\ipconfig.exe` all
 * name a command that has, or might have, a page.
 */
export function basename(token: string): string {
  const withoutPath = token.split(/[\\/]/).pop() ?? token
  return withoutPath.replace(/\.(exe|com|bat|cmd|ps1)$/i, '')
}

/**
 * The executable one segment of a pipeline runs, wrappers stepped over.
 *
 * Returns an empty string when the segment names nothing runnable — a bare
 * redirect, a lone variable assignment, a wrapper with no payload.
 */
export function baseCommandOfSegment(segment: string): string {
  const tokens = tokenise(segment)
  let index = 0

  // Bounded rather than `while (true)`: a pathological line of nothing but
  // wrappers must not spin, and ten levels is already far past anything real.
  for (let depth = 0; depth < 10; depth += 1) {
    // Environment assignments in command position.
    while (index < tokens.length && ASSIGNMENT.test(tokens[index])) index += 1

    const token = tokens[index]
    if (!token) return ''

    // A redirect or a subshell is not a command name.
    if (/^[<>(){}]/.test(token)) return ''

    const name = basename(token)
    if (!WRAPPERS.has(name)) return name

    const valueFlags = WRAPPER_VALUE_FLAGS[name] ?? new Set<string>()
    index += 1

    // Step over the wrapper's own options so its arguments are not mistaken
    // for the command it is about to run.
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const flag = tokens[index]
      index += 1
      // `--user=root` carries its value; `-u root` does not.
      if (!flag.includes('=') && valueFlags.has(flag)) index += 1
    }

    // `sudo --` ends option parsing; whatever follows is the command.
    if (tokens[index] === '--') index += 1

    const positional = WRAPPER_POSITIONAL[name]
    if (positional && tokens[index] && positional(tokens[index])) index += 1
  }

  return ''
}

export interface DetectedCommand {
  /** The command tldr should be asked about. Empty when nothing was found. */
  command: string
  /** Every command in the line, in order, primary first. */
  all: string[]
  /** Wrappers that were stepped over, so the panel can say why. */
  wrappers: string[]
  /** The line the detection came from, trimmed. */
  line: string
}

/**
 * What the operator is running, from the line they have typed.
 *
 * The first segment wins — `grep foo /var/log/messages | tail -20` is a grep
 * question — but every command in the line is reported so the panel can offer
 * the others without a second lookup.
 */
export function detectCommand(line: string): DetectedCommand {
  const trimmed = line.trim()
  const empty: DetectedCommand = { command: '', all: [], wrappers: [], line: trimmed }
  if (!trimmed) return empty

  const segments = splitSegments(trimmed)
  if (segments.length === 0) return empty

  const all: string[] = []
  for (const segment of segments) {
    const name = baseCommandOfSegment(segment)
    if (name && !all.includes(name)) all.push(name)
  }

  const wrappers = tokenise(segments[0])
    .map(basename)
    .filter((token) => WRAPPERS.has(token))

  return { command: all[0] ?? '', all, wrappers, line: trimmed }
}

// ---------------------------------------------------------------------------
// Risk classification
// ---------------------------------------------------------------------------

export interface CommandRisk {
  destructive: boolean
  /** Plain-English reasons, shown in the confirmation. */
  reasons: string[]
}

/** Commands that are destructive by existing at all. */
const DESTRUCTIVE_COMMANDS: Record<string, string> = {
  rm: 'removes files',
  rmdir: 'removes directories',
  shred: 'overwrites files so they cannot be recovered',
  dd: 'writes raw blocks, and can overwrite a whole disk',
  mkfs: 'formats a filesystem',
  mkswap: 'formats a swap area',
  fdisk: 'edits the partition table',
  sfdisk: 'edits the partition table',
  cfdisk: 'edits the partition table',
  parted: 'edits the partition table',
  gparted: 'edits the partition table',
  wipefs: 'erases filesystem signatures',
  shutdown: 'shuts the machine down',
  reboot: 'reboots the machine',
  poweroff: 'powers the machine off',
  halt: 'halts the machine',
  killall: 'kills every matching process',
  pkill: 'kills matching processes',
  format: 'formats a volume',
  diskpart: 'edits disks and partitions',
  'stop-computer': 'shuts the machine down',
  'restart-computer': 'reboots the machine',
  'clear-disk': 'erases a disk',
  'remove-partition': 'deletes a partition',
  // Cisco IOS
  erase: 'erases device configuration or flash',
  reload: 'reloads the device',
}

/**
 * Sub-command patterns, matched against the whole segment.
 *
 * These are the cases where the executable is ordinary and the arguments are
 * not: `docker ps` and `docker system prune` are the same binary.
 */
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Package management
  { pattern: /\b(?:apt|apt-get|aptitude)\b[^|;]*\b(?:remove|purge|autoremove)\b/i, reason: 'removes installed packages' },
  { pattern: /\b(?:yum|dnf)\b[^|;]*\b(?:remove|erase|autoremove)\b/i, reason: 'removes installed packages' },
  { pattern: /\bzypper\b[^|;]*\b(?:rm|remove)\b/i, reason: 'removes installed packages' },
  { pattern: /\bapk\b[^|;]*\bdel\b/i, reason: 'removes installed packages' },
  { pattern: /\bpacman\b[^|;]*\s-R/i, reason: 'removes installed packages' },
  { pattern: /\b(?:brew|pip|pip3|npm|gem|choco|winget)\b[^|;]*\b(?:uninstall|remove)\b/i, reason: 'removes installed packages' },

  // Services
  { pattern: /\bsystemctl\b[^|;]*\b(?:disable|mask|stop)\b/i, reason: 'stops or disables a service' },
  { pattern: /\bservice\b[^|;]+\b(?:stop|restart)\b/i, reason: 'stops or restarts a service' },
  { pattern: /\b(?:Stop|Remove)-Service\b/i, reason: 'stops or removes a service' },

  // Firewalls
  { pattern: /\biptables\b[^|;]*\s-(?:F|X|Z)\b/i, reason: 'flushes firewall rules' },
  { pattern: /\bip6tables\b[^|;]*\s-(?:F|X|Z)\b/i, reason: 'flushes firewall rules' },
  { pattern: /\bnft\b[^|;]*\bflush\b/i, reason: 'flushes firewall rules' },
  { pattern: /\bufw\b[^|;]*\b(?:reset|disable|delete)\b/i, reason: 'changes the firewall' },
  { pattern: /\bfirewall-cmd\b[^|;]*\b(?:--remove|--reload)\b/i, reason: 'changes the firewall' },
  { pattern: /\bnetsh\b[^|;]*\badvfirewall\b[^|;]*\breset\b/i, reason: 'resets the firewall' },

  // Containers and orchestration
  { pattern: /\bdocker\b[^|;]*\bprune\b/i, reason: 'deletes unused Docker data' },
  { pattern: /\bdocker\b[^|;]*\b(?:rm|rmi|kill)\b/i, reason: 'removes or kills containers or images' },
  { pattern: /\bdocker[- ]compose\b[^|;]*\bdown\b/i, reason: 'tears down the compose stack' },
  { pattern: /\bkubectl\b[^|;]*\b(?:delete|drain)\b/i, reason: 'deletes or drains Kubernetes resources' },

  // Data
  { pattern: /\bdrop\s+(?:database|table|schema|index)\b/i, reason: 'drops a database object' },
  { pattern: /\btruncate\s+table\b/i, reason: 'empties a table' },
  { pattern: /\bdelete\s+from\b/i, reason: 'deletes rows' },
  { pattern: /\bdropDatabase\s*\(/i, reason: 'drops a database' },
  { pattern: /\bFLUSH(?:ALL|DB)\b/i, reason: 'empties the Redis keyspace' },

  // Version control
  { pattern: /\bgit\b[^|;]*\breset\b[^|;]*--hard\b/i, reason: 'discards local changes' },
  { pattern: /\bgit\b[^|;]*\bclean\b[^|;]*-[a-z]*f/i, reason: 'deletes untracked files' },
  { pattern: /\bgit\b[^|;]*\bpush\b[^|;]*(?:--force|-f)\b/i, reason: 'force-pushes over remote history' },

  // Raw devices and redirection over one
  { pattern: /\bof=\/dev\/(?:sd|nvme|hd|vd|disk)/i, reason: 'writes directly to a disk device' },
  { pattern: />\s*\/dev\/(?:sd|nvme|hd|vd|disk)/i, reason: 'writes directly to a disk device' },

  // Recursive ownership and permission changes
  { pattern: /\bch(?:mod|own|grp)\b[^|;]*\s-[a-zA-Z]*R/, reason: 'changes permissions recursively' },

  // Windows
  { pattern: /\bRemove-Item\b[^|;]*(?:-Recurse|-Force)/i, reason: 'removes files recursively' },
  { pattern: /\bdel\b[^|;]*\s\/[fsq]/i, reason: 'force-deletes files' },
  { pattern: /\brd\b[^|;]*\s\/s/i, reason: 'removes a directory tree' },
  { pattern: /\bReset-ComputerMachinePassword\b/i, reason: 'resets the machine account password' },

  // Scheduled jobs
  { pattern: /\bcrontab\b[^|;]*\s-r\b/, reason: 'deletes the crontab' },

  // Cisco IOS
  { pattern: /\bwrite\s+erase\b/i, reason: 'erases the startup configuration' },
  { pattern: /\bno\s+(?:ip|interface|router|vlan)\b/i, reason: 'removes device configuration' },
  { pattern: /^\s*delete\b/i, reason: 'deletes a file on the device' },
]

/**
 * Whether a command should be confirmed before it is sent.
 *
 * tldr is documentation, not a safety guarantee: `tldr rm` cheerfully documents
 * `rm -rf`. So the classification happens on the *generated* command, after
 * placeholders are filled, and it deliberately errs towards asking. Being asked
 * about a harmless `docker rm` costs one click; not being asked about a real
 * one costs a production container.
 *
 * This is a speed bump, not a security boundary. A determined line will get
 * through it, and the operator can type anything they like into the terminal
 * regardless — the point is that a command the operator half-read in a
 * documentation panel gets a second look before it is sent.
 */
export function classifyCommand(command: string): CommandRisk {
  const reasons: string[] = []
  const trimmed = command.trim()
  if (!trimmed) return { destructive: false, reasons }

  for (const segment of splitSegments(trimmed)) {
    const name = baseCommandOfSegment(segment).toLowerCase()
    const direct = DESTRUCTIVE_COMMANDS[name]
    if (direct && !reasons.includes(direct)) reasons.push(direct)

    // `mkfs.ext4`, `mkfs.xfs`
    if (name.startsWith('mkfs.') && !reasons.includes(DESTRUCTIVE_COMMANDS.mkfs)) {
      reasons.push(DESTRUCTIVE_COMMANDS.mkfs)
    }

    for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(segment) && !reasons.includes(reason)) reasons.push(reason)
    }
  }

  // Worth calling out separately: this is the shape people actually regret.
  if (/\brm\b[^|;]*\s-[a-zA-Z]*[rf]/.test(trimmed) && !reasons.includes('removes files recursively or without prompting')) {
    reasons.push('removes files recursively or without prompting')
  }

  return { destructive: reasons.length > 0, reasons }
}
