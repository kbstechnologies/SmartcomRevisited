import { clsx } from 'clsx'
import { CheckIcon } from '@heroicons/react/24/outline'
import ContextMenu from './ContextMenu'
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
  /**
   * Set when the connection in front is narrowing the list. Without saying so,
   * the tick list looks broken: sets are ticked but not on screen.
   */
  assignment?: {
    profileName: string
    /** How many sets the connection is keeping out of sight. */
    count: number
    /** True once the operator has lifted the restriction for this session. */
    lifted: boolean
    onToggle: () => void
  }
}

/**
 * Right-click menu for choosing which button sets the panel shows: a tick list
 * of every set, plus show-all / hide-all. Positioning and dismissal live in
 * ContextMenu, which every right-click menu shares.
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
  assignment,
}: Props) {
  const allHidden = sets.length > 0 && sets.every((set) => hidden.includes(set.id!))
  const noneHidden = hidden.length === 0

  return (
    <ContextMenu x={x} y={y} onClose={onClose} className="w-60 max-h-[70vh] overflow-y-auto">
      <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-gray-500">Show button sets</p>

      {assignment && (
        <div className="mx-2 my-1 rounded bg-gray-900/70 border border-gray-700 px-2 py-1.5">
          <p className="text-[11px] text-gray-400">
            {assignment.lifted ? (
              <>
                Showing every set. {assignment.profileName} is normally limited to its assigned
                ones.
              </>
            ) : (
              <>
                Limited to the sets assigned to <span className="text-gray-200">{assignment.profileName}</span> —{' '}
                {assignment.count} other{assignment.count === 1 ? '' : 's'} out of sight.
              </>
            )}
          </p>
          <button
            type="button"
            onClick={assignment.onToggle}
            className="mt-1 text-[11px] text-blue-400 hover:text-blue-300"
          >
            {assignment.lifted ? 'Use this connection’s sets again' : 'Show every set for this session'}
          </button>
        </div>
      )}

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
    </ContextMenu>
  )
}
