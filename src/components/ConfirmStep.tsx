import { useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline'

interface ConfirmStepProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /** Styles the go-ahead as destructive — reboots, wipes, reloads. */
  destructive: boolean
  onAnswer: (confirmed: boolean) => void
}

/**
 * The dialog behind an inline `confirm` step: "Do you want to reboot?".
 *
 * Answering no stops the flow, so the *cancel* button takes focus rather than
 * the go-ahead — a stray Enter on a reboot prompt should not reboot anything.
 */
export default function ConfirmStep({
  title,
  message,
  confirmLabel,
  cancelLabel,
  destructive,
  onAnswer,
}: ConfirmStepProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700">
          {destructive && (
            <ExclamationTriangleIcon className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <h2 className="text-sm font-medium text-gray-100">{title}</h2>
        </div>

        <div className="px-4 py-4 text-sm text-gray-300 whitespace-pre-wrap">{message}</div>

        <div className="flex justify-end gap-2 px-4 py-3 border-t border-gray-700">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onAnswer(false)}
            className="px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => onAnswer(true)}
            className={clsx(
              'px-3 py-1.5 text-xs rounded text-white',
              destructive ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
