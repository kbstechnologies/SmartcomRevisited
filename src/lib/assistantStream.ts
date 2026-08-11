/**
 * Folds the assistant's streamed answer into the store.
 *
 * Registered once for the window's lifetime rather than from a component
 * effect, for the same reason as [sessionStream]: an answer keeps arriving
 * while the side panel is unmounted (switching to the buttons tab), so the
 * listener cannot belong to the panel. Registering it from App's effect
 * instead was worse — React StrictMode's mount/unmount/mount left *two* live
 * subscriptions, and every token was appended twice ("TheThe operator
 * operator"). A module-level guard is immune to both.
 */
import { useStore } from '../store/useStore'
import type { AiStreamEvent } from '@shared/ai'

let started = false

export function startAssistantStream(): void {
  if (started) return
  started = true

  window.electronAPI.on('ai-stream', (event: AiStreamEvent) => {
    useStore.getState().applyAssistantStream(event)
  })
}
