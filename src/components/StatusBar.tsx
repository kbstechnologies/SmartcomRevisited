import { clsx } from 'clsx'
import {
  ServerIcon,
  DocumentTextIcon,
  FolderOpenIcon,
  SignalIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'

const STATUS_TEXT: Record<string, { text: string; color: string }> = {
  connected: { text: 'Connected', color: 'text-green-400' },
  connecting: { text: 'Connecting...', color: 'text-yellow-400' },
  disconnected: { text: 'Disconnected', color: 'text-gray-400' },
  error: { text: 'Error', color: 'text-red-400' },
}

export default function StatusBar() {
  const sessions = useStore((state) => state.sessions)
  const activeSessionId = useStore((state) => state.activeSessionId)
  const sessionLogs = useStore((state) => state.sessionLogs)
  const broadcastInput = useStore((state) => state.broadcastInput)
  const layoutMode = useStore((state) => state.layoutMode)

  const toggleSessionLog = useStore((state) => state.toggleSessionLog)
  const revealSessionLog = useStore((state) => state.revealSessionLog)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const status = activeSession ? STATUS_TEXT[activeSession.status] : null
  const logPath = activeSessionId ? sessionLogs[activeSessionId] : undefined

  return (
    <div className="flex items-center gap-3 px-3 py-1 text-xs bg-gray-800 border-t border-gray-700 text-gray-400">
      <div className="flex items-center gap-1.5 min-w-0">
        <ServerIcon className="w-3.5 h-3.5 shrink-0" />
        <span className="truncate">
          {activeSession
            ? `${activeSession.profileName}`
            : 'No session'}
        </span>
        {status && <span className={status.color}>{status.text}</span>}
      </div>

      <div className="flex-1" />

      {broadcastInput && (
        <span className="flex items-center gap-1 text-amber-400">
          <SignalIcon className="w-3.5 h-3.5" />
          Broadcasting to all
        </span>
      )}

      <span className="hidden sm:inline capitalize">{layoutMode} view</span>

      {logPath && (
        <button
          onClick={() => activeSessionId && revealSessionLog(activeSessionId)}
          title={logPath}
          className="flex items-center gap-1 hover:text-gray-200 max-w-[16rem]"
        >
          <FolderOpenIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{logPath.split(/[\\/]/).pop()}</span>
        </button>
      )}

      {/* PuTTY-style one-click session logging for the focused terminal */}
      <button
        onClick={() => activeSessionId && toggleSessionLog(activeSessionId)}
        disabled={!activeSessionId}
        title={logPath ? 'Stop logging this session' : 'Log this session to a file'}
        className={clsx(
          'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors',
          !activeSessionId && 'opacity-40 cursor-not-allowed',
          logPath
            ? 'bg-green-700 border-green-600 text-white'
            : 'bg-gray-700 border-gray-600 hover:bg-gray-600 text-gray-300'
        )}
      >
        <DocumentTextIcon className="w-3.5 h-3.5" />
        {logPath ? 'Logging' : 'Log session'}
      </button>
    </div>
  )
}
