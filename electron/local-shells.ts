import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { LocalShellInfo } from '../src/shared/types'

/**
 * Finds the shells this machine can actually start.
 *
 * Detection is deliberately split in two: `windowsShellCandidates` and
 * `unixShellCandidates` are pure — they take the environment and say what
 * *would* be a shell — and `detectLocalShells` is the impure half that reads
 * the disk and asks WSL what it has. That split is what makes the interesting
 * part testable on any platform, including the Windows paths from CI on Linux.
 */

/**
 * Keeps the first entry for each command *and* each id; later ones are dropped.
 *
 * Both halves earn their place. The same executable can be reached by two
 * paths — a junctioned Program Files, a shell listed in both `$SHELL` and
 * `/etc/shells` — and the picker keys its options by id, so a repeated id
 * would be a duplicate React key rather than a cosmetic nuisance.
 */
function dedupe(shells: LocalShellInfo[]): LocalShellInfo[] {
  const seenKeys = new Set<string>()
  const seenIds = new Set<string>()
  return shells.filter((shell) => {
    const key = `${shell.command.toLowerCase()}\u0000${shell.args.join('\u0000')}`
    if (seenKeys.has(key) || seenIds.has(shell.id)) return false
    seenKeys.add(key)
    seenIds.add(shell.id)
    return true
  })
}

/**
 * Shells worth looking for on Windows, in the order the picker shows them.
 *
 * `wslDistros` comes from `wsl.exe --list --quiet`; an empty list still yields
 * a plain "WSL" entry when wsl.exe exists, because a machine can have the
 * feature installed with no distro registered yet and the error it prints is
 * more useful than the connection being missing.
 */
export function windowsShellCandidates(
  env: Record<string, string | undefined>,
  wslDistros: string[] = []
): LocalShellInfo[] {
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  const system32 = join(systemRoot, 'System32')
  // ProgramW6432 is the 64-bit Program Files even from a 32-bit process;
  // ProgramFiles alone would point at the x86 tree there and miss Git.
  const programFiles = env.ProgramW6432 || env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA || ''

  const candidates: LocalShellInfo[] = []

  candidates.push({
    id: 'powershell',
    label: 'Windows PowerShell',
    command: join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [],
    kind: 'powershell',
  })

  // PowerShell 7+ installs per major version, and the store/winget build only
  // leaves an app-execution alias behind, so all three places are checked.
  // Ids carry the root as well as the version: both trees can hold a
  // "PowerShell 7", and two candidates sharing an id would collide in the
  // picker — which is a duplicate React key, not a cosmetic problem.
  for (const [root, suffix] of [
    [programFiles, ''],
    [programFilesX86, '-x86'],
  ] as const) {
    for (const major of ['7', '8', '9']) {
      candidates.push({
        id: `pwsh-${major}${suffix}`,
        label: suffix ? `PowerShell ${major} (x86)` : `PowerShell ${major}`,
        command: join(root, 'PowerShell', major, 'pwsh.exe'),
        args: [],
        kind: 'pwsh',
      })
    }
  }
  if (localAppData) {
    candidates.push({
      id: 'pwsh',
      label: 'PowerShell',
      command: join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
      args: [],
      kind: 'pwsh',
    })
  }

  candidates.push({
    id: 'cmd',
    label: 'Command Prompt',
    command: join(system32, 'cmd.exe'),
    args: [],
    kind: 'cmd',
  })

  const wsl = join(system32, 'wsl.exe')
  if (wslDistros.length > 0) {
    for (const distro of wslDistros) {
      candidates.push({
        id: `wsl:${distro}`,
        label: `WSL — ${distro}`,
        command: wsl,
        args: ['-d', distro],
        kind: 'wsl',
      })
    }
  } else {
    candidates.push({ id: 'wsl', label: 'WSL', command: wsl, args: [], kind: 'wsl' })
  }

  // Git for Windows. `--login -i` is what Git Bash's own shortcut passes; the
  // shell starts in the wrong place and without the PATH edits otherwise.
  for (const [index, root] of [
    join(programFiles, 'Git'),
    join(programFilesX86, 'Git'),
    localAppData ? join(localAppData, 'Programs', 'Git') : '',
  ].entries()) {
    if (!root) continue
    candidates.push({
      id: index === 0 ? 'git-bash' : `git-bash-${index}`,
      label: index === 0 ? 'Git Bash' : `Git Bash (${root})`,
      command: join(root, 'bin', 'bash.exe'),
      args: ['--login', '-i'],
      kind: 'bash',
    })
  }

  return candidates
}

/** Turns an absolute shell path into the family and label the picker shows. */
function describeUnixShell(command: string): { kind: LocalShellInfo['kind']; label: string } {
  const name = command.split('/').pop() ?? command
  switch (name) {
    case 'zsh':
      return { kind: 'zsh', label: 'Zsh' }
    case 'bash':
      return { kind: 'bash', label: 'Bash' }
    case 'fish':
      return { kind: 'fish', label: 'Fish' }
    case 'sh':
      return { kind: 'sh', label: 'Sh' }
    default:
      return { kind: 'other', label: name }
  }
}

/**
 * Shells worth looking for on macOS and Linux.
 *
 * `$SHELL` comes first and is marked as the default, so opening a local
 * connection gives the operator the shell they already use rather than
 * whichever one happens to sort first.
 *
 * macOS entries run as **login** shells (`-l`). Terminal.app does the same,
 * and without it `.zprofile` never runs — which on a Homebrew machine means no
 * `/opt/homebrew/bin` on PATH and half the operator's tools missing. Linux
 * shells are left interactive-but-not-login, matching what a desktop terminal
 * emulator gives you there.
 */
