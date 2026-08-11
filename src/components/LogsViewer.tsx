import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { LogFilter } from '@shared/types'
import { 
  MagnifyingGlassIcon, 
  ArrowDownTrayIcon,
  FunnelIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { clsx } from 'clsx'

interface LogsViewerProps {
  isOpen: boolean
  onClose: () => void
}

export default function LogsViewer({ isOpen, onClose }: LogsViewerProps) {
  const { auditLogs, profiles, loadAuditLogs, exportLogs } = useStore()
  const [filter, setFilter] = useState<LogFilter>({})
  const [searchTerm, setSearchTerm] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selectedLogs, setSelectedLogs] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (isOpen) {
      loadAuditLogs(filter)
    }
  }, [isOpen, filter, loadAuditLogs])

  const filteredLogs = auditLogs.filter(log => {
    if (!searchTerm) return true
    const searchLower = searchTerm.toLowerCase()
    return (
      log.commands.some(cmd => cmd.toLowerCase().includes(searchLower)) ||
      log.stdoutSnippet?.toLowerCase().includes(searchLower) ||
      log.macroName?.toLowerCase().includes(searchLower) ||
      log.userMachine.toLowerCase().includes(searchLower)
    )
  })

  const handleExport = async (format: 'csv' | 'json') => {
    setExporting(true)
    try {
      const exportFilter = { ...filter, searchText: searchTerm }
      await exportLogs({ format, filters: exportFilter })
    } catch (error) {
      console.error('Export failed:', error)
      alert('Export failed. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  const handleFilterChange = (key: keyof LogFilter, value: any) => {
    setFilter(prev => ({ ...prev, [key]: value || undefined }))
  }

  const clearFilters = () => {
    setFilter({})
    setSearchTerm('')
  }

  const toggleLogSelection = (logId: string) => {
    setSelectedLogs(prev => {
      const newSet = new Set(prev)
      if (newSet.has(logId)) {
        newSet.delete(logId)
      } else {
        newSet.add(logId)
      }
      return newSet
    })
  }

  const selectAllLogs = () => {
    setSelectedLogs(new Set(filteredLogs.map(log => log.id!)))
  }

  const clearSelection = () => {
    setSelectedLogs(new Set())
  }

  const getStatusColor = (result: string) => {
    switch (result) {
      case 'success': return 'text-green-500'
      case 'timeout': return 'text-yellow-500'
      case 'error': return 'text-red-500'
      default: return 'text-gray-500'
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-6xl mx-4 h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-medium text-white">Audit Logs</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">
              {filteredLogs.length} of {auditLogs.length} logs
            </span>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={clsx(
                'p-2 rounded transition-colors',
                showFilters ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
              )}
              title="Toggle Filters"
            >
              <FunnelIcon className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white p-1"
            >
              <XMarkIcon className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filters */}
        {showFilters && (
          <div className="p-4 bg-gray-700 border-b border-gray-600">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Start Date</label>
                <input
                  type="date"
                  value={filter.startDate || ''}
                  onChange={(e) => handleFilterChange('startDate', e.target.value)}
                  className="form-input text-sm"
                />
              </div>
              
              <div>
                <label className="block text-xs text-gray-400 mb-1">End Date</label>
                <input
                  type="date"
                  value={filter.endDate || ''}
                  onChange={(e) => handleFilterChange('endDate', e.target.value)}
                  className="form-input text-sm"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Profile</label>
                <select
                  value={filter.profileId || ''}
                  onChange={(e) => handleFilterChange('profileId', e.target.value)}
                  className="form-select text-sm"
                >
                  <option value="">All Profiles</option>
                  {profiles.map(profile => (
                    <option key={profile.id} value={profile.id}>{profile.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-gray-400 mb-1">Result</label>
                <select
                  value={filter.result || ''}
                  onChange={(e) => handleFilterChange('result', e.target.value)}
                  className="form-select text-sm"
                >
                  <option value="">All Results</option>
                  <option value="success">Success</option>
                  <option value="timeout">Timeout</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="relative flex-1 max-w-md">
                <MagnifyingGlassIcon className="w-4 h-4 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search logs..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-gray-600 border border-gray-500 rounded text-sm text-white placeholder-gray-400"
                />
              </div>
              
              <button
                onClick={clearFilters}
                className="btn btn-secondary btn-sm ml-3"
              >
                Clear Filters
              </button>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between p-4 bg-gray-700 border-b border-gray-600">
          <div className="flex items-center gap-2">
            <button
              onClick={selectedLogs.size === filteredLogs.length ? clearSelection : selectAllLogs}
              className="btn btn-secondary btn-sm"
            >
              {selectedLogs.size === filteredLogs.length ? 'Clear Selection' : 'Select All'}
            </button>
            
            {selectedLogs.size > 0 && (
              <span className="text-sm text-gray-400">
                {selectedLogs.size} selected
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleExport('csv')}
              disabled={exporting}
              className="btn btn-secondary btn-sm"
            >
              <ArrowDownTrayIcon className="w-4 h-4 mr-1" />
              {exporting ? 'Exporting...' : 'Export CSV'}
            </button>
            
            <button
              onClick={() => handleExport('json')}
              disabled={exporting}
              className="btn btn-secondary btn-sm"
            >
              <ArrowDownTrayIcon className="w-4 h-4 mr-1" />
              {exporting ? 'Exporting...' : 'Export JSON'}
            </button>
          </div>
        </div>

        {/* Logs Table */}
        <div className="flex-1 overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-500">
              <div className="text-center">
                <div className="text-4xl mb-2">📋</div>
                <p className="text-lg">No logs found</p>
                <p className="text-sm text-gray-400">
                  {auditLogs.length === 0 ? 'No audit logs available' : 'Try adjusting your filters'}
                </p>
              </div>
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-gray-700 sticky top-0">
                <tr className="text-left text-xs text-gray-400">
                  <th className="p-3 w-8">
                    <input
                      type="checkbox"
                      checked={selectedLogs.size === filteredLogs.length && filteredLogs.length > 0}
                      onChange={selectedLogs.size === filteredLogs.length ? clearSelection : selectAllLogs}
                      className="rounded"
                    />
                  </th>
                  <th className="p-3">Timestamp</th>
                  <th className="p-3">User/Machine</th>
                  <th className="p-3">Commands</th>
                  <th className="p-3">Macro</th>
                  <th className="p-3">Result</th>
                  <th className="p-3">Output</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {filteredLogs.map((log) => (
                  <tr 
                    key={log.id}
                    className={clsx(
                      'hover:bg-gray-700 transition-colors',
                      selectedLogs.has(log.id!) && 'bg-blue-900/20'
                    )}
                  >
                    <td className="p-3">
                      <input
                        type="checkbox"
                        checked={selectedLogs.has(log.id!)}
                        onChange={() => toggleLogSelection(log.id!)}
                        className="rounded"
                      />
                    </td>
                    <td className="p-3 text-sm text-gray-300">
                      {new Date(log.timestamp).toLocaleString()}
                    </td>
                    <td className="p-3 text-sm text-gray-300">
                      <div className="truncate max-w-32" title={log.userMachine}>
                        {log.userMachine}
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="space-y-1">
                        {log.commands.slice(0, 2).map((cmd, i) => (
                          <div key={i} className="font-mono text-xs text-green-400 truncate max-w-48" title={cmd}>
                            {cmd}
                          </div>
                        ))}
                        {log.commands.length > 2 && (
                          <div className="text-xs text-gray-500">
                            +{log.commands.length - 2} more
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-sm">
                      {log.macroName ? (
                        <span className="px-2 py-1 bg-blue-600 text-blue-100 rounded text-xs">
                          {log.macroName}
                        </span>
                      ) : (
                        <span className="text-gray-500">Manual</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span className={clsx('text-sm font-medium', getStatusColor(log.result))}>
                        {log.result}
                      </span>
                    </td>
                    <td className="p-3 text-sm text-gray-400">
                      <div className="truncate max-w-48" title={log.stdoutSnippet || 'No output'}>
                        {log.stdoutSnippet || 'No output'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}