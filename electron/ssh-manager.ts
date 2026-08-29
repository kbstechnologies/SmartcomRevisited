import { Client, ConnectConfig } from 'ssh2'
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { createWriteStream, mkdirSync, type WriteStream } from 'fs'
import { dirname, join } from 'path'
import { keytar } from './keychain'
import type { Macro, MacroStep, Profile, Session } from '../src/shared/types'
import { VAULT_SERVICE } from '../src/shared/constants'
import { preparePaste, trackBracketedPaste } from '../src/shared/paste'
import { interpolate, resolveFields } from '../src/shared/types'
import { builtinVariables } from '../src/shared/builtin-vars'
import {
  ensureParentDir,
  formatBytes,
  localNameForRemote,
  resolveInTransferDir,
  uniqueLocalPath,
} from './file-transfer'
import { checkLocalShell, localShellEnv } from './local-shells'

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
    hex.slice(20, 32),
  ].join('-')
}


/** Transcript retained per session for assistant context. */
const MAX_TRANSCRIPT_CHARS = 120_000
/** Raw replay buffer per session — roughly a few screens of scrollback. */
const MAX_SCROLLBACK_CHARS = 200_000

/** Nesting limit for macros that call other macros or sets. */
const MAX_CALL_DEPTH = 16

/**
 * Ceiling on any loop, applied regardless of what the step asks for.
 *
 * A button can arrive from the exchange, written by a stranger, and run against
 * production kit. A loop that cannot terminate would hold the shell open
 * issuing commands nobody is watching, so the engine keeps the final say.
 */
const MAX_LOOP_ITERATIONS = 1000
const DEFAULT_LOOP_LIMIT = 50

