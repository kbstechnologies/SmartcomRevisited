import { useEffect, useState } from 'react'
import { XMarkIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'

interface GroupManagerProps {
  onClose: () => void
}

/** Create, rename and delete the folders shown in the connection list. */
export default function GroupManager({ onClose }: GroupManagerProps) {
  const groups = useStore((state) => state.connectionGroups)
  const profiles = useStore((state) => state.profiles)
  const loadConnectionGroups = useStore((state) => state.loadConnectionGroups)
  const saveConnectionGroup = useStore((state) => state.saveConnectionGroup)
  const deleteConnectionGroup = useStore((state) => state.deleteConnectionGroup)

  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadConnectionGroups()
  }, [loadConnectionGroups])

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Failed')
    }
  }

  const add = () => {
    const name = newName.trim()
    if (!name) return
    void run(async () => {
      await saveConnectionGroup({ name, sortOrder: groups.length })
      setNewName('')
    })
  }

  const remove = (id: string, name: string) => {
    const count = profiles.filter((p) => p.groupId === id).length
    const message = count
      ? `Delete group "${name}"? Its ${count} connection(s) become ungrouped — they are not deleted.`
      : `Delete group "${name}"?`
    if (!window.confirm(message)) return
    void run(() => deleteConnectionGroup(id))
  }

  const inputClass =
    'w-full px-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-[59] flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md max-h-[85vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">Connection groups</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 border-b border-gray-700 flex gap-2">
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && add()}
            placeholder="New group name"
            className={inputClass}
          />
          <button
            onClick={add}
            disabled={!newName.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
          >
            <PlusIcon className="w-4 h-4" />
            Add
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {groups.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-6">
              No groups yet. Connections without a group appear under “Ungrouped”.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-gray-700/50">
              <input
                value={group.name}
                onChange={(event) =>
                  void run(() => saveConnectionGroup({ ...group, name: event.target.value }))
                }
                className={inputClass}
              />
              <span className="text-xs text-gray-500 whitespace-nowrap">
                {profiles.filter((p) => p.groupId === group.id).length}
              </span>
              <button
                onClick={() => remove(group.id!, group.name)}
                className="p-1 rounded text-gray-500 hover:text-red-400 hover:bg-gray-700"
              >
                <TrashIcon className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>

        {error && (
          <div className="px-4 py-2 border-t border-red-900 bg-red-950/50 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="flex justify-end px-4 py-3 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
