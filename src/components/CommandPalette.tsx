import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { clsx } from 'clsx'
import VariableForm from './VariableForm'
import { resolveFields, type FormField, type Macro } from '@shared/types'
import { macroTargets } from '../lib/macroTargets'

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
}

interface Command {
  id: string
  title: string
  description: string
  action: () => void
  category: 'profiles' | 'macros' | 'navigation' | 'settings'
  icon?: React.ReactNode
}

export default function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const {
    profiles,
    macros,
    macroSets,
    openSession,
    setActiveSession,
    runMacro,
    activeSessionId,
    sessions,
    broadcastInput,
    setActiveDialog
  } = useStore()

  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [pendingMacro, setPendingMacro] = useState<{ macro: Macro; fields: FormField[] } | null>(
    null
  )
  const inputRef = useRef<HTMLInputElement>(null)

  // Generate all available commands
  const allCommands: Command[] = [
    // Profile commands
    ...profiles.map(profile => ({
      id: `connect-${profile.id}`,
      title: `Connect to ${profile.name}`,
      description: `${profile.username}@${profile.host}:${profile.port}`,
      category: 'profiles' as const,
      action: async () => {
        try {
          const sessionId = await openSession(profile.id!)
          setActiveSession(sessionId)
          onClose()
        } catch (error) {
          console.error('Failed to open session:', error)
        }
      },
      icon: (
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <span className="text-xs font-medium text-white">SSH</span>
        </div>
      )
    })),

    // Macro commands
    ...macros.map(macro => {
      const macroSet = macroSets.find(set => set.id === macro.setId)
      return {
        id: `run-macro-${macro.id}`,
        title: `Run ${macro.name}`,
        description: macro.description || `From ${macroSet?.name || 'Unknown Set'}`,
        category: 'macros' as const,
        action: async () => {
          // Same targeting as the button panel: broadcast on means every
          // connected session, off means the focused one.
          const targets = macroTargets(sessions, activeSessionId, broadcastInput)
          if (targets.length === 0) {
            alert('No connected session. Please connect to a server first.')
            return
          }

          // Electron has no window.prompt, so anything needing input is
          // handed to the same popup form the button panel uses.
          const fields = resolveFields(macro)
          if (fields.length > 0) {
            setPendingMacro({ macro, fields })
            return
          }

          try {
            await Promise.all(
              targets.map((target) =>
                runMacro({ macroId: macro.id!, sessionId: target.id, variables: {} })
              )
            )
            onClose()
          } catch (error) {
            console.error('Failed to run macro:', error)
          }
        },
        icon: (
          <div className="w-8 h-8 bg-green-600 rounded-lg flex items-center justify-center">
            <span className="text-lg">⚡</span>
          </div>
        )
      }
    }),

    // Navigation commands. These open dialogs through the shared store —
    // previously they closed the palette and did nothing at all.
    {
      id: 'open-logs',
      title: 'View Audit Logs',
      description: 'Open the audit logs viewer',
      category: 'navigation' as const,
      action: () => {
        setActiveDialog('logs')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-purple-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">📋</span>
        </div>
      )
    },

    {
      id: 'open-scripts',
      title: 'Script Library',
      description: 'Browse your scripts and run one on this session',
      category: 'settings' as const,
      action: () => {
        setActiveDialog('scripts')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-cyan-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">📁</span>
        </div>
      ),
    },

    {
      id: 'open-globals',
      title: 'Global Variables',
      description: 'Values every button can use as {{NAME}}',
      category: 'settings' as const,
      action: () => {
        setActiveDialog('globals')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">🏷️</span>
        </div>
      ),
    },

    {
      id: 'open-keys',
      title: 'SSH Keys',
      description: 'Generate, import and install SSH keys',
      category: 'settings' as const,
      action: () => {
        setActiveDialog('keys')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-amber-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">🔑</span>
        </div>
      )
    },

    {
      id: 'open-settings',
      title: 'Open Settings',
      description: 'Configure application settings',
      category: 'settings' as const,
      action: () => {
        setActiveDialog('settings')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-gray-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">⚙️</span>
        </div>
      )
    },

    {
      id: 'open-about',
      title: 'About Smartcom Revisited',
      description: 'Version, environment and data locations',
      category: 'settings' as const,
      action: () => {
        setActiveDialog('about')
        onClose()
      },
      icon: (
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">ℹ️</span>
        </div>
      )
    },

    {
      id: 'new-profile',
      title: 'New Connection Profile',
      description: 'Create a new SSH connection profile',
      category: 'profiles' as const,
      action: () => {
        onClose()
        // This would trigger the profile form
      },
      icon: (
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
          <span className="text-lg">➕</span>
        </div>
      )
    }
  ]

  // Filter commands based on query
  const filteredCommands = allCommands.filter(command => {
    if (!query.trim()) return true
    const searchTerms = query.toLowerCase().split(' ')
    const searchText = `${command.title} ${command.description}`.toLowerCase()
    return searchTerms.every(term => searchText.includes(term))
  })

  // Group commands by category
  const groupedCommands = filteredCommands.reduce((groups, command) => {
    if (!groups[command.category]) {
      groups[command.category] = []
    }
    groups[command.category].push(command)
    return groups
  }, {} as Record<string, Command[]>)

  const categoryLabels = {
    profiles: 'Connections',
    macros: 'Macros',
    navigation: 'Navigation',
    settings: 'Settings'
  }

  const categoryOrder = ['profiles', 'macros', 'navigation', 'settings'] as const

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => Math.min(prev + 1, filteredCommands.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => Math.max(prev - 1, 0))
          break
        case 'Enter': {
          e.preventDefault()
          const selectedCommand = filteredCommands[selectedIndex]
          if (selectedCommand) {
            selectedCommand.action()
          }
          break
        }
        case 'Escape':
          e.preventDefault()
          onClose()
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, selectedIndex, filteredCommands, onClose])

  // Reset selection when query changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Reset state when closing
  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setSelectedIndex(0)
    }
  }, [isOpen])

  // The input popup outlives the palette itself, so it renders first.
  if (pendingMacro) {
    return (
      <VariableForm
        title={pendingMacro.macro.name}
        description={pendingMacro.macro.description}
        fields={pendingMacro.fields}
        submitLabel="Run"
        onCancel={() => setPendingMacro(null)}
        onSubmit={(variables) => {
          const macroId = pendingMacro.macro.id!
          setPendingMacro(null)
          // One answer, every target — see macroTargets.
          for (const target of macroTargets(sessions, activeSessionId, broadcastInput)) {
            void runMacro({ macroId, sessionId: target.id, variables })
          }
          onClose()
        }}
      />
    )
  }

  if (!isOpen) return null

  // Calculate the actual selected command considering grouping
  let globalIndex = 0

  for (const category of categoryOrder) {
    const commands = groupedCommands[category] || []
    if (globalIndex <= selectedIndex && selectedIndex < globalIndex + commands.length) {
      break
    }
    globalIndex += commands.length
  }

  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <div 
        className="command-palette"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input */}
        <div className="p-4 border-b border-gray-600">
          <div className="relative">
            <MagnifyingGlassIcon className="w-5 h-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
            <input
              ref={inputRef}
              type="text"
              placeholder="Search commands..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 bg-transparent border-none text-white placeholder-gray-400 focus:outline-none text-lg"
            />
          </div>
        </div>

        {/* Commands */}
        <div className="max-h-96 overflow-y-auto">
          {filteredCommands.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              <div className="text-4xl mb-2">🔍</div>
              <p>No commands found</p>
              <p className="text-sm text-gray-400 mt-1">Try a different search term</p>
            </div>
          ) : (
            <div className="p-2">
              {(() => {
                let globalIdx = 0
                return categoryOrder.map(category => {
                  const commands = groupedCommands[category]
                  if (!commands || commands.length === 0) return null

                  const categoryItems = commands.map((command) => {
                    const isSelected = globalIdx === selectedIndex
                    globalIdx++
                    
                    return (
                      <button
                        key={command.id}
                        onClick={command.action}
                        className={clsx(
                          'w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left',
                          isSelected 
                            ? 'bg-blue-600 text-white' 
                            : 'hover:bg-gray-700 text-gray-300'
                        )}
                      >
                        {command.icon}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium">{command.title}</div>
                          <div className={clsx(
                            'text-sm truncate',
                            isSelected ? 'text-blue-100' : 'text-gray-400'
                          )}>
                            {command.description}
                          </div>
                        </div>
                      </button>
                    )
                  })

                  return (
                    <div key={category} className="mb-4">
                      <div className="px-3 py-1 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        {categoryLabels[category]}
                      </div>
                      <div className="space-y-1">
                        {categoryItems}
                      </div>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-gray-600 text-xs text-gray-400 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <span>↑↓ Navigate</span>
            <span>↵ Select</span>
            <span>Esc Close</span>
          </div>
          <div>
            {filteredCommands.length} commands
          </div>
        </div>
      </div>
    </div>
  )
}