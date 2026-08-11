import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import {
  XMarkIcon,
  FolderIcon,
  FolderOpenIcon,
  DocumentTextIcon,
  PlayIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import type { ScriptEntry } from '@shared/types'

/**
 * Browser for the script library — a plain folder on disk that the app indexes.
 *
 * Running a script from here copies it to the host over SFTP and then types the
 * command into the session, so the operator sees it happen in their own
 * terminal rather than in a hidden channel.
 */
export default function ScriptLibrary({ onClose }: { onClose: () => void }) {
  const scriptLibrary = useStore((state) => state.scriptLibrary)
  const loadScriptLibrary = useStore((state) => state.loadScriptLibrary)
  const chooseScriptFolder = useStore((state) => state.chooseScriptFolder)
  const revealScriptFolder = useStore((state) => state.revealScriptFolder)
  const readScript = useStore((state) => state.readScript)
  const runScriptOnSession = useStore((state) => state.runScriptOnSession)
  const sessions = useStore((state) => state.sessions)
  const profiles = useStore((state) => state.profiles)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const settings = useStore((state) => state.settings)

  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<string>('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [remoteDir, setRemoteDir] = useState(settings.scriptRemoteDir || '/tmp')
  const [interpreter, setInterpreter] = useState('')
  const [args, setArgs] = useState('')
  const [cleanup, setCleanup] = useState(true)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  // A Session does not carry its transport, so the profile is what says whether
  // this connection can take a file at all.
  const activeProfile = profiles.find((profile) => profile.id === activeSession?.profileId)
  const isSerial = activeProfile?.transport === 'serial'
  const canRun = Boolean(activeSession && selected && !busy && !isSerial)

  useEffect(() => {
    void loadScriptLibrary()
  }, [loadScriptLibrary])

  const open = async (path: string) => {
    setSelected(path)
    setError(null)
    try {
      const script = await readScript(path)
      setPreview(script.content)
    } catch (err) {
      setPreview('')
      setError(err instanceof Error ? err.message : 'Could not read that script')
    }
  }

  const run = async () => {
    if (!activeSession || !selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await runScriptOnSession({
        sessionId: activeSession.id,
        path: selected,
        remoteDir,
        interpreter: interpreter.trim() || undefined,
        args: args.trim() || undefined,
        cleanup,
      })
      setNotice(`Sent ${selected} to ${activeSession.profileName}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run that script')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const renderTree = (entries: ScriptEntry[], depth = 0) =>
    entries.map((entry) => {
      if (entry.type === 'folder') {
        const isCollapsed = collapsed.has(entry.path)
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => toggle(entry.path)}
              style={{ paddingLeft: depth * 12 + 8 }}
              className="w-full flex items-center gap-1.5 py-1 pr-2 text-xs text-gray-300 hover:bg-gray-700/60 rounded"
            >
              {isCollapsed ? (
                <FolderIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              ) : (
                <FolderOpenIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}
              <span className="truncate">{entry.name}</span>
            </button>
            {!isCollapsed && renderTree(entry.children ?? [], depth + 1)}
          </div>
        )
      }

      return (
        <button
          key={entry.path}
          type="button"
          onClick={() => void open(entry.path)}
          style={{ paddingLeft: depth * 12 + 8 }}
          className={clsx(
            'w-full flex items-center gap-1.5 py-1 pr-2 text-xs rounded',
            selected === entry.path
              ? 'bg-blue-600/30 text-blue-100'
              : 'text-gray-400 hover:bg-gray-700/60'
          )}
        >
          <DocumentTextIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{entry.name}</span>
        </button>
      )
    })

  const inputClass =
    'px-2 py-1 rounded bg-gray-800 border border-gray-600 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-4xl h-[80vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-gray-100">Script library</h2>
            <p className="text-[11px] text-gray-500 truncate" title={scriptLibrary.root}>
              {scriptLibrary.root || 'No folder chosen yet'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void chooseScriptFolder()}
              className="px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Choose folder…
            </button>
            {scriptLibrary.root && (
              <>
                <button
                  type="button"
                  onClick={() => void loadScriptLibrary()}
                  className="px-2 py-1 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void revealScriptFolder()}
                  title="Open the folder"
                  className="p-1 rounded text-gray-400 hover:bg-gray-700"
                >
                  <ArrowTopRightOnSquareIcon className="w-4 h-4" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:bg-gray-700"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0">
          <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-700 p-2">
            {scriptLibrary.entries.length === 0 ? (
              <p className="px-2 py-3 text-[11px] text-gray-500">
                Choose a folder of scripts. The folder stays yours — edit the files in your own
                editor or keep them in git, and the app reads them as they are when you send
                one.
              </p>
            ) : (
              renderTree(scriptLibrary.entries)
            )}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono text-gray-300 whitespace-pre">
              {preview || (selected ? '' : 'Select a script to preview it.')}
            </pre>

            <div className="border-t border-gray-700 p-3 space-y-2">
              {error && <p className="text-[11px] text-red-400">{error}</p>}
              {notice && <p className="text-[11px] text-green-400">{notice}</p>}

              <div className="flex gap-1">
                <input
                  value={remoteDir}
                  onChange={(event) => setRemoteDir(event.target.value)}
                  placeholder="/tmp"
                  title="Directory on the host to copy it into"
                  className={`${inputClass} w-28`}
                />
                <input
                  value={interpreter}
                  onChange={(event) => setInterpreter(event.target.value)}
                  placeholder="bash (blank = chmod +x)"
                  className={`${inputClass} w-44`}
                />
                <input
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  placeholder="arguments"
                  className={`${inputClass} flex-1`}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-1 text-[11px] text-gray-400">
                  <input
                    type="checkbox"
                    checked={cleanup}
                    onChange={(event) => setCleanup(event.target.checked)}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500"
                  />
                  Delete from the host after it runs
                </label>

                <button
                  type="button"
                  onClick={() => void run()}
                  disabled={!canRun}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
                >
                  <PlayIcon className="w-3.5 h-3.5" />
                  {activeSession
                    ? `Copy and run on ${activeSession.profileName}`
                    : 'No session in focus'}
                </button>
              </div>

              {isSerial && (
                <p className="text-[11px] text-amber-400">
                  This session is serial — copying a file needs SSH.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
