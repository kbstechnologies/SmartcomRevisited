import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { CheckIcon } from '@heroicons/react/24/outline'
import type { MacroSet } from '@shared/types'

interface Props {
  sets: MacroSet[]
  /** Ids currently hidden from the panel. */
  hidden: string[]
  /** Where the right-click happened, in viewport coordinates. */
  x: number
  y: number
  onToggle: (setId: string) => void
  onShowAll: () => void
  onHideAll: () => void
  onClose: () => void
}

/**
 * Right-click menu for choosing which button sets the panel shows: a tick list
 * of every set, plus show-all / hide-all.
 *
 * It closes on any click outside, on Escape and on a scroll, because a menu
 * pinned to a coordinate is wrong the moment the list behind it moves.
 */
export default function SetVisibilityMenu({
  sets,
  hidden,
  x,
  y,
  onToggle,
  onShowAll,
  onHideAll,
  onClose,
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Opened near the bottom or right edge, the menu would otherwise run off
  // screen — the panel it belongs to is against the right edge by definition.
  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element) return

    const { width, height } = element.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    // `true`: catch the click during capture, so a click on a button behind the
    // menu closes it instead of also running that button.
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const allHidden = sets.length > 0 && sets.every((set) => hidden.includes(set.id!))
  const noneHidden = hidden.length === 0

  return (
    <div
      ref={menuRef}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-50 w-60 max-h-[70vh] overflow-y-auto rounded border border-gray-600 bg-gray-800 shadow-xl py-1"
    >
      <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Show button sets</p>

      {sets.length === 0 && (
        <p className="px-3 py-2 text-[11px] text-gray-500">No button sets yet.</p>
      )}

      {sets.map((set) => {
        const isHidden = hidden.includes(set.id!)
        return (
          <button
            key={set.id}
            type="button"
            onClick={() => onToggle(set.id!)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left text-gray-200 hover:bg-gray-700"
          >
            <span
              className={clsx(
                'w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center',
                isHidden ? 'border-gray-600' : 'border-blue-500 bg-blue-600'
              )}
            >
              {!isHidden && <CheckIcon className="w-2.5 h-2.5 text-white" />}
            </span>
            <span className={clsx('truncate', isHidden && 'text-gray-500')}>{set.name}</span>
          </button>
        )
      })}

      {sets.length > 0 && (
        <>
          <div className="my-1 border-t border-gray-700" />
          <button
            type="button"
            onClick={onShowAll}
            disabled={noneHidden}
            className="w-full px-3 py-1.5 text-xs text-left text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Check all
          </button>
          <button
            type="button"
            onClick={onHideAll}
            disabled={allHidden}
            className="w-full px-3 py-1.5 text-xs text-left text-gray-300 hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            Uncheck all
          </button>
        </>
      )}
    </div>
  )
}