export function unixShellCandidates(
  platform: 'darwin' | 'linux',
  env: Record<string, string | undefined>,
  etcShells: string[] = []
): LocalShellInfo[] {
  const loginArgs = platform === 'darwin' ? ['-l'] : []

  const paths: string[] = []
  const push = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && trimmed.startsWith('/') && !paths.includes(trimmed)) paths.push(trimmed)
  }

  push(env.SHELL)
  for (const line of etcShells) {
    // /etc/shells carries comments and blank lines.
    const entry = line.split('#')[0]?.trim()
    push(entry)
  }
  for (const fallback of [
    '/bin/zsh',
    '/bin/bash',
    '/usr/bin/zsh',
    '/usr/bin/bash',
    '/usr/bin/fish',
    '/opt/homebrew/bin/fish',
    '/usr/local/bin/fish',
    '/bin/sh',
  ]) {
    push(fallback)
  }

  return paths.map((command, index) => {
    const { kind, label } = describeUnixShell(command)
    return {
      id: command,
      label: index === 0 && env.SHELL?.trim() === command ? `${label} (login shell)` : label,
      command,
      args: [...loginArgs],
      kind,
      isDefault: index === 0 && env.SHELL?.trim() === command,
    }
  })
}

/**
 * Asks WSL which distributions are registered.
 *
 * `wsl.exe` writes **UTF-16LE** to stdout, so the output is read as a buffer
 * and decoded explicitly — reading it as utf8 yields a name with a NUL between
 * every letter, which then gets saved into a connection and fails to launch.
 * Anything going wrong here (no WSL, feature disabled, slow start) returns an
 * empty list rather than throwing: a missing distro list must not take the
 * whole picker down with it.
 */
export function listWslDistros(system32: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      join(system32, 'wsl.exe'),
      ['--list', '--quiet'],
      // Ten seconds, not the usual couple: a cold WSL has to start its VM
      // before it will answer, and timing out here does not fail loudly — it
      // silently drops every distro from the picker and leaves only the
      // generic "WSL" entry, which reads as "the app cannot see my distros".
      { encoding: 'buffer', timeout: 10_000, windowsHide: true },
      (error, stdout) => {
        if (error || !stdout) return resolve([])
        resolve(
          stdout
            .toString('utf16le')
            // A leading BOM survives the decode and would become part of the
            // first distro's name.
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        )
      }
    )
  })
}

/** Reads /etc/shells, tolerating its absence. */
async function readEtcShells(): Promise<string[]> {
  try {
    return (await readFile('/etc/shells', 'utf8')).split(/\r?\n/)
  } catch {
    return []
  }
}

/**
 * The shells actually present on this machine.
 *
 * Candidates whose executable is missing are dropped here, which is why the
 * picker can list "PowerShell 7" without checking whether it is installed.
 */
export async function detectLocalShells(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env
): Promise<LocalShellInfo[]> {
  let candidates: LocalShellInfo[]

  if (platform === 'win32') {
    const system32 = join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32')
    // Only pay for the WSL round-trip if wsl.exe is there at all.
    const distros = existsSync(join(system32, 'wsl.exe')) ? await listWslDistros(system32) : []
    candidates = windowsShellCandidates(env, distros)
  } else {
    candidates = unixShellCandidates(
      platform === 'darwin' ? 'darwin' : 'linux',
      env,
      await readEtcShells()
    )
  }

  return dedupe(candidates.filter((shell) => existsSync(shell.command)))
}

/**
 * Whether a local connection's command can be started.
 *
 * This is what "Test" does for a local connection — there is nothing to
 * connect to, so the useful check is that the executable is still where the
 * connection says it is. Uninstalling PowerShell 7 or removing a WSL distro is
 * exactly the failure this catches.
 */
export function checkLocalShell(command: string, cwd?: string): { success: boolean; error?: string } {
  if (!command.trim()) return { success: false, error: 'No shell command set' }

  // A bare name like `bash` is resolved by the OS against PATH at spawn time,
  // so there is nothing to stat — accept it and let the spawn report.
  const looksLikePath = command.includes('/') || command.includes('\\')
  if (looksLikePath && !existsSync(command)) {
    return { success: false, error: `Not found: ${command}` }
  }
  if (cwd?.trim() && !existsSync(cwd)) {
    return { success: false, error: `Working directory not found: ${cwd}` }
  }
  return { success: true }
}

/**
 * Environment for a local shell.
 *
 * Two things have to happen. Electron leaks its own launch settings into
 * `process.env` — inherit them and the child node/npm the operator runs picks
 * up `ELECTRON_RUN_AS_NODE` and behaves like a bare Node process, so they get
 * removed. And `TERM` must say what xterm.js can actually render, or programs
 * fall back to a dumb terminal and colours and cursor addressing stop working.
 */
export function localShellEnv(
  base: Record<string, string | undefined> = process.env
): Record<string, string> {
  const stripped = new Set([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'ELECTRON_NO_ASAR',
    'NODE_OPTIONS',
    'GDK_BACKEND',
    'ORIGINAL_XDG_CURRENT_DESKTOP',
  ])

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string' && !stripped.has(key)) env[key] = value
  }

  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}
