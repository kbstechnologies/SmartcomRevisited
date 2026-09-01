import { useRef, useState } from 'react'
import {
  ClipboardDocumentIcon,
  ClipboardIcon,
  TrashIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'

/**
 * The scratch pad: somewhere to park text between two terminals.
 *
 * Not a notepad. There is no file, no name, no save, and nothing survives
 * closing Smartcom — the text lives in the store and only in the store. That is
 * the whole design: the thing you most often want to park while working on a
 * live box is a config fragment, a key fingerprint, or a password, and a
 * notepad that quietly wrote one to disk would be a worse feature than no
 * notepad at all. So the panel says so, on screen, rather than leaving it to be
 * assumed either way.
 *
 * It is in the store rather than in this component's own state because the side
 * panel unmounts every time you switch tabs, which would otherwise throw away
 * what you parked a second ago.
 */
export default function ScratchPad() {
  const text = useStore((state) => state.scratchpad)
  const setText = useStore((state) => state.setScratchpad)

  const areaRef = useRef<HTMLTextAreaElement>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** Fades on its own so the footer does not accumulate stale confirmations. */
  const say = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 2500)
  }

  /**
   * Copies the selection if there is one, otherwise everything.
   *
   * Through the main process, as everywhere else in the app: the sandboxed
   * renderer does not reliably get permission for the async clipboard API.
   */
  const copy = async () => {
    const area = areaRef.current
    const selected =
      area && area.selectionStart !== area.selectionEnd
        ? text.slice(area.selectionStart, area.selectionEnd)
        : ''
    const payload = selected || text
    if (!payload) return

    await window.electronAPI.invoke('clipboard:write', { text: payload })
    say(selected ? 'Copied the selection.' : 'Copied everything.')
  }

  /** Appends the clipboard at the cursor, so pasting twice keeps both. */
  const paste = async () => {
    const response = await window.electronAPI.invoke<{ text: string }>('clipboard:read')
    const clipboard = response.success ? (response.data?.text ?? '') : ''
    if (!clipboard) {
      say('Nothing on the clipboard.')
      return
    }

    const area = areaRef.current
    const start = area?.selectionStart ?? text.length
    const end = area?.selectionEnd ?? text.length
    const next = text.slice(0, start) + clipboard + text.slice(end)
    setText(next)

    // Put the cursor after what was just pasted, so a second paste follows it
    // rather than replacing it.
    window.requestAnimationFrame(() => {
      const caret = start + clipboard.length
      area?.focus()
      area?.setSelectionRange(caret, caret)
    })
  }

  const lines = text ? text.split('\n').length : 0

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-700">
        <span className="text-sm text-gray-300 flex-1">Scratch pad</span>

        <button
          onClick={() => void copy()}
          disabled={!text}
          title="Copy the selection, or everything"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ClipboardDocumentIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => void paste()}
          title="Paste the clipboard in at the cursor"
          className="p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
        >
          <ClipboardIcon className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            setText('')
            areaRef.current?.focus()
          }}
          disabled={!text}
          title="Clear"
          className="p-1 rounded text-gray-500 hover:text-red-300 hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <TrashIcon className="w-4 h-4" />
        </button>
      </div>

      <textarea
        ref={areaRef}
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
        placeholder={
          'Somewhere to park text between two terminals.\n\n' +
          'Highlight in a terminal to copy, paste it in here, take what you need back out.'
        }
        className="flex-1 min-h-0 w-full resize-none bg-gray-900 px-2 py-2 font-mono text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-0"
      />

      <div className="flex items-center gap-2 px-2 py-1 border-t border-gray-700 text-[10px] text-gray-600">
        {notice ? (
          <span className="text-blue-300 truncate">{notice}</span>
        ) : (
          // Said plainly and permanently, not in a tooltip: what someone parks
          // here decides whether they would have wanted it written to disk.
          <span className="truncate">Not saved — cleared when Smartcom closes.</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">
          {lines} {lines === 1 ? 'line' : 'lines'} · {text.length}
        </span>
      </div>
    </div>
  )
}
