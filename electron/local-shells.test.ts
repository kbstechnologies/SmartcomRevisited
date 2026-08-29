import { describe, expect, it } from 'vitest'
import {
  checkLocalShell,
  localShellEnv,
  unixShellCandidates,
  windowsShellCandidates,
} from './local-shells'

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
}

/** Windows paths are built with `join`, which uses `\` only on win32. */
const sep = (path: string) => path.split(/[\\/]/).join('|')

describe('windowsShellCandidates', () => {
  it('offers cmd, Windows PowerShell and PowerShell 7', () => {
    const shells = windowsShellCandidates(WIN_ENV)
    const byId = new Map(shells.map((shell) => [shell.id, shell]))

    expect(sep(byId.get('cmd')!.command)).toBe('C:|Windows|System32|cmd.exe')
    expect(sep(byId.get('powershell')!.command)).toBe(
      'C:|Windows|System32|WindowsPowerShell|v1.0|powershell.exe'
    )
    expect(sep(byId.get('pwsh-7')!.command)).toBe('C:|Program Files|PowerShell|7|pwsh.exe')
  })

  it('makes one entry per WSL distro, passing the name as an argument', () => {
    const shells = windowsShellCandidates(WIN_ENV, ['Ubuntu-22.04', 'Debian'])
    const wsl = shells.filter((shell) => shell.kind === 'wsl')

    expect(wsl.map((shell) => shell.label)).toEqual(['WSL — Ubuntu-22.04', 'WSL — Debian'])
    expect(wsl[0].args).toEqual(['-d', 'Ubuntu-22.04'])
    // The distro name must stay a separate argument: joining it into the
    // command line breaks the moment a distro is named "My Distro".
    expect(sep(wsl[0].command)).toBe('C:|Windows|System32|wsl.exe')
  })

  it('still offers plain WSL when no distro is registered', () => {
    const wsl = windowsShellCandidates(WIN_ENV, []).filter((shell) => shell.kind === 'wsl')
    expect(wsl).toHaveLength(1)
    expect(wsl[0].args).toEqual([])
  })

  it('gives every candidate a unique id', () => {
    // The x86 and 64-bit trees can both hold a "PowerShell 7", and the picker
    // keys its options by id — so a collision is a duplicate React key, and
    // picking one entry would select the other.
    const ids = windowsShellCandidates(WIN_ENV, ['Ubuntu', 'Debian']).map((shell) => shell.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('starts Git Bash as a login shell, or its PATH is wrong', () => {
    const git = windowsShellCandidates(WIN_ENV).find((shell) => shell.id === 'git-bash')!
    expect(git.args).toEqual(['--login', '-i'])
  })

  it('falls back to windir, then to C:\\Windows, when SystemRoot is unset', () => {
    expect(sep(windowsShellCandidates({ windir: 'D:\\WinNT' })[0].command)).toContain('D:|WinNT')
    expect(sep(windowsShellCandidates({})[0].command)).toContain('C:|Windows')
  })
})

describe('unixShellCandidates', () => {
  it('puts $SHELL first and marks it as the default', () => {
    const shells = unixShellCandidates('linux', { SHELL: '/usr/bin/fish' }, [])

    expect(shells[0].command).toBe('/usr/bin/fish')
    expect(shells[0].isDefault).toBe(true)
    expect(shells[0].label).toBe('Fish (login shell)')
  })

  it('runs macOS shells as login shells so .zprofile is read', () => {
    const [macos] = unixShellCandidates('darwin', { SHELL: '/bin/zsh' }, [])
    const [linux] = unixShellCandidates('linux', { SHELL: '/bin/zsh' }, [])

    expect(macos.args).toEqual(['-l'])
    expect(linux.args).toEqual([])
  })

  it('reads /etc/shells, ignoring comments and blank lines', () => {
    const shells = unixShellCandidates('linux', {}, [
      '# /etc/shells: valid login shells',
      '',
      '/bin/dash',
      '   /usr/bin/tmux   ',
    ])
    const commands = shells.map((shell) => shell.command)

    expect(commands).toContain('/bin/dash')
    expect(commands).toContain('/usr/bin/tmux')
    expect(commands).not.toContain('# /etc/shells: valid login shells')
  })

  it('lists each shell once even when $SHELL repeats a fallback', () => {
    const commands = unixShellCandidates('linux', { SHELL: '/bin/bash' }, ['/bin/bash']).map(
      (shell) => shell.command
    )
    expect(commands.filter((command) => command === '/bin/bash')).toHaveLength(1)
  })

  it('ignores relative entries, which would resolve against the wrong cwd', () => {
    const commands = unixShellCandidates('linux', { SHELL: 'zsh' }, ['bash']).map((s) => s.command)
    expect(commands).not.toContain('zsh')
    expect(commands).not.toContain('bash')
  })
})

describe('checkLocalShell', () => {
  it('rejects an empty command', () => {
    expect(checkLocalShell('')).toEqual({ success: false, error: 'No shell command set' })
  })

  it('reports a path that is no longer there', () => {
    const result = checkLocalShell('/nonexistent/definitely/not/a/shell')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Not found')
  })

  it('accepts a bare name, which the OS resolves against PATH', () => {
    expect(checkLocalShell('bash')).toEqual({ success: true })
  })

  it('reports a missing working directory', () => {
    const result = checkLocalShell('bash', '/nonexistent/working/directory')
    expect(result.success).toBe(false)
    expect(result.error).toContain('Working directory not found')
  })
})

describe('localShellEnv', () => {
  it('sets a TERM xterm.js can actually render', () => {
    const env = localShellEnv({})
    expect(env.TERM).toBe('xterm-256color')
    expect(env.COLORTERM).toBe('truecolor')
  })

  it("drops Electron's own launch settings", () => {
    // Inherited, these make a child `node` or `npm` behave like a bare Node
    // process — the classic "npm install does nothing" report.
    const env = localShellEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--x', PATH: '/usr/bin' })

    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('drops undefined values rather than passing "undefined" through', () => {
    expect(localShellEnv({ EMPTY: undefined })).not.toHaveProperty('EMPTY')
  })
})