/** Named capture groups from a match, as plain variables. */
function captureGroups(match: RegExpMatchArray | undefined): Record<string, string> {
  const groups = match?.groups
  if (!groups) return {}

  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(groups)) {
    // An optional group that did not participate is undefined; binding it as
    // "undefined" would put that word into a command.
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** Splits a variable into the items a `forEach` walks. */
function splitList(raw: string, separator: 'lines' | 'comma' | 'whitespace'): string[] {
  const pattern =
    separator === 'comma' ? /\s*,\s*/ : separator === 'whitespace' ? /\s+/ : /\r?\n/

  return raw
    .split(pattern)
    .map((item) => item.trim())
    // Blank entries come free with trailing newlines and double separators, and
    // every one would run the body against an empty value.
    .filter(Boolean)
}

/**
 * Escape-sequence scrubbing for `plain` session logs. Built via `new RegExp`
 * from escaped strings so no raw control bytes live in this source file.
 */
/* eslint-disable no-control-regex -- stripping control sequences is the point */
// OSC string: ESC ] ... terminated by BEL or ST (ESC \)
const ANSI_OSC = new RegExp('\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)', 'g')
// CSI sequence: ESC [ params intermediates final
const ANSI_CSI = new RegExp('\\u001b\\[[0-9;?]*[ -/]*[@-~]', 'g')
// nF escapes: ESC, one or more intermediates, one final (e.g. charset "ESC ( B")
const ANSI_NF = new RegExp('\\u001b[ -/]+[0-~]', 'g')
// Remaining two-character escapes: ESC followed by a single byte
const ANSI_OTHER = new RegExp('\\u001b[@-Z\\\\-_]', 'g')
/** Stray control bytes that would otherwise land in the log file. */
const CONTROL_BYTES = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g')
/* eslint-enable no-control-regex */

export const stripAnsi = (text: string): string =>
  text
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_NF, '')
    .replace(ANSI_OTHER, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(CONTROL_BYTES, '')

export type SessionLogFormat = 'raw' | 'plain'

interface SessionLog {
  stream: WriteStream
  path: string
  format: SessionLogFormat
  startedAt: Date
  bytesWritten: number
}

export interface SSHSession extends EventEmitter {
  id: string
  profile: Profile
  client: Client
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  lastActivity: Date
  createdAt: Date
  error?: string
  /** Rolling ANSI-stripped transcript, for assistant context. */
  transcript: string
  /**
   * Rolling *raw* output, escape sequences intact, so a pane that mounts later
   * can be filled in. A window opened after a session started — a pop-out, or
   * the second window of a multi-monitor setup — has no history of its own.
   */
  scrollback: string
  /**
   * Terminal size reported by the pane, kept even before the shell exists.
   *
   * The pane measures itself and asks for a resize as soon as it is on screen,
   * which is usually *before* the SSH shell is open. Dropping that size left
   * the remote pty at ssh2's default 80x24 while the window was much bigger,
   * so full-screen programs — nano, vim, top — drew into a corner of it.
   */
  pendingSize?: { cols: number; rows: number }
  /**
   * Whether the remote has turned bracketed paste on (DECSET 2004).
   *
   * Tracked here rather than read off the renderer's xterm instance because a
   * session's pane can be in a detached window, so the window doing the pasting
   * may have no terminal to ask.
   */
  bracketedPaste: boolean
  /** Tail of the last chunk, so an escape sequence split across reads is seen. */
  modeScanCarry: string
  shell?: any
  /** Present only on serial sessions. */
  serialPort?: { close: (cb?: (e?: Error | null) => void) => void }
  /** Present only on local-shell sessions. */
  pty?: { kill: () => void }
  log?: SessionLog
}

/** Lets the macro engine look up call targets without importing the database. */
export interface MacroResolver {
  getMacro(id: string): Macro | null
  listMacrosInSet(setId: string): Macro[]
}

/**
 * Reads a script out of the library folder for a `runScript` step. Injected by
 * main so the engine never touches the filesystem or the settings store itself.
 */
export type ScriptProvider = (
  relativePath: string
) => Promise<{ content: string; name: string }>

/**
 * Single-quotes a string for a POSIX shell.
 *
 * Everything here ends up on a command line on someone's production kit, and
 * parts of it (arguments, remote directory) can come from `{{var}}` values the
 * operator typed, so nothing is interpolated raw.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Builds the one line that runs a staged script and tidies up after it.
 *
 * Deliberately a single line rather than three. Sending `chmod`, the script and
 * `rm` as separate lines means the later ones sit in the tty's input queue
 * while the script runs — and a script that reads from stdin would swallow its
 * own cleanup command. On one line the shell parses it up front, the script
 * still owns the terminal, and `;` before `rm` runs the cleanup whether the
 * script succeeded, failed or was interrupted.
 *
 * `interpreter` is intentionally not quoted: it is operator-authored and may
 * legitimately carry arguments, e.g. `sudo bash` or `python3 -u`.
 */
export function buildScriptCommand(options: {
  remotePath: string
  interpreter?: string
  args?: string
  cleanup?: boolean
}): string {
  const quoted = shellQuote(options.remotePath)
  const invocation = options.interpreter
    ? `${options.interpreter} ${quoted}`
    : `chmod +x ${quoted} && ${quoted}`

  const withArgs = options.args ? `${invocation} ${options.args}` : invocation
  return options.cleanup === false ? withArgs : `${withArgs}; rm -f ${quoted}`
}

/** Resolves a managed key id to decrypted key material at connect time. */
export type PrivateKeyProvider = (
  keyId: string
) => Promise<{ privateKey: string; passphrase?: string } | null>

/**
 * Supplies the global variables every run starts with. Called per run rather
 * than cached so an edit to the file lands on the next button press.
 */
export type GlobalVariableProvider = () => Record<string, string>

export interface MacroRunResult {
  success: boolean
  error?: string
  /** Every `send` step actually issued, after interpolation. */
  commands: string[]
}

/** A macro in flight on one session. */
export interface RunningMacro {
  sessionId: string
  macroId: string
  macroName: string
  /** Host label, so a warning can name the box rather than a session id. */
  profileName: string
  startedAt: Date
}

/** Frame of the macro call stack, used for cycle detection and progress. */
interface CallFrame {
  macroId: string
  macroName: string
}

/** Thrown by an `exit` step to unwind without marking the run as failed. */
class ExitSignal extends Error {
  constructor(public readonly all: boolean) {
    super('exit')
    this.name = 'ExitSignal'
  }
}

export class SSHManager extends EventEmitter {
  private sessions = new Map<string, SSHSession>()
  private keepaliveIntervals = new Map<string, NodeJS.Timeout>()
  private cancelledRuns = new Set<string>()
  /**
   * The macro currently running on each session, keyed by session id.
   *
   * This is the only record that a session is busy, and three things depend on
   * it: refusing a second run on the same shell, warning before a session is
   * closed, and warning before the app quits.
   *
   * Two runs on one session were previously impossible only because the button
   * panel disabled every button while any macro ran. That flag was global, so
   * it also stopped work on *other* hosts — removing it is what makes a
   * long-running button usable, and what makes this lock necessary rather than
   * theoretical. Without it the two runs interleave writes into one shell, and
   * the second run's `cancelledRuns.delete` silently discards a cancellation
   * meant for the first.
   */
  private runningMacros = new Map<string, RunningMacro>()
  /** Resolver for the `pause` step currently blocking each session's run. */
  private pendingResumes = new Map<string, () => void>()
  /** In-flight inline `form` steps, keyed by request id. */
  private pendingForms = new Map<
    string,
    { sessionId: string; settle: (values: Record<string, string> | null) => void }
  >()
  /** In-flight inline `confirm` steps, keyed by request id. */
  private pendingConfirms = new Map<
    string,
    { sessionId: string; settle: (confirmed: boolean) => void }
  >()
  private macroResolver: MacroResolver | null = null
  private scriptProvider: ScriptProvider | null = null
  private privateKeyProvider: PrivateKeyProvider | null = null
  private globalVariableProvider: GlobalVariableProvider | null = null
  /** Root that upload and download steps are confined to. */
  private transferDirProvider: (() => string) | null = null
  private logDirectory: string
  private defaultLogFormat: SessionLogFormat = 'plain'

  constructor(logDirectory: string) {
    super()
    this.logDirectory = logDirectory
  }

  setMacroResolver(resolver: MacroResolver) {
    this.macroResolver = resolver
  }

  setScriptProvider(provider: ScriptProvider) {
    this.scriptProvider = provider
  }

  /**
   * Where transfers may read and write. Injected rather than read here so the
   * engine never touches the settings store, and so a change to the setting is
   * live on the next button press rather than at the next restart.
   */
  setTransferDirProvider(provider: () => string) {
    this.transferDirProvider = provider
  }

  /** Variables every macro run inherits, from the user's globals file. */
  setGlobalVariableProvider(provider: GlobalVariableProvider) {
    this.globalVariableProvider = provider
  }

  /** Never lets a broken globals file stop a button from running. */
  globalVariables(): Record<string, string> {
    if (!this.globalVariableProvider) return {}
    try {
      return this.globalVariableProvider()
    } catch (error) {
      console.error('Could not read global variables:', error)
      return {}
    }
  }

  /**
   * Opens an SFTP channel, or explains why the device cannot.
   *
   * A great many network devices answer SSH perfectly and run no SFTP
   * subsystem at all — switches, firewalls, PDUs. ssh2 reports that as a bare
   * "Channel open failure", which reads like a bug in this app rather than a
   * property of the far end, so it is translated here. This is the single most
   * likely reason a transfer button fails, and it fails on the device the
   * operator least expects.
   */
  private openSftp(session: SSHSession): Promise<any> {
    if (session.profile.transport !== 'ssh') {
      throw new Error(
        session.profile.transport === 'local'
          ? 'File transfer needs SSH. This connection is a local shell — copy the file yourself.'
          : 'File transfer needs SSH. This connection is a serial port.'
      )
    }

    return new Promise((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(
            new Error(
              `${session.profile.name} did not open an SFTP channel: ${err.message}. ` +
                'Many switches and firewalls answer SSH but run no SFTP subsystem — ' +
                'check whether this device supports it.'
            )
          )
          return
        }
        resolve(sftp)
      })
    })
  }

  /**
   * Fetches a file from the host.
   *
   * `fastGet` rather than a stream so ssh2 pipelines the reads — a capture file
   * is routinely hundreds of megabytes, and a naive read is slow enough over a
   * long link that it looks hung.
   */
  async downloadFile(
    sessionId: string,
    remotePath: string,
    localPath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<{ bytes: number }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')

    const sftp = await this.openSftp(session)

    try {
      // Stat first: it turns "no such file" into a clear message before any
      // local file is created, and gives the progress bar a denominator.
      const stats: any = await new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err: Error | undefined, result: any) =>
          err ? reject(new Error(`${remotePath} is not readable on the host: ${err.message}`)) : resolve(result)
        )
      })

      if (stats.isDirectory?.()) {
        throw new Error(`${remotePath} is a directory. Transfer steps move one file at a time.`)
      }

      const total: number = stats.size ?? 0

      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(
          remotePath,
          localPath,
          {
            step: (transferred: number) => {
              // Cancelling has to reach a transfer that may run for minutes;
              // the step callback is the only place the engine gets a look in.
              if (this.cancelledRuns.has(sessionId)) {
                reject(new Error('Macro cancelled'))
                return
              }
              onProgress?.(transferred, total)
            },
          },
          (err: Error | undefined) => (err ? reject(err) : resolve())
        )
      })

      return { bytes: total }
    } finally {
      sftp.end()
    }
  }

  /** Sends a local file to the host. */
  async uploadFile(
    sessionId: string,
    localPath: string,
    remotePath: string,
    onProgress?: (transferred: number, total: number) => void
  ): Promise<{ bytes: number }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')

    const { statSync } = await import('fs')
    const total = statSync(localPath).size

    const sftp = await this.openSftp(session)

    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(
          localPath,
          remotePath,
          {
            step: (transferred: number) => {
              if (this.cancelledRuns.has(sessionId)) {
                reject(new Error('Macro cancelled'))
                return
              }
              onProgress?.(transferred, total)
            },
          },
          (err: Error | undefined) =>
            err
              ? reject(
                  new Error(
                    `Could not write ${remotePath}: ${err.message}. ` +
                      'Check the directory exists and the account can write to it.'
                  )
                )
              : resolve()
        )
      })

      return { bytes: total }
    } finally {
      sftp.end()
    }
  }

  /**
   * Writes a script to the host over SFTP.
   *
   * SFTP rather than the shell: piping a heredoc into an interactive session
   * mangles anything containing the delimiter, trips over flow control on slow
   * links, and would dump the whole file into the operator's scrollback.
   */
  private uploadScript(session: SSHSession, remotePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      session.client.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`Could not open SFTP on this host: ${err.message}`))
          return
        }

        // 0o700: staged in a shared directory like /tmp, so it must not be
        // readable or runnable by other users on the box.
        const stream = sftp.createWriteStream(remotePath, { mode: 0o700 })

        stream.on('error', (streamError: Error) => {
          sftp.end()
          reject(new Error(`Could not write ${remotePath}: ${streamError.message}`))
        })

        stream.on('close', () => {
          sftp.end()
          resolve()
        })

        stream.end(Buffer.from(content, 'utf8'))
      })
    })
  }

  /**
   * Stages a library script on the host and returns where it landed.
   *
   * The name is randomised and hidden rather than reusing the script's own
   * name: two operators running the same button against the same box must not
   * collide, and a predictable path in a world-writable /tmp is a symlink
   * attack waiting to happen.
   */
  async stageScript(
    sessionId: string,
    relativePath: string,
    remoteDir: string
  ): Promise<{ remotePath: string; name: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (session.profile.transport !== 'ssh') {
      throw new Error(
        session.profile.transport === 'local'
          ? 'Scripts can only be copied over SSH — this is a local shell, so run the file directly'
          : 'Scripts can only be copied over SSH — this is a serial connection'
      )
    }
    if (!this.scriptProvider) throw new Error('Script library is not configured')

    const script = await this.scriptProvider(relativePath)
    const directory = (remoteDir || '/tmp').replace(/\/+$/, '') || '/'
    const safeName = script.name.replace(/[^\w.-]+/g, '_')
    const remotePath = `${directory}/.smartcom-${randomBytes(4).toString('hex')}-${safeName}`

    await this.uploadScript(session, remotePath, script.content)
    return { remotePath, name: script.name }
  }

  /** Supplies decrypted private keys for profiles that use a managed key. */
  setPrivateKeyProvider(provider: PrivateKeyProvider) {
    this.privateKeyProvider = provider
  }

  configureLogging(options: { directory?: string; format?: SessionLogFormat }) {
    if (options.directory) this.logDirectory = options.directory
    if (options.format) this.defaultLogFormat = options.format
  }

  /** Routes to the right transport. Everything downstream is identical. */
  async createSession(profile: Profile, options: { autoLog?: boolean } = {}): Promise<string> {
    if (profile.transport === 'serial') return this.createSerialSession(profile, options)
    if (profile.transport === 'local') return this.createLocalSession(profile, options)
    return this.createSshSession(profile, options)
  }

  /**
   * Starts a shell on this machine — WSL, PowerShell, cmd, bash, zsh.
   *
   * Like the serial path, this only has to present `session.shell` and the
   * `output` event; the macro engine, `expect`, session logging and the
   * assistant all work off those and need to know nothing about ptys. Unlike
   * serial, a pty *does* have a window size, so `setWindow` is real here and
   * full-screen programs resize with the pane.
   */
  private async createLocalSession(
    profile: Profile,
    options: { autoLog?: boolean } = {}
  ): Promise<string> {
    const sessionId = uuidv4()

    const session: SSHSession = Object.assign(new EventEmitter(), {
      id: sessionId,
      profile,
      client: null as unknown as Client,
      status: 'connecting' as const,
      lastActivity: new Date(),
      createdAt: new Date(),
      transcript: '',
      scrollback: '',
      bracketedPaste: false,
      modeScanCarry: '',
    })

    this.sessions.set(sessionId, session)

    try {
      // Imported lazily, as serialport is, so a machine whose native module
      // failed to load still fails on the one connection that needs it
      // rather than with a main process that will not start at all.
      const { spawn } = await import('node-pty')
      const { homedir } = await import('os')

      // Start at the size the pane already reported. Opening at 80x24 and
      // waiting for a resize is what left nano drawing into a corner of the
      // pane on SSH, and a pty here has exactly the same problem.
      const { cols, rows } = session.pendingSize ?? { cols: 80, rows: 24 }
      const cwd = profile.shellCwd?.trim() || homedir()

      const term = spawn(profile.shellCommand!, profile.shellArgs ?? [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: localShellEnv(),
      })

      session.pty = term
      session.shell = {
        write: (text: string) => term.write(text),
        setWindow: (nextRows: number, nextCols: number) => {
          // A pane can report a zero dimension for one frame while it is
          // being laid out, and ConPTY throws on a zero-sized resize.
          if (nextCols > 0 && nextRows > 0) term.resize(nextCols, nextRows)
        },
        close: () => term.kill(),
      }

      term.onData((data: string) => {
        session.lastActivity = new Date()
        session.emit('output', data)
        this.recordTranscript(session, data)
        this.writeSessionLog(session, data)
        this.emit('session-data', sessionId, data)
      })

      term.onExit(({ exitCode, signal }) => {
        // The shell exiting is the normal way a local session ends — the
        // operator typed `exit`. Reporting the code is what separates that
        // from a shell that died on startup, where the pane would otherwise
        // just go quiet with no explanation.
        const detail = [
          exitCode ? ` with code ${exitCode}` : '',
          signal ? ` (signal ${signal})` : '',
        ].join('')
        this.emit(
          'session-data',
          sessionId,
          `\r\n\x1b[90m[${profile.name} exited${detail}]\x1b[0m\r\n`
        )
        session.status = 'disconnected'
        this.emit('session-status', sessionId, 'disconnected')
        this.cleanup(sessionId)
      })

      session.status = 'connected'
      session.lastActivity = new Date()
      this.emit('session-status', sessionId, 'connected')

      // The pane may have been resized again while the pty was starting.
      if (session.pendingSize) {
        const latest = session.pendingSize
        if (latest.cols !== cols || latest.rows !== rows) {
          session.shell.setWindow(latest.rows, latest.cols, 0, 0)
        }
      }

      if (options.autoLog) {
        try {
          this.startLogging(sessionId)
        } catch (logError) {
          this.emit('session-data', sessionId, `\r\n[log] failed to start: ${logError}\r\n`)
        }
      }

      this.emit('session-ready', sessionId)
    } catch (error) {
      session.status = 'error'
      session.error =
        error instanceof Error
          ? `Could not start ${profile.shellCommand}: ${error.message}`
          : 'Unknown error'
      this.emit('session-status', sessionId, 'error', session.error)
      this.cleanup(sessionId)
    }

    return sessionId
  }

  /**
   * Opens a serial session.
   *
   * The macro engine, session logging and `expect` all work through
   * `session.shell.write()` and the session's `output` event, so a serial port
   * only has to present that same shape — nothing else needs to know.
   */
  private async createSerialSession(
    profile: Profile,
    options: { autoLog?: boolean } = {}
  ): Promise<string> {
    const sessionId = uuidv4()

    const session: SSHSession = Object.assign(new EventEmitter(), {
      id: sessionId,
      profile,
      client: null as unknown as Client,
      status: 'connecting' as const,
      lastActivity: new Date(),
      createdAt: new Date(),
      transcript: '',
      scrollback: '',
      bracketedPaste: false,
      modeScanCarry: '',
    })

    this.sessions.set(sessionId, session)

    try {
      const { SerialPort } = await import('serialport')

      const port = new SerialPort({
        path: profile.serialPath!,
        baudRate: profile.baudRate,
        dataBits: profile.dataBits,
        stopBits: profile.stopBits,
        parity: profile.parity,
        rtscts: profile.flowControl === 'rtscts',
        xon: profile.flowControl === 'xonxoff',
        xoff: profile.flowControl === 'xonxoff',
        autoOpen: false,
      })

      port.on('data', (data: Buffer) => {
        const text = data.toString('utf8')
        session.lastActivity = new Date()
        session.emit('output', text)
        this.recordTranscript(session, text)
        this.writeSessionLog(session, text)
        this.emit('session-data', sessionId, text)
      })

      port.on('error', (error: Error) => {
        session.status = 'error'
        session.error = error.message
        this.emit('session-status', sessionId, 'error', error.message)
      })

      port.on('close', () => {
        session.status = 'disconnected'
        this.emit('session-status', sessionId, 'disconnected')
        this.cleanup(sessionId)
      })

      // A serial line has no window size, so setWindow is a no-op.
      session.shell = {
        write: (text: string) => port.write(text),
        setWindow: () => undefined,
        close: () => port.close(),
      }
      session.serialPort = port

      port.open((error) => {
        if (error) {
          session.status = 'error'
          session.error = error.message
          this.emit('session-status', sessionId, 'error', error.message)
          this.cleanup(sessionId)
          return
        }

        session.status = 'connected'
        session.lastActivity = new Date()
        this.emit('session-status', sessionId, 'connected')
        this.emit(
          'session-data',
          sessionId,
          `\r\n\x1b[32mOpened ${profile.serialPath} at ${profile.baudRate} ` +
            `${profile.dataBits}${profile.parity[0].toUpperCase()}${profile.stopBits}\x1b[0m\r\n`
        )

        if (options.autoLog) {
          try {
            this.startLogging(sessionId)
          } catch (logError) {
            this.emit('session-data', sessionId, `\r\n[log] failed to start: ${logError}\r\n`)
          }
        }

        this.emit('session-ready', sessionId)
      })
    } catch (error) {
      session.status = 'error'
      session.error = error instanceof Error ? error.message : 'Unknown error'
      this.emit('session-status', sessionId, 'error', session.error)
    }

    return sessionId
  }

  private async createSshSession(
    profile: Profile,
    options: { autoLog?: boolean } = {}
  ): Promise<string> {
    const sessionId = uuidv4()
    const client = new Client()

    const session: SSHSession = Object.assign(new EventEmitter(), {
      id: sessionId,
      profile,
      client,
      status: 'connecting' as const,
      lastActivity: new Date(),
      createdAt: new Date(),
      transcript: '',
      scrollback: '',
      bracketedPaste: false,
      modeScanCarry: '',
    })

    this.sessions.set(sessionId, session)

    try {
      const connectConfig = await this.buildConnectConfig(profile)

      client.on('ready', () => {
        session.status = 'connected'
        session.lastActivity = new Date()
        this.emit('session-status', sessionId, 'connected')

        // Open the pty at the size the pane already reported. Without this it
        // starts at ssh2's default 80x24 and stays there until the user happens
        // to resize the window, which is why nano and friends filled only part
        // of the screen.
        const { cols, rows } = session.pendingSize ?? { cols: 80, rows: 24 }

        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) {
            session.status = 'error'
            session.error = err.message
            this.emit('session-status', sessionId, 'error', err.message)
            return
          }

          session.shell = stream

          // The pane may have been resized again while the shell was opening.
          if (session.pendingSize) {
            const latest = session.pendingSize
            if (latest.cols !== cols || latest.rows !== rows) {
              stream.setWindow(latest.rows, latest.cols, 0, 0)
            }
          }

          const handleOutput = (data: Buffer) => {
            const text = data.toString('utf8')
            session.lastActivity = new Date()
            // Drives `expect` steps without each one touching the raw stream.
            session.emit('output', text)
            this.recordTranscript(session, text)
            this.writeSessionLog(session, text)
            this.emit('session-data', sessionId, text)
          }

          stream.on('data', handleOutput)
          stream.stderr.on('data', handleOutput)

          stream.on('close', () => {
            session.status = 'disconnected'
            this.emit('session-status', sessionId, 'disconnected')
            this.cleanup(sessionId)
          })

          if (options.autoLog) {
            try {
              this.startLogging(sessionId)
            } catch (error) {
              this.emit('session-data', sessionId, `\r\n[log] failed to start: ${error}\r\n`)
            }
          }

          // The shell is only usable now, so startup scripts wait for this
          // rather than the earlier 'connected' status.
          this.emit('session-ready', sessionId)
        })

        this.startKeepalive(sessionId)
      })

      client.on('error', (err) => {
        session.status = 'error'
        session.error = err.message
        this.emit('session-status', sessionId, 'error', err.message)
        this.cleanup(sessionId)
      })

      client.on('close', () => {
        if (session.status === 'connected') {
          session.status = 'disconnected'
          this.emit('session-status', sessionId, 'disconnected')
        }
        this.cleanup(sessionId)
      })

      client.connect(connectConfig)
    } catch (error) {
      session.status = 'error'
      session.error = error instanceof Error ? error.message : 'Unknown error'
      this.emit('session-status', sessionId, 'error', session.error)
    }

    return sessionId
  }

  private async buildConnectConfig(profile: Profile): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: 30000,
    }

    if (profile.authMethod === 'password') {
      const password = await keytar.getPassword(VAULT_SERVICE, `${profile.id}:password`)
      if (password) {
        config.password = password
      }
    } else if (profile.authMethod === 'key') {
      // A managed key (stored in the encrypted vault) wins over a file path.
      if (profile.keyId && this.privateKeyProvider) {
        const managed = await this.privateKeyProvider(profile.keyId)
        if (!managed) {
          throw new Error(`Managed key ${profile.keyId} not found in the vault`)
        }
        config.privateKey = managed.privateKey
        if (managed.passphrase) config.passphrase = managed.passphrase
      } else if (profile.keyPath) {
        const { readFileSync } = await import('fs')
        try {
          config.privateKey = readFileSync(profile.keyPath)
        } catch (error) {
          throw new Error(`Failed to read private key: ${error}`)
        }
        const passphrase = await keytar.getPassword(VAULT_SERVICE, `${profile.id}:passphrase`)
        if (passphrase) {
          config.passphrase = passphrase
        }
      } else {
        throw new Error('Key authentication selected but no key was configured')
      }
    } else if (profile.authMethod === 'agent') {
      config.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? 'pageant' : undefined)
    }

    return config
  }

  private startKeepalive(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session || session.status !== 'connected') return
    // Nothing to keep alive on a serial line or a shell on this machine.
    if (session.profile.transport !== 'ssh') return

    const interval = setInterval(() => {
      const current = this.sessions.get(sessionId)
      if (!current || current.status !== 'connected') {
        clearInterval(interval)
        this.keepaliveIntervals.delete(sessionId)
        return
      }
      // ssh2 keeps the transport alive without spawning a channel.
      const client = current.client as unknown as { ping?: () => void }
      client.ping?.()
    }, 30000)

    this.keepaliveIntervals.set(sessionId, interval)
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    if (session.serialPort) {
      session.serialPort.close(() => undefined)
    } else if (session.pty) {
      session.pty.kill()
    } else {
      session.client?.end()
    }
    this.cleanup(sessionId)
    return true
  }

  private cleanup(sessionId: string) {
    const interval = this.keepaliveIntervals.get(sessionId)
    if (interval) {
      clearInterval(interval)
      this.keepaliveIntervals.delete(sessionId)
    }
    this.stopLogging(sessionId)
    this.cancelledRuns.delete(sessionId)
    // A run whose session has gone cannot continue, so the lock must go with
    // it — otherwise a dropped connection leaves the id marked busy forever and
    // the warnings would keep naming a host that is no longer open.
    if (this.runningMacros.delete(sessionId)) {
      this.emit('macro-running-changed', this.listRunningMacros())
    }
    this.sessions.delete(sessionId)
  }

  // ---------------------------------------------------------------------------
  // PuTTY-style session logging
  // ---------------------------------------------------------------------------

  private buildLogPath(session: SSHSession): string {
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19)
    const safeName = session.profile.name.replace(/[^A-Za-z0-9._-]+/g, '_')
    return join(this.logDirectory, `${safeName}_${stamp}.log`)
  }

  startLogging(
    sessionId: string,
    filePath?: string,
    format?: SessionLogFormat
  ): { path: string; format: SessionLogFormat } {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')

    // Restarting replaces the previous file rather than writing to both.
    if (session.log) this.stopLogging(sessionId)

    const path = filePath || this.buildLogPath(session)
    mkdirSync(dirname(path), { recursive: true })

    const stream = createWriteStream(path, { flags: 'a', encoding: 'utf8' })
    stream.on('error', (error) => {
      this.emit('session-data', sessionId, `\r\n[log] write error: ${error.message}\r\n`)
      session.log = undefined
      this.emit('session-log-changed', sessionId, null)
    })

    const resolvedFormat = format || this.defaultLogFormat
    const startedAt = new Date()

    session.log = { stream, path, format: resolvedFormat, startedAt, bytesWritten: 0 }

    const header =
      `=~=~=~=~=~=~=~=~=~=~=~= Smartcom Revisited log ${startedAt.toISOString()} =~=~=~=~=~=~=~=~=~=~=~=\n` +
      `Session: ${session.profile.name} (${session.profile.username}@${session.profile.host}:${session.profile.port})\n\n`
    stream.write(header)

    this.emit('session-log-changed', sessionId, path)
    return { path, format: resolvedFormat }
  }

  stopLogging(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session?.log) return false

    const { stream } = session.log
    stream.end(`\n=~=~=~=~ Smartcom Revisited log closed ${new Date().toISOString()} =~=~=~=~\n`)
    session.log = undefined
    this.emit('session-log-changed', sessionId, null)
    return true
  }


  /**
   * Keeps a bounded ANSI-free transcript for the assistant, and a bounded raw
   * copy that a newly mounted pane can replay so it is not blank.
   */
  private recordTranscript(session: SSHSession, text: string) {
    // Follows the remote switching bracketed paste on and off, so a paste is
    // only wrapped in the markers when the far end will consume them.
    const mode = trackBracketedPaste(
      { enabled: session.bracketedPaste, carry: session.modeScanCarry },
      text
    )
    session.bracketedPaste = mode.enabled
    session.modeScanCarry = mode.carry

    const rawCombined = session.scrollback + text
    session.scrollback =
      rawCombined.length > MAX_SCROLLBACK_CHARS
        ? rawCombined.slice(-MAX_SCROLLBACK_CHARS)
        : rawCombined

    const clean = stripAnsi(text)
    if (!clean) return
    const combined = session.transcript + clean
    session.transcript =
      combined.length > MAX_TRANSCRIPT_CHARS ? combined.slice(-MAX_TRANSCRIPT_CHARS) : combined
  }

  /** Raw output so far, for a pane that mounted after the session started. */
  getScrollback(sessionId: string): string {
    return this.sessions.get(sessionId)?.scrollback ?? ''
  }
  private writeSessionLog(session: SSHSession, text: string) {
    const log = session.log
    if (!log) return

    const payload = log.format === 'plain' ? stripAnsi(text) : text
    if (!payload) return

    log.bytesWritten += Buffer.byteLength(payload, 'utf8')
    log.stream.write(payload)
  }

  getLogStatus(): Record<string, { path: string; format: SessionLogFormat; bytesWritten: number; startedAt: string }> {
    const status: Record<string, any> = {}
    for (const [id, session] of this.sessions) {
      if (session.log) {
        status[id] = {
          path: session.log.path,
          format: session.log.format,
          bytesWritten: session.log.bytesWritten,
          startedAt: session.log.startedAt.toISOString(),
        }
      }
    }
    return status
  }

  // ---------------------------------------------------------------------------
  // I/O
  // ---------------------------------------------------------------------------

  sendToSession(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || !session.shell || session.status !== 'connected') {
      return false
    }

    session.shell.write(text)
    session.lastActivity = new Date()
    return true
  }

  /**
   * Sends text as a *paste* rather than as typing.
   *
   * Writing the clipboard straight through corrupts anything multi-line: CRLF
   * reads as two Enters, and without the bracketed-paste markers the remote
   * treats the block as keystrokes and auto-indents it. See `preparePaste`.
   * Whether the markers are safe is tracked per session from the remote's own
   * DECSET 2004 switching, so this works for a pane in any window.
   */
  pasteToSession(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    return this.sendToSession(sessionId, preparePaste(text, session.bracketedPaste))
  }

  /**
   * Puts an assistant suggestion on the command line without running it.
   *
   * Separate from `pasteToSession` because the two have different contracts. A
   * clipboard paste is the operator deliberately putting their own text on the
   * wire, newlines and all — pasting a config block into a switch is a normal
   * thing to want. An assistant suggestion is machine-written text the operator
   * has not committed to yet, and the panel promises it is never run for them
   * (see `src/shared/assistant-contract.ts`).
   *
   * Two rules keep that promise:
   *
   *  - **Trailing line terminators are stripped.** Otherwise the last command
   *    of the suggestion submits itself, which is exactly "the assistant ran
   *    it" from where the operator is sitting.
   *  - **Multi-line text is refused when the remote is not in bracketed-paste
   *    mode.** `preparePaste` turns newlines into CR, and a remote that cannot
   *    tell a paste from typing acts on each one — a Cisco console or a PBX at
   *    a serial prompt would run every line. Bracketed paste is what makes a
   *    block land as text, so without it the only safe answer is no. The
   *    operator still has Copy, and the ordinary paste path, both of which are
   *    their own decision rather than the assistant's.
   */
  insertSuggestion(
    sessionId: string,
    text: string
  ): { inserted: boolean; reason?: string; lines: number } {
    const session = this.sessions.get(sessionId)
    if (!session) return { inserted: false, reason: 'Session not found', lines: 0 }

    const body = text.replace(/[\r\n]+$/, '')
    const lines = body === '' ? 0 : body.split(/\r\n|\r|\n/).length

    if (body === '') return { inserted: false, reason: 'Nothing to insert', lines: 0 }

    if (lines > 1 && !session.bracketedPaste) {
      return {
        inserted: false,
        lines,
        reason:
          'This remote cannot tell a paste from typing right now, so the lines ' +
          'would run one by one. Use Copy and paste it yourself if that is what you want.',
      }
    }

    const sent = this.sendToSession(sessionId, preparePaste(body, session.bracketedPaste))
    return sent
      ? { inserted: true, lines }
      : { inserted: false, reason: 'Session is not connected', lines }
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false

    // Always remember it: a size that arrives before the shell is open is the
    // common case, not an edge case, and it is the one that decides how big the
    // remote thinks the terminal is for the whole session.
    session.pendingSize = { cols, rows }

    if (!session.shell || session.status !== 'connected') return false

    session.shell.setWindow(rows, cols, 0, 0)
    return true
  }

  /** Recent ANSI-stripped output for a session, for grounding the assistant. */
  getTranscript(sessionId: string): string {
    return this.sessions.get(sessionId)?.transcript ?? ''
  }

  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      profileId: session.profile.id!,
      profileName: session.profile.name,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
      error: session.error,
      logPath: session.log?.path,
    }))
  }

  // ---------------------------------------------------------------------------
  // Macro engine
  // ---------------------------------------------------------------------------

  cancelMacro(sessionId: string) {
    this.cancelledRuns.add(sessionId)
    // Unblock anything the run is parked on so cancellation takes effect now.
    this.pendingResumes.get(sessionId)?.()
    this.rejectPendingForms(sessionId)
  }

  /** Releases a macro parked on a `pause` step. */
  resumeMacro(sessionId: string): boolean {
    const resume = this.pendingResumes.get(sessionId)
    if (!resume) return false
    resume()
    return true
  }

  /** Delivers the operator's answers to an inline `form` step. */
  submitMacroForm(requestId: string, values: Record<string, string> | null): boolean {
    const pending = this.pendingForms.get(requestId)
    if (!pending) return false
    this.pendingForms.delete(requestId)
    pending.settle(values)
    return true
  }

  /** Answers an inline `confirm` step. Declining stops the run. */
  submitMacroConfirm(requestId: string, confirmed: boolean): boolean {
    const pending = this.pendingConfirms.get(requestId)
    if (!pending) return false
    this.pendingConfirms.delete(requestId)
    pending.settle(confirmed)
    return true
  }

  /**
   * Fails every prompt still waiting on a session (used when a run is
   * cancelled). A cancelled run must not leave a confirm dialog on screen with
   * nothing behind it, so confirms settle as declined.
   */
  private rejectPendingForms(sessionId: string) {
    for (const [requestId, pending] of Array.from(this.pendingForms.entries())) {
      if (pending.sessionId === sessionId) {
        this.pendingForms.delete(requestId)
        pending.settle(null)
      }
    }
    for (const [requestId, pending] of Array.from(this.pendingConfirms.entries())) {
      if (pending.sessionId === sessionId) {
        this.pendingConfirms.delete(requestId)
        pending.settle(false)
      }
    }
  }

  /**
   * Runs `macro` against a session. Steps of type `callMacro` / `callSet`
   * recurse through this same path, so a button can chain whole button sets.
   */
  async runMacro(
    sessionId: string,
    macro: Macro,
    variables: Record<string, string> = {}
  ): Promise<MacroRunResult> {
    const session = this.sessions.get(sessionId)
    if (!session || !session.shell || session.status !== 'connected') {
      return { success: false, error: 'Session not connected', commands: [] }
    }

    // One macro per shell. Refusing is the only safe answer: the two runs would
    // interleave their writes, and there is no way to tell afterwards which
    // command belonged to which. Queueing would be worse — the operator pressed
    // the button expecting it to run now, not in an hour.
    const inFlight = this.runningMacros.get(sessionId)
    if (inFlight) {
      return {
        success: false,
        error: `"${inFlight.macroName}" is already running on ${inFlight.profileName}. Wait for it to finish, or stop it first.`,
        commands: [],
      }
    }

    this.runningMacros.set(sessionId, {
      sessionId,
      macroId: macro.id ?? '',
      macroName: macro.name,
      profileName: session.profile.name,
      startedAt: new Date(),
    })
    this.emit('macro-running-changed', this.listRunningMacros())

    this.cancelledRuns.delete(sessionId)
    const commands: string[] = []

    // Precedence, lowest first: built-ins, globals, field defaults, then what
    // the operator actually typed.
    //
    // Built-ins are bottom so a global or a field named EPOCH still wins —
    // adding a name to this list must never change what an existing button
    // does. They are computed once here rather than per step, so a filename
    // built in one step and collected in another names the same file; see
    // builtin-vars.ts.
    const scope: Record<string, string> = {
      ...builtinVariables({
        host: session.profile.host,
        username: session.profile.username,
        profileName: session.profile.name,
      }),
      ...this.globalVariables(),
    }

    // Field defaults fill any variable the caller did not supply.
    for (const field of resolveFields(macro)) {
      if (field.defaultValue) scope[field.name] = field.defaultValue
    }
    Object.assign(scope, variables)

    try {
      await this.runMacroFrames(session, macro, scope, [], commands)
      return { success: true, commands }
    } catch (error) {
      // A top-level `exit all` is a deliberate stop, not a failure.
      if (error instanceof ExitSignal) {
        return { success: true, commands }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        commands,
      }
    } finally {
      this.pendingResumes.delete(sessionId)
      this.rejectPendingForms(sessionId)
      // Released here rather than at each return: an exception, a cancel and a
      // clean finish must all free the shell, or the host stays busy forever
      // and nothing can run on it again without a reconnect.
      this.runningMacros.delete(sessionId)
      this.emit('macro-running-changed', this.listRunningMacros())
    }
  }

  /** Macros in flight, for the busy indicators and the close/quit warnings. */
  listRunningMacros(): RunningMacro[] {
    return [...this.runningMacros.values()]
  }

  /** True when a macro is running on this session. */
  isSessionBusy(sessionId: string): boolean {
    return this.runningMacros.has(sessionId)
  }

  private async runMacroFrames(
    session: SSHSession,
    macro: Macro,
    variables: Record<string, string>,
    stack: CallFrame[],
    commands: string[]
  ): Promise<void> {
    if (stack.length >= MAX_CALL_DEPTH) {
      throw new Error(`Macro call depth limit (${MAX_CALL_DEPTH}) exceeded at "${macro.name}"`)
    }
    if (macro.id && stack.some((frame) => frame.macroId === macro.id)) {
      const chain = [...stack.map((f) => f.macroName), macro.name].join(' → ')
      throw new Error(`Recursive macro call detected: ${chain}`)
    }

    const nextStack = [...stack, { macroId: macro.id ?? macro.name, macroName: macro.name }]

    for (let index = 0; index < macro.steps.length; index++) {
      if (this.cancelledRuns.has(session.id)) {
        throw new Error('Macro cancelled')
      }

      const step = macro.steps[index]
      this.emit('macro-progress', session.id, {
        macroName: macro.name,
        stepIndex: index,
        stepCount: macro.steps.length,
        depth: nextStack.length,
      })

      try {
        await this.executeStep(session, step, variables, nextStack, commands)
      } catch (error) {
        if (error instanceof ExitSignal) {
          // `exit` ends this macro; `exit all` keeps unwinding to the caller.
          if (error.all) throw error
          return
        }
        if (step.continueOnError) continue
        throw error
      }
    }
  }

  private async executeStep(
    session: SSHSession,
    step: MacroStep,
    variables: Record<string, string>,
    stack: CallFrame[],
    commands: string[]
  ): Promise<void> {
    switch (step.type) {
      case 'send': {
        const base = interpolate(step.text || '', variables)
        const text = step.appendEnter ? `${base}\n` : base
        const repeat = Math.max(1, step.repeat ?? 1)

        for (let i = 0; i < repeat; i++) {
          if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')
          // The delay applies before every repetition, so N repeats stay paced
          // instead of collapsing into one burst.
          if (step.delayMs) await this.sleep(step.delayMs)
          session.shell.write(text)
          session.lastActivity = new Date()
          commands.push(base)
        }
        return
      }

      case 'expect': {
        if (!step.pattern) throw new Error('Expect step is missing a pattern')
        if (step.delayMs) await this.sleep(step.delayMs)
        const match = await this.waitForPattern(session, step.pattern, step.timeoutMs ?? 5000)
        // Named groups become variables for the steps that follow, so a button
        // can act on something the device chose — a generated filename, an
        // interface name, a job id — rather than only on what it already knew.
        // Mutates the caller's scope on purpose: that is how `form` already
        // makes its answers visible to later steps.
        Object.assign(variables, captureGroups(match))
        return
      }

      case 'delay': {
        await this.sleep(step.delayMs || 0)
        return
      }

      case 'form': {
        if (step.delayMs) await this.sleep(step.delayMs)

        const requestId = uuidv4()
        const answers = await new Promise<Record<string, string> | null>((resolve) => {
          this.pendingForms.set(requestId, { sessionId: session.id, settle: resolve })

          this.emit('macro-form-request', session.id, {
            requestId,
            title: interpolate(step.title || 'Enter values', variables),
            // Defaults may reference variables gathered earlier in the flow.
            fields: (step.fields ?? []).map((field) => ({
              ...field,
              defaultValue: interpolate(field.defaultValue ?? '', variables),
            })),
          })
        })

        // Dismissing the form stops the whole run rather than silently
        // continuing with unset variables.
        if (answers === null) throw new ExitSignal(true)

        // Mutated in place so later steps — and any macro this one calls —
        // see the newly collected values.
        Object.assign(variables, answers)
        return
      }

      case 'runScript': {
        if (!step.scriptPath) throw new Error('Run script step is missing a script')
        if (step.delayMs) await this.sleep(step.delayMs)

        const { remotePath } = await this.stageScript(
          session.id,
          interpolate(step.scriptPath, variables),
          interpolate(step.remoteDir || '/tmp', variables)
        )

        const line = buildScriptCommand({
          remotePath,
          interpreter: interpolate(step.interpreter || '', variables).trim(),
          args: interpolate(step.scriptArgs || '', variables).trim(),
          cleanup: step.cleanupAfterRun,
        })

        // Typed into the session so the operator watches it run in their own
        // terminal, it lands in the session log, and `expect` blocks after this
        // one can wait on its output.
        session.shell.write(`${line}\n`)
        session.lastActivity = new Date()
        commands.push(line)
        return
      }

      case 'confirm': {
        if (step.delayMs) await this.sleep(step.delayMs)

        const requestId = uuidv4()
        const confirmed = await new Promise<boolean>((resolve) => {
          this.pendingConfirms.set(requestId, { sessionId: session.id, settle: resolve })

          this.emit('macro-confirm-request', session.id, {
            requestId,
            title: interpolate(step.title || 'Confirm', variables),
            message: interpolate(step.message || 'Continue?', variables),
            confirmLabel: interpolate(step.confirmLabel || 'Yes', variables),
            cancelLabel: interpolate(step.cancelLabel || 'No', variables),
            destructive: step.destructive,
          })
        })

        // Declining stops the flow before the step it was guarding — that is
        // the whole point of the block. `exitAll` decides whether the macro
        // that called this one keeps going.
        if (!confirmed) throw new ExitSignal(step.exitAll)
        return
      }

      case 'pause': {
        this.emit('macro-progress', session.id, {
          awaitingResume: true,
          message: interpolate(step.message || 'Paused — click Resume to continue', variables),
        })

        await new Promise<void>((resolve) => {
          this.pendingResumes.set(session.id, () => {
            this.pendingResumes.delete(session.id)
            resolve()
          })
        })

        this.emit('macro-progress', session.id, { awaitingResume: false })
        if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')
        return
      }

      case 'if': {
        if (!step.pattern) throw new Error('If step is missing a pattern')
        if (step.delayMs) await this.sleep(step.delayMs)

        // A timeout here is the "else" path, not a failure.
        let matched = true
        try {
          const match = await this.waitForPattern(session, step.pattern, step.timeoutMs ?? 5000)
          // Captures bind on the matching path only — the else branch by
          // definition has nothing to bind, and leaving stale values from an
          // earlier iteration would be worse than leaving them unset.
          Object.assign(variables, captureGroups(match))
        } catch {
          matched = false
        }

        const branch = matched ? step.thenSteps : step.elseSteps
        await this.runNestedSteps(session, branch ?? [], variables, stack, commands)
        return
      }

      case 'exit': {
        if (step.delayMs) await this.sleep(step.delayMs)
        throw new ExitSignal(step.exitAll)
      }

      case 'callMacro': {
        if (!this.macroResolver) throw new Error('Macro resolver unavailable')
        if (!step.targetMacroId) throw new Error('Call step is missing a target macro')

        const target = this.macroResolver.getMacro(step.targetMacroId)
        if (!target) throw new Error(`Called macro not found: ${step.targetMacroId}`)

        if (step.delayMs) await this.sleep(step.delayMs)
        await this.runMacroFrames(
          session,
          target,
          this.buildCalleeScope(target, step, variables),
          stack,
          commands
        )
        return
      }

      case 'callSet': {
        if (!this.macroResolver) throw new Error('Macro resolver unavailable')
        if (!step.targetSetId) throw new Error('Call step is missing a target set')

        const members = this.macroResolver.listMacrosInSet(step.targetSetId)
        if (members.length === 0) {
          throw new Error(`Called macro set is empty or missing: ${step.targetSetId}`)
        }

        if (step.delayMs) await this.sleep(step.delayMs)
        for (const member of members) {
          if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')
          await this.runMacroFrames(
            session,
            member,
            this.buildCalleeScope(member, step, variables),
            stack,
            commands
          )
        }
        return
      }

      case 'download': {
        if (!step.remotePath) throw new Error('Download step is missing a remote path')
        if (step.delayMs) await this.sleep(step.delayMs)

        const remote = interpolate(step.remotePath, variables)
        const root = this.transferDirProvider?.() ?? ''

        // Blank means "call it whatever it is called on the host", which is
        // what you want when an expect capture supplied the name.
        const requested = step.localPath
          ? interpolate(step.localPath, variables)
          : localNameForRemote(remote)

        const target = resolveInTransferDir(root, requested)
        await ensureParentDir(target)

        // Saving beside an existing file rather than over it, unless asked:
        // running the same collection twice is normal and losing the first
        // result to it is not.
        const finalPath = step.overwrite ? target : await uniqueLocalPath(target)

        this.emit('macro-progress', session.id, {
          message: `Downloading ${remote}…`,
        })

        const { bytes } = await this.downloadFile(session.id, remote, finalPath, (done, total) => {
          const percent = total > 0 ? Math.floor((done / total) * 100) : 0
          this.emit('macro-progress', session.id, {
            message: `Downloading ${remote} — ${percent}% of ${formatBytes(total)}`,
          })
        })

        // Where it landed goes into a variable so a later step can act on it,
        // and into `commands` so the audit trail records the transfer the same
        // way it records everything else the button did.
        variables.DOWNLOADED_PATH = finalPath
        variables.DOWNLOADED_BYTES = String(bytes)
        commands.push(`sftp get ${remote} -> ${finalPath} (${formatBytes(bytes)})`)
        return
      }

      case 'upload': {
        if (!step.remotePath) throw new Error('Upload step is missing a remote path')
        if (!step.localPath) throw new Error('Upload step is missing a local path')
        if (step.delayMs) await this.sleep(step.delayMs)

        const root = this.transferDirProvider?.() ?? ''
        const source = resolveInTransferDir(root, interpolate(step.localPath, variables))
        const remote = interpolate(step.remotePath, variables)

        this.emit('macro-progress', session.id, { message: `Uploading ${source}…` })

        const { bytes } = await this.uploadFile(session.id, source, remote, (done, total) => {
          const percent = total > 0 ? Math.floor((done / total) * 100) : 0
          this.emit('macro-progress', session.id, {
            message: `Uploading ${remote} — ${percent}% of ${formatBytes(total)}`,
          })
        })

        variables.UPLOADED_PATH = remote
        variables.UPLOADED_BYTES = String(bytes)
        commands.push(`sftp put ${source} -> ${remote} (${formatBytes(bytes)})`)
        return
      }

      case 'while': {
        if (!step.pattern) throw new Error('While step is missing a pattern')

        // The ceiling is applied here as well as in the schema: a bundle is
        // untrusted input, and a hand-edited maxIterations must not be able to
        // hold a shell open indefinitely.
        const limit = Math.min(step.maxIterations || DEFAULT_LOOP_LIMIT, MAX_LOOP_ITERATIONS)
        // Per iteration, not for the whole loop: the point is to poll.
        const perIteration = step.timeoutMs ?? 5000

        for (let iteration = 0; iteration < limit; iteration++) {
          if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')

          // Check first, so a device already finished runs the body zero times
          // rather than once. `while`, not `do while`.
          try {
            const match = await this.waitForPattern(session, step.pattern, perIteration)
            Object.assign(variables, captureGroups(match))
            return
          } catch {
            /* not done yet — run the body and look again */
          }

          await this.runNestedSteps(session, step.thenSteps ?? [], variables, stack, commands)
        }

        // Falling out of the loop is a failure, not a quiet success: the button
        // said "wait until this happens" and it did not happen.
        throw new Error(
          `Gave up waiting for "${step.pattern}" after ${limit} attempts. ` +
            'Raise the iteration limit or the per-attempt timeout if the device is just slow.'
        )
      }

      case 'forEach': {
        if (!step.listVariable) throw new Error('For-each step is missing a list variable')

        const raw = variables[step.listVariable] ?? ''
        const items = splitList(raw, step.listSeparator)
        const limit = Math.min(step.maxIterations || DEFAULT_LOOP_LIMIT, MAX_LOOP_ITERATIONS)
        const itemName = step.itemVariable || 'ITEM'

        if (items.length > limit) {
          throw new Error(
            `${step.listVariable} holds ${items.length} items but the limit is ${limit}. ` +
              'Raise the limit deliberately rather than running an unexpected number of commands.'
          )
        }

        for (let index = 0; index < items.length; index++) {
          if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')

          // Index alongside the item: numbering output, or naming one file per
          // iteration, both need it and neither is worth a second step.
          variables[itemName] = items[index]
          variables[`${itemName}_INDEX`] = String(index + 1)

          await this.runNestedSteps(session, step.thenSteps ?? [], variables, stack, commands)
        }
        return
      }

      default:
        return
    }
  }

  /**
   * Runs a nested block — the body of `if`, `while` or `forEach`.
   *
   * Extracted so all three honour cancellation between children and treat
   * `continueOnError` and `ExitSignal` identically. They had drifted once
   * already when `if` was the only one.
   */
  private async runNestedSteps(
    session: SSHSession,
    steps: MacroStep[],
    variables: Record<string, string>,
    stack: CallFrame[],
    commands: string[]
  ): Promise<void> {
    for (const child of steps) {
      if (this.cancelledRuns.has(session.id)) throw new Error('Macro cancelled')
      try {
        await this.executeStep(session, child, variables, stack, commands)
      } catch (error) {
        if (error instanceof ExitSignal) throw error
        if (child.continueOnError) continue
        throw error
      }
    }
  }

  /**
   * Variable scope for a called macro: the caller's variables flow down, the
   * callee's own field defaults fill the gaps, and explicit `args` win.
   */
  private buildCalleeScope(
    target: Macro,
    step: MacroStep,
    callerVariables: Record<string, string>
  ): Record<string, string> {
    const scope: Record<string, string> = { ...callerVariables }

    for (const field of resolveFields(target)) {
      if (scope[field.name] === undefined && field.defaultValue) {
        scope[field.name] = field.defaultValue
      }
    }

    for (const [name, rawValue] of Object.entries(step.args ?? {})) {
      scope[name] = interpolate(rawValue, callerVariables)
    }

    return scope
  }

  /**
   * Waits for `pattern` and resolves with the match.
   *
   * The match is returned rather than discarded so named capture groups can
   * become variables — `(?<CAPFILE>/tmp/cap-\d+\.pcap)` binds `{{CAPFILE}}` for
   * the steps that follow. Without that, a step can only reference a filename
   * it already knew, which rules out anything the device chose itself.
   */
  private waitForPattern(
    session: SSHSession,
    pattern: string,
    timeoutMs: number
  ): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      let regex: RegExp
      try {
        regex = new RegExp(pattern)
      } catch (error) {
        reject(new Error(`Invalid expect pattern "${pattern}": ${error}`))
        return
      }

      let buffer = ''
      let settled = false

      const finish = (error?: Error, match?: RegExpMatchArray) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.off('output', onOutput)
        if (error) reject(error)
        else resolve(match!)
      }

      const onOutput = (text: string) => {
        buffer += text
        // Cap the buffer so long-running waits cannot grow without bound. The
        // tail is kept, so a match still works on the most recent output — but
        // a capture group can only see what survived the trim.
        if (buffer.length > 65536) buffer = buffer.slice(-32768)
        const match = buffer.match(regex)
        if (match) finish(undefined, match)
      }

      const timer = setTimeout(
        () => finish(new Error(`Timeout waiting for pattern: ${pattern}`)),
        timeoutMs
      )

      session.on('output', onOutput)
    })
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // ---------------------------------------------------------------------------

  async testConnection(profile: Profile): Promise<{ success: boolean; error?: string }> {
    // A local shell has nothing to connect to, so the useful test is that the
    // executable is still where the connection says it is — which is exactly
    // what breaks when PowerShell 7 is uninstalled or a WSL distro removed.
    if (profile.transport === 'local') {
      return checkLocalShell(profile.shellCommand ?? '', profile.shellCwd ?? undefined)
    }

    const client = new Client()

    let settled = false
    let finish!: (result: { success: boolean; error?: string }) => void

    const outcome = new Promise<{ success: boolean; error?: string }>((resolve) => {
      finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        client.end()
        resolve(result)
      }
    })

    const timer = setTimeout(() => finish({ success: false, error: 'Connection timeout' }), 15000)

    // Awaited outside the executor so a rejection here cannot be swallowed.
    try {
      const connectConfig = await this.buildConnectConfig(profile)
      client.on('ready', () => finish({ success: true }))
      client.on('error', (err) => finish({ success: false, error: err.message }))
      client.connect(connectConfig)
    } catch (error) {
      finish({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }

    return outcome
  }

  shutdown() {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.closeSession(sessionId)
    }
  }
}
