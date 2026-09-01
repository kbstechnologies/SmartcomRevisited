import { useCallback, useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  ArrowTopRightOnSquareIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  StarIcon,
  ExclamationTriangleIcon,
  SignalSlashIcon,
} from '@heroicons/react/24/outline'
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid'
import { useStore } from '../store/useStore'
import ConfirmStep from './ConfirmStep'
import TldrExampleCard, { type TldrExampleActions } from './TldrExampleCard'
import { PLATFORM_LABEL, isTldrPlatform, type TldrPage, type TldrPlatform } from '@shared/tldr'
import { buildTldrAiPrompt } from '@shared/tldr-ai'
import type { TldrPageResult } from '../store/useStore'

/**
 * The tldr side panel.
 *
 * Lives in the right-hand panel Smartcom already has, as a third tab beside the
 * buttons and the assistant, which is what gives it the resize handle, the
 * remembered width and the collapse control for free — and what guarantees it
 * never displaces a terminal.
 *
 * ## The target
 *
 * Everything that acts does so on *one* named session, shown at the top of the
 * panel and captured when the panel was opened. Not the session in focus at the
 * moment a button is pressed: the whole point of a panel you read for a while
 * is that you might click a tab in the meantime, and "whichever terminal is in
 * front now" is how a command meant for a lab box reaches production. When the
 * target and the focused session diverge, the panel says so and offers to
 * switch — an operator decision, not a silent one.
 */

interface PendingRun {
  command: string
  description: string
  reasons: string[]
}

