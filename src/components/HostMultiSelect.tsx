import { useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import type { Profile } from '@shared/types'

interface Props {
  profiles: Profile[]
  selected: string[]
  onChange: (ids: string[]) => void
  /** Whether a host already has a connected session, so no password is needed. */
  hasSession: (profileId: string) => boolean
}

/**
 * Searchable, multi-select host list for installing a key on several boxes.
 *
 * Deploying a key one host at a time is the whole reason `ssh-copy-id` gets
 * wrapped in a shell loop; a fleet of thirty switches makes a single-select
 * dropdown the slowest part of the job. Search matters for the same reason the
 * button pickers needed it — a PuTTY import can run to hundreds of hosts.
 *
 * Hosts with an open session are marked, because those need no password and
 * the mixed case decides what the dialog has to ask for.
 */
export default function HostMultiSelect({ profiles, selected, onChange, hasSession }: Props) {
  const [search, setSearch] = useState('')

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return profiles
    return profiles.filter((profile) =>
      [profile.name, profile.host, profile.username, ...(profile.tags ?? [])].some((value) =>
        value?.toLowerCase().includes(term)
      )
    )
  }, [profiles, search])

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])

  /**
   * Select-all applies to what is *on screen*, not to everything. With a search
   * active, "all" meaning the unfiltered list would be a quiet way to install a
   * key on hosts the operator is not looking at.
   */
  const visibleIds = matches.map((profile) => profile.id!).filter(Boolean)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.includes(id))

  const toggleAllVisible = () =>
    onChange(
      allVisibleSelected
        ? selected.filter((id) => !visibleIds.includes(id))
        : [...new Set([...selected, ...visibleIds])]
    )

  const inputClass =
    'w-full pl-7 pr-2 py-1.5 rounded bg-gray-800 border border-gray-600 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-2">
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={`Search ${profiles.length} host${profiles.length === 1 ? '' : 's'} by name, address or tag…`}
          className={inputClass}
        />
      </div>

      {matches.length > 0 && (
        <label className="flex items-center gap-2 px-1 text-[11px] text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={toggleAllVisible}
            className="rounded border-gray-600 bg-gray-700 text-blue-500"
          />
          Select all {matches.length} shown
        </label>
      )}

      <div className="max-h-52 overflow-y-auto rounded border border-gray-700 divide-y divide-gray-800">
        {profiles.length === 0 && (
          <p className="px-3 py-2 text-xs text-gray-500">No connections yet.</p>
        )}
        {profiles.length > 0 && matches.length === 0 && (
          <p className="px-3 py-2 text-xs text-gray-500">Nothing matches that search.</p>
        )}

        {matches.map((profile) => {
          const checked = selected.includes(profile.id!)
          const live = hasSession(profile.id!)

          return (
            <label
              key={profile.id}
              className={clsx(
                'flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer',
                checked ? 'bg-blue-600/15 text-white' : 'text-gray-200 hover:bg-gray-800/60'
              )}
            >
              <span
                className={clsx(
                  'w-3.5 h-3.5 shrink-0 rounded-sm border flex items-center justify-center',
                  checked ? 'border-blue-500 bg-blue-600' : 'border-gray-600'
                )}
              >
                {checked && <CheckIcon className="w-2.5 h-2.5 text-white" />}
              </span>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(profile.id!)}
                className="sr-only"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{profile.name}</span>
                <span className="block truncate text-[10px] text-gray-500">
                  {profile.transport === 'serial'
                    ? profile.serialPath
                    : `${profile.username}@${profile.host}:${profile.port}`}
                </span>
              </span>
              {live && (
                <span
                  title="Open session — no password needed"
                  className="shrink-0 px-1.5 py-px rounded-full bg-green-900/60 border border-green-700 text-[9px] text-green-300"
                >
                  live
                </span>
              )}
            </label>
          )
        })}
      </div>

      <p className="text-[11px] text-gray-500">
        {selected.length === 0
          ? 'No hosts selected.'
          : `${selected.length} host${selected.length === 1 ? '' : 's'} selected.`}
      </p>
    </div>
  )
}
