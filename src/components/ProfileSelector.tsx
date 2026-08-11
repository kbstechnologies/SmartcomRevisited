import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import {
  XMarkIcon,
  PlusIcon,
  MagnifyingGlassIcon,
  FolderIcon,
  ServerIcon,
  CpuChipIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline'
import { useStore } from '../store/useStore'
import ProfileForm from './ProfileForm'
import GroupManager from './GroupManager'
import type { Profile } from '@shared/types'

/** Key under which collapsed folders are remembered. */
const COLLAPSED_GROUPS_KEY = 'smartcom.collapsedConnectionGroups'
/** Stand-in id for the bucket of connections that belong to no folder. */
const UNGROUPED_KEY = '__ungrouped__'

interface ProfileSelectorProps {
  onClose: () => void
  onConnected: (sessionIds: string[]) => void
}

export default function ProfileSelector({ onClose, onConnected }: ProfileSelectorProps) {
  const profiles = useStore((state) => state.profiles)
  const loadProfiles = useStore((state) => state.loadProfiles)
  const openSessions = useStore((state) => state.openSessions)
  const connectionGroups = useStore((state) => state.connectionGroups)
  const loadConnectionGroups = useStore((state) => state.loadConnectionGroups)
  const exportConnections = useStore((state) => state.exportConnections)
  const importConnections = useStore((state) => state.importConnections)
  const deleteProfile = useStore((state) => state.deleteProfile)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showGroups, setShowGroups] = useState(false)
  /** Connections awaiting the delete confirmation shown above the footer. */
  const [pendingDelete, setPendingDelete] = useState<Profile[] | null>(null)
  const [deleting, setDeleting] = useState(false)

  /**
   * Folders the user has collapsed, remembered between runs — a list imported
   * from PuTTY can run to hundreds of hosts, and having to re-collapse them
   * every time would defeat the point.
   */
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_KEY) ?? '[]')
      return new Set(Array.isArray(stored) ? (stored as string[]) : [])
    } catch {
      return new Set()
    }
  })

  useEffect(() => {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(Array.from(collapsedGroups)))
  }, [collapsedGroups])

  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })

  useEffect(() => {
    void loadProfiles()
    void loadConnectionGroups()
  }, [loadProfiles, loadConnectionGroups])

  /**
   * While searching, folders are forced open: a match hidden inside a collapsed
   * folder looks exactly like no match at all.
   */
  const searching = search.trim().length > 0

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return profiles
    return profiles.filter((profile) =>
      [profile.name, profile.host, profile.username].some((value) =>
        value?.toLowerCase().includes(term)
      )
    )
  }, [profiles, search])

  /** Filtered connections bucketed by folder, ungrouped last. */
  const grouped = useMemo(() => {
    const buckets = connectionGroups.map((group) => ({
      group,
      items: filtered.filter((profile) => profile.groupId === group.id),
    }))
    const ungrouped = filtered.filter(
      (profile) => !profile.groupId || !connectionGroups.some((g) => g.id === profile.groupId)
    )
    if (ungrouped.length > 0) buckets.push({ group: undefined as never, items: ungrouped })
    return buckets.filter((bucket) => bucket.items.length > 0)
  }, [filtered, connectionGroups])

  /** Selects the whole folder, or clears it when already fully selected. */
  const toggleMany = (ids: string[]) => {
    setSelected((current) => {
      const next = new Set(current)
      const allSelected = ids.every((id) => next.has(id))
      ids.forEach((id) => (allSelected ? next.delete(id) : next.add(id)))
      return next
    })
  }

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((profile) => selected.has(profile.id!))

  const toggleAll = () => {
    setSelected((current) => {
      const next = new Set(current)
      if (allVisibleSelected) {
        filtered.forEach((profile) => next.delete(profile.id!))
      } else {
        filtered.forEach((profile) => next.add(profile.id!))
      }
      return next
    })
  }

  /** Exports the ticked connections, or everything when nothing is ticked. */
  const handleExport = async () => {
    setErrors([])
    try {
      const result = await exportConnections(selected.size > 0 ? Array.from(selected) : undefined)
      setNotice(`Exported ${result.profiles} connection(s) to ${result.filePath}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Export failed'
      if (!message.includes('cancelled')) setErrors([message])
    }
  }

  const handleImport = async () => {
    setErrors([])
    try {
      const result = await importConnections()
      const notes = [`Imported ${result.profiles} connection(s), ${result.groups} group(s)`]
      if (result.renamed.length > 0) {
        notes.push(`renamed: ${result.renamed.map((r) => `"${r.to}"`).join(', ')}`)
      }
      setNotice(notes.join(' — '))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed'
      if (!message.includes('cancelled')) setErrors([message])
    }
  }

  /**
   * Deleting asks first, in the page rather than in a native dialog: a native
   * modal blocks the renderer, and anything that replaces `window.confirm`
   * turns the question into a silent yes.
   */
  const confirmDelete = (victims: Profile[]) => {
    if (victims.length === 0) return
    setErrors([])
    setNotice(null)
    setPendingDelete(victims)
  }

  /**
   * Removes connections and their stored secrets.
   *
   * Open sessions are left alone: they hold their own copy of the connection
   * details, and dropping someone's terminal because they tidied the host list
   * would be its own kind of data loss.
   */
  const performDelete = async () => {
    const victims = pendingDelete
    if (!victims) return

    setPendingDelete(null)
    setDeleting(true)

    const failures: string[] = []
    for (const profile of victims) {
      try {
        await deleteProfile(profile.id!)
      } catch (error) {
        failures.push(`${profile.name}: ${error instanceof Error ? error.message : error}`)
      }
    }

    setDeleting(false)
    setSelected((current) => {
      const next = new Set(current)
      victims.forEach((profile) => next.delete(profile.id!))
      return next
    })

    if (failures.length > 0) setErrors(failures)
    const removed = victims.length - failures.length
    if (removed > 0) setNotice(`Deleted ${removed} connection${removed === 1 ? '' : 's'}`)
  }

  const handleConnect = async () => {
    if (selected.size === 0) return

    setConnecting(true)
    setErrors([])
    try {
      const results = await openSessions(Array.from(selected))
      const failures = results.filter((result) => result.error)

      if (failures.length > 0) {
        setErrors(failures.map((f) => `${f.profileName ?? f.profileId}: ${f.error}`))
      }

      const opened = results.filter((r) => r.sessionId).map((r) => r.sessionId!)
      // Stay open when something failed so the operator sees why.
      if (failures.length === 0) {
        onConnected(opened)
      }
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Failed to open sessions'])
    } finally {
      setConnecting(false)
    }
  }

  if (showForm) {
    return (
      <ProfileForm
        profile={editingProfile}
        onClose={() => {
          setShowForm(false)
          setEditingProfile(null)
        }}
        onSave={() => {
          setShowForm(false)
          setEditingProfile(null)
          void loadProfiles()
        }}
      />
    )
  }

  if (showGroups) {
    return <GroupManager onClose={() => setShowGroups(false)} />
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-lg bg-gray-800 border border-gray-700 shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
          <h2 className="text-sm font-medium text-gray-100">Open sessions</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-700 text-gray-400">
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-gray-700 flex items-center gap-2">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search hosts..."
              className="w-full pl-8 pr-3 py-1.5 rounded bg-gray-700 border border-gray-600 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={() => {
              setEditingProfile(null)
              setShowForm(true)
            }}
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-gray-700 border border-gray-600 text-gray-200 hover:bg-gray-600"
          >
            <PlusIcon className="w-3.5 h-3.5" />
            New
          </button>
          <button
            onClick={() => setShowGroups(true)}
            title="Manage groups"
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-gray-700 border border-gray-600 text-gray-200 hover:bg-gray-600"
          >
            <FolderIcon className="w-3.5 h-3.5" />
            Groups
          </button>
          <button
            onClick={handleImport}
            title="Import connections from a file"
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-gray-700 border border-gray-600 text-gray-200 hover:bg-gray-600"
          >
            <ArrowDownTrayIcon className="w-3.5 h-3.5" />
            Import
          </button>
          <button
            onClick={handleExport}
            disabled={profiles.length === 0}
            title={
              selected.size > 0
                ? `Export ${selected.size} selected`
                : 'Export all connections (secrets are never included)'
            }
            className="flex items-center gap-1 px-2 py-1.5 text-xs rounded bg-gray-700 border border-gray-600 text-gray-200 hover:bg-gray-600 disabled:opacity-40"
          >
            <ArrowUpTrayIcon className="w-3.5 h-3.5" />
            Export{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
        </div>

        {filtered.length > 0 && (
          <label className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400 border-b border-gray-700 cursor-pointer hover:bg-gray-750">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleAll}
              className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
            />
            Select all {filtered.length} shown
          </label>
        )}

        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-gray-500">
              {profiles.length === 0
                ? 'No connections yet — create one to begin.'
                : 'No connections match.'}
            </p>
          ) : (
            grouped.map(({ group, items }) => {
              const key = group?.id ?? UNGROUPED_KEY
              const isCollapsed = collapsedGroups.has(key) && !searching
              const selectedHere = items.filter((p) => selected.has(p.id!)).length

              return (
              <div key={key}>
                {/* Group header: the checkbox selects the whole folder, the rest
                    of the row collapses it. */}
                <div className="sticky top-0 z-10 flex items-center gap-2 px-4 py-1.5 bg-gray-900/95 border-b border-gray-700 backdrop-blur">
                  <input
                    type="checkbox"
                    checked={items.every((p) => selected.has(p.id!))}
                    onChange={() => toggleMany(items.map((p) => p.id!))}
                    className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                  />
                  <button
                    onClick={() => toggleGroup(key)}
                    title={isCollapsed ? 'Expand' : 'Collapse'}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRightIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    )}
                    <FolderIcon className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="text-xs font-medium text-gray-300 truncate">
                      {group?.name ?? 'Ungrouped'}
                    </span>
                    <span className="text-xs text-gray-600">({items.length})</span>
                    {/* A collapsed folder must still show it has picks inside. */}
                    {isCollapsed && selectedHere > 0 && (
                      <span className="text-xs text-blue-400">{selectedHere} selected</span>
                    )}
                  </button>
                </div>

                {!isCollapsed && items.map((profile) => (
                  <label
                    key={profile.id}
                    className={clsx(
                      'flex items-center gap-3 px-4 py-2.5 cursor-pointer border-b border-gray-700/50',
                      selected.has(profile.id!) ? 'bg-blue-950/40' : 'hover:bg-gray-700/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(profile.id!)}
                      onChange={() => toggle(profile.id!)}
                      className="rounded border-gray-600 bg-gray-700 text-blue-500 focus:ring-blue-500"
                    />
                    {profile.transport === 'serial' ? (
                      <CpuChipIcon className="w-4 h-4 text-amber-400 shrink-0" />
                    ) : (
                      <ServerIcon className="w-4 h-4 text-blue-400 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-100 truncate">{profile.name}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {profile.transport === 'serial' ? (
                          <>
                            {profile.serialPath} · {profile.baudRate} {profile.dataBits}
                            {profile.parity[0].toUpperCase()}
                            {profile.stopBits}
                          </>
                        ) : (
                          <>
                            {profile.username}@{profile.host}:{profile.port}
                            <span className="ml-2 uppercase tracking-wide">
                              {profile.authMethod}
                            </span>
                          </>
                        )}
                        {profile.startupMacroId && (
                          <span className="ml-2 text-amber-500">startup script</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(event) => {
                        event.preventDefault()
                        setEditingProfile(profile)
                        setShowForm(true)
                      }}
                      className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(event) => {
                        event.preventDefault()
                        confirmDelete([profile])
                      }}
                      title={`Delete ${profile.name}`}
                      className="p-1 rounded text-gray-500 hover:text-red-300 hover:bg-gray-700"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </label>
                ))}
              </div>
              )
            })
          )}
        </div>

        {/* Delete confirmation — in the page, not a native dialog */}
        {pendingDelete && (
          <div className="px-4 py-3 border-t border-red-900 bg-red-950/40 space-y-2">
            <p className="text-xs text-red-200">
              Delete{' '}
              {pendingDelete.length === 1 ? (
                <span className="font-medium">{pendingDelete[0].name}</span>
              ) : (
                <span className="font-medium">{pendingDelete.length} connections</span>
              )}
              ?
            </p>

            {pendingDelete.length > 1 && (
              <p className="text-xs text-red-300/80 max-h-16 overflow-y-auto">
                {pendingDelete.map((profile) => profile.name).join(', ')}
              </p>
            )}

            <p className="text-[11px] text-gray-400">
              The saved password or key passphrase goes too. Open sessions keep running, and the
              audit log keeps its entries.
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => void performDelete()}
                className="px-3 py-1.5 text-xs rounded bg-red-600 text-white hover:bg-red-500"
              >
                Delete {pendingDelete.length > 1 ? pendingDelete.length : ''}
              </button>
              <button
                onClick={() => setPendingDelete(null)}
                className="px-3 py-1.5 text-xs rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {notice && (
          <div className="px-4 py-2 border-t border-green-900 bg-green-950/40">
            <p className="text-xs text-green-300 break-all">{notice}</p>
          </div>
        )}

        {errors.length > 0 && (
          <div className="px-4 py-2 border-t border-red-900 bg-red-950/50 max-h-28 overflow-y-auto">
            {errors.map((error) => (
              <p key={error} className="text-xs text-red-300">
                {error}
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700">
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">{selected.size} selected</span>
            {selected.size > 0 && (
              <button
                onClick={() =>
                  confirmDelete(profiles.filter((profile) => selected.has(profile.id!)))
                }
                disabled={deleting}
                className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-gray-700"
              >
                <TrashIcon className="w-3.5 h-3.5" />
                Delete {selected.size}
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-gray-600 text-gray-300 hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              onClick={handleConnect}
              disabled={selected.size === 0 || connecting}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {connecting
                ? 'Connecting...'
                : `Connect${selected.size > 1 ? ` ${selected.size} hosts` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
