import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clsx } from 'clsx'

interface Props {
  /** Where the right-click happened, in viewport coordinates. */
  x: number
  y: number
  onClose: () => void
  className?: string
  children: ReactNode
}

/**
 * The shell every right-click menu shares: pinned to the click, kept on screen,
 * and dismissed on any click outside, on Escape and on a resize — a menu
 * anchored to a coordinate is wrong the moment the layout behind it moves.
 */
export default function ContextMenu({ x, y, onClose, className, children }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // Opened near the bottom or right edge, the menu would otherwise run off
  // screen — the panels it belongs to sit against those edges by definition.
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

  return (
    <div
      ref={menuRef}
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      className={clsx(
        'fixed z-50 rounded border border-gray-600 bg-gray-800 shadow-xl py-1',
        className
      )}
    >
      {children}
    </div>
  )
}