export default function TldrPanel() {
  const request = useStore((store) => store.tldrRequest)
  const sessions = useStore((store) => store.sessions)
  const profiles = useStore((store) => store.profiles)
  const status = useStore((store) => store.tldrStatus)
  const activeSessionId = useStore((store) => store.activeSessionId)
  const favourites = useStore((store) => store.settings.tldrFavourites ?? [])

  const openTldr = useStore((store) => store.openTldr)
  const tldrPage = useStore((store) => store.tldrPage)
  const setTldrSearchOpen = useStore((store) => store.setTldrSearchOpen)
  const insertSuggestion = useStore((store) => store.insertSuggestion)
  const runTldrCommand = useStore((store) => store.runTldrCommand)
  const toggleFavourite = useStore((store) => store.toggleTldrFavourite)
  const askAiAbout = useStore((store) => store.askAiAbout)

  const [result, setResult] = useState<TldrPageResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null)

  const page: TldrPage | null = result?.page ?? null

  // ---------------------------------------------------------------- loading

  useEffect(() => {
    if (!request?.command) {
      setResult(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setNotice(null)

    void tldrPage(request.command, request.platform, request.exact).then((loaded) => {
      if (cancelled) return
      setResult(loaded)
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [request?.command, request?.platform, request?.exact, tldrPage])

  // Any change of page abandons a confirmation that was about the old one.
  useEffect(() => setPendingRun(null), [request?.command, request?.platform])

  // A transient "copied" / "inserted" note, cleared so it does not become
  // permanent furniture.
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ----------------------------------------------------------------- target

  const target = useMemo(
    () => sessions.find((session) => session.id === request?.sessionId) ?? null,
    [sessions, request?.sessionId]
  )
  const targetProfile = profiles.find((profile) => profile.id === target?.profileId)
  const connected = target?.status === 'connected'
  const focusDiverged = Boolean(
    request?.sessionId && activeSessionId && activeSessionId !== request.sessionId
  )

  const runBlockedReason = (() => {
    if (!request?.sessionId) return 'No session was in focus when this page was opened.'
    if (!target) return 'Target session disconnected.'
    if (!connected) return `${target.profileName} is not connected.`
    return null
  })()

  const retarget = () => {
    if (!request || !activeSessionId) return
    openTldr({ command: request.command, platform: request.platform, exact: request.exact })
  }

  // ---------------------------------------------------------------- actions

  const describeTarget = (): string =>
    targetProfile?.transport === 'ssh'
      ? `${targetProfile.username}@${targetProfile.host}:${targetProfile.port}`
      : targetProfile?.transport === 'serial'
        ? `Serial / ${targetProfile.serialPath ?? '?'}`
        : targetProfile?.transport === 'local'
          ? `Local / ${targetProfile.shellKind ?? 'shell'}`
          : ''

  const askAi = useCallback(
    (command: string, description: string) => {
      askAiAbout(
        buildTldrAiPrompt({
          command,
          baseCommand: page?.command ?? request?.command ?? '',
          platform: page?.platform ?? request?.platform ?? 'common',
          sessionType: targetProfile?.transport,
          targetName: target?.profileName,
          tldrPage: page?.command,
          tldrExample: description || undefined,
        })
      )
    },
    [askAiAbout, page, request, target, targetProfile]
  )

  const actions: TldrExampleActions = {
    copy: (command) => {
      // The main process owns the clipboard here, as it does everywhere else in
      // the app: the sandboxed renderer's async clipboard API does not reliably
      // get the permission it needs.
      void window.electronAPI.invoke('clipboard:write', { text: command })
      setNotice('Copied to the clipboard.')
    },

    insert: (command) => {
      if (!request?.sessionId) return
      void insertSuggestion(request.sessionId, command).then((outcome) => {
        setNotice(
          outcome.inserted
            ? `Put on ${target?.profileName ?? 'the terminal'}'s command line — press Enter there to run it.`
            : (outcome.reason ?? 'Could not insert that.')
        )
      })
    },

    run: (command, description) => {
      if (!request?.sessionId) return
      void runTldrCommand(request.sessionId, command).then(
        (outcome) => {
          if (outcome.ran) {
            setNotice(`Sent to ${target?.profileName ?? 'the session'}.`)
            return
          }
          // The main process classified it as destructive and stopped. Ask.
          setPendingRun({ command, description, reasons: outcome.reasons })
        },
        (error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not run that.')
      )
    },

    askAi,
    canInsert: Boolean(request?.sessionId) && connected,
    canRun: connected,
    runBlockedReason,
  }

  const confirmRun = (confirmed: boolean) => {
    const pending = pendingRun
    setPendingRun(null)
    if (!confirmed || !pending || !request?.sessionId) return

    void runTldrCommand(request.sessionId, pending.command, true).then(
      () => setNotice(`Sent to ${target?.profileName ?? 'the session'}.`),
      (error: unknown) => setNotice(error instanceof Error ? error.message : 'Could not run that.')
    )
  }

  // ------------------------------------------------------------------ empty

  if (!status) {
    return <PanelShell onSearch={() => setTldrSearchOpen(true)} message="Starting up…" />
  }

  if (!status.ready) {
    return (
      <PanelShell
        onSearch={() => setTldrSearchOpen(true)}
        message={
          status.busy
            ? 'Downloading the tldr page set…'
            : 'tldr documentation unavailable. Terminal functionality is unaffected.'
        }
        detail={
          status.error ??
          'Open Settings › tldr to download the page set, or check this machine can reach github.com.'
        }
      />
    )
  }

  if (!request) {
    return (
      <PanelShell
        onSearch={() => setTldrSearchOpen(true)}
        message="Nothing open yet."
        detail={`Type a command in a terminal and press the TLDR chip above it, or search ${status.pageCount.toLocaleString()} pages (Ctrl+Shift+T).`}
      />
    )
  }

  const favourite = favourites.includes(request.command)

  return (
    <div className="flex flex-col h-full">
      {/* ------------------------------------------------------------ header */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700">
        <span className="font-mono text-sm text-gray-100 truncate flex-1" title={request.command}>
          {page?.command ?? request.command}
        </span>

        {page && (
          <span className="shrink-0 px-1.5 py-0.5 rounded bg-gray-700 text-[10px] text-gray-300">
            {PLATFORM_LABEL[page.platform]}
          </span>
        )}

        <button
          onClick={() => void toggleFavourite(request.command)}
          title={favourite ? 'Remove from favourites' : 'Add to favourites'}
          className="p-1 rounded text-gray-500 hover:text-amber-300 hover:bg-gray-700"
        >
          {favourite ? (
            <StarSolidIcon className="w-4 h-4 text-amber-400" />
          ) : (
            <StarIcon className="w-4 h-4" />
          )}
        </button>

        <button
          onClick={() => setTldrSearchOpen(true)}
          title="Search tldr commands (Ctrl+Shift+T)"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
        >
          <MagnifyingGlassIcon className="w-4 h-4" />
        </button>
      </div>

      {/* ------------------------------------------------------------ target */}
      <div
        className={clsx(
          'px-2 py-1.5 border-b text-[11px]',
          connected ? 'border-gray-700 bg-gray-800' : 'border-amber-900/60 bg-amber-950/30'
        )}
      >
        <span className="block text-[10px] uppercase tracking-wide text-gray-500">Target</span>
        {target ? (
          <span className="flex items-center gap-1.5">
            <span
              className={clsx(
                'w-2 h-2 rounded-full shrink-0',
                connected ? 'bg-green-500' : 'bg-gray-500'
              )}
            />
            <span className="text-gray-200 truncate">{target.profileName}</span>
            <span className="text-gray-500 truncate">{describeTarget()}</span>
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-amber-300">
            <SignalSlashIcon className="w-3.5 h-3.5 shrink-0" />
            Target session disconnected — Copy and Ask AI still work.
          </span>
        )}

        {target && !connected && (
          <span className="block mt-0.5 text-amber-300">
            Not connected. Insert and Run are unavailable.
          </span>
        )}

        {focusDiverged && (
          <button
            onClick={retarget}
            className="mt-1 w-full text-left px-1.5 py-1 rounded border border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40"
          >
            You have since switched terminals. This page still targets{' '}
            <span className="font-medium">{target?.profileName ?? 'the previous session'}</span> —
            click to retarget the one now in focus.
          </button>
        )}
      </div>

      {notice && (
        <p className="px-2 py-1.5 text-[11px] text-blue-200 bg-blue-950/40 border-b border-blue-900">
          {notice}
        </p>
      )}

      {/* ------------------------------------------------------------- body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
        {loading && <p className="text-[11px] text-gray-500">Looking that up…</p>}

        {!loading && !page && (
          <div className="space-y-2 py-2">
            <p className="text-xs text-gray-300">
              No tldr page found for{' '}
              <span className="font-mono text-gray-100">{request.command}</span>
              {isTldrPlatform(request.platform) && (
                <span className="text-gray-500"> on {PLATFORM_LABEL[request.platform]}</span>
              )}
              .
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setTldrSearchOpen(true)}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
              >
                <MagnifyingGlassIcon className="w-3.5 h-3.5" />
                Search tldr
              </button>
              <button
                onClick={() => askAi(request.command, '')}
                className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
              >
                <SparklesIcon className="w-3.5 h-3.5" />
                Ask AI
              </button>
            </div>
            <p className="text-[11px] text-gray-500">
              tldr does not document everything, and it documents very little for serial consoles
              and vendor CLIs. The assistant has no such gap.
            </p>
          </div>
        )}

        {page && (
          <>
            {page.description.map((line, index) => (
              <p key={index} className="text-xs text-gray-300 leading-relaxed">
                {line}
              </p>
            ))}

            {page.moreInfo && (
              <button
                onClick={() =>
                  void window.electronAPI.invoke('app:open-external', { url: String(page.moreInfo) })
                }
                className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 break-all text-left"
              >
                <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{page.moreInfo}</span>
              </button>
            )}

            {/* Other platforms document this command too. Offered rather than
                merged: `show` on Cisco IOS and `show` on Linux are different
                commands that happen to share a name. */}
            {page.otherPlatforms && page.otherPlatforms.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 pt-1">
                <span className="text-[10px] uppercase tracking-wide text-gray-500">Also on</span>
                {page.otherPlatforms.map((platform: TldrPlatform) => (
                  <button
                    key={platform}
                    onClick={() =>
                      // Same target: looking at the Windows variant of a page
                      // is not a decision to run it somewhere else.
                      openTldr({
                        command: page.command,
                        platform,
                        exact: true,
                        sessionId: request.sessionId,
                      })
                    }
                    className="px-1.5 py-0.5 rounded border border-gray-600 text-[10px] text-gray-300 hover:bg-gray-700"
                  >
                    {PLATFORM_LABEL[platform]}
                  </button>
                ))}
              </div>
            )}

            <div className="pt-1 space-y-2">
              {page.examples.map((example, index) => (
                <TldrExampleCard key={index} example={example} actions={actions} />
              ))}
            </div>

            <button
              onClick={() => askAi(page.command, '')}
              className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-[11px] rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              <SparklesIcon className="w-3.5 h-3.5" />
              Ask AI about {page.command}
            </button>

            {result && result.related.length > 0 && (
              <div className="pt-1">
                <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                  Related
                </span>
                <div className="flex flex-wrap gap-1">
                  {result.related.map((related) => (
                    <button
                      key={`${related.platform}/${related.command}`}
                      onClick={() =>
                        openTldr({
                          command: related.command,
                          platform: request.platform,
                          sessionId: request.sessionId,
                        })
                      }
                      title={related.description}
                      className="px-1.5 py-0.5 rounded border border-gray-700 text-[10px] font-mono text-gray-300 hover:bg-gray-700"
                    >
                      {related.command}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <p className="pt-2 text-[10px] text-gray-600 leading-relaxed border-t border-gray-800">
              Documentation from the tldr-pages project, CC BY 4.0. It describes what a command
              does — it is not a review of whether it is safe to run here.
            </p>
          </>
        )}
      </div>

      {pendingRun && (
        <ConfirmStep
          title="Review before running"
          message={[
            'You are about to run:',
            '',
            pendingRun.command,
            '',
            'On:',
            `${target?.profileName ?? 'this session'}${describeTarget() ? ` — ${describeTarget()}` : ''}`,
            '',
            `This ${pendingRun.reasons.join(', and ')}.`,
          ].join('\n')}
          confirmLabel="Run command"
          cancelLabel="Cancel"
          destructive
          onAnswer={confirmRun}
        />
      )}
    </div>
  )
}

/** The panel with nothing in it — starting up, unavailable, or nothing opened. */
function PanelShell({
  message,
  detail,
  onSearch,
}: {
  message: string
  detail?: string
  onSearch: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700">
        <span className="text-sm text-gray-300 flex-1">tldr</span>
        <button
          onClick={onSearch}
          title="Search tldr commands (Ctrl+Shift+T)"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
        >
          <MagnifyingGlassIcon className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 p-3 space-y-2">
        <p className="flex items-start gap-1.5 text-xs text-gray-400">
          {detail && <ExclamationTriangleIcon className="w-4 h-4 shrink-0 mt-px text-gray-600" />}
          <span>{message}</span>
        </p>
        {detail && <p className="text-[11px] text-gray-500 leading-relaxed">{detail}</p>}
      </div>
    </div>
  )
}
