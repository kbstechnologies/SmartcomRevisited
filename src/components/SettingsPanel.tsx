import { useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import { SettingsSchema } from '@shared/types'
import type { Settings } from '@shared/types'
import { XMarkIcon } from '@heroicons/react/24/outline'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
}

export default function SettingsPanel({ isOpen, onClose }: SettingsPanelProps) {
  const { settings, saveSettings, setTheme } = useStore()
  const [formData, setFormData] = useState<Partial<Settings>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState('general')

  useEffect(() => {
    if (isOpen && settings) {
      setFormData(settings)
    }
  }, [isOpen, settings])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})
    setSaving(true)

    try {
      const validatedSettings = SettingsSchema.parse(formData)
      await saveSettings(validatedSettings)
      setTheme(validatedSettings.theme)
      onClose()
    } catch (error: any) {
      if (error.errors) {
        const validationErrors: Record<string, string> = {}
        error.errors.forEach((err: any) => {
          validationErrors[err.path[0]] = err.message
        })
        setErrors(validationErrors)
      } else {
        setErrors({ general: error.message || 'Failed to save settings' })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleChange = (field: keyof Settings, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }))
    if (errors[field]) {
      setErrors(prev => ({ ...prev, [field]: '' }))
    }
  }

  const tabs = [
    { id: 'general', label: 'General', icon: '⚙️' },
    { id: 'terminal', label: 'Terminal', icon: '💻' },
    { id: 'logging', label: 'Logging', icon: '📝' },
    { id: 'security', label: 'Security', icon: '🔒' },
  ]

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl mx-4 h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-700">
          <h2 className="text-lg font-medium text-white">Settings</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <div className="w-48 bg-gray-700 border-r border-gray-600 p-4">
            <nav className="space-y-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left ${
                    activeTab === tab.id
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  <span>{tab.icon}</span>
                  <span>{tab.label}</span>
                </button>
              ))}
            </nav>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <form onSubmit={handleSubmit} className="h-full flex flex-col">
              <div className="flex-1 p-6">
                {errors.general && (
                  <div className="bg-red-600 text-white p-3 rounded-md text-sm mb-6">
                    {errors.general}
                  </div>
                )}

                {activeTab === 'general' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-white mb-4">General Settings</h3>
                      
                      <div className="form-group">
                        <label className="form-label">Theme</label>
                        <select
                          value={formData.theme || 'dark'}
                          onChange={(e) => handleChange('theme', e.target.value as 'dark' | 'light')}
                          className="form-select"
                        >
                          <option value="dark">Dark</option>
                          <option value="light">Light</option>
                        </select>
                        {errors.theme && <p className="text-red-400 text-xs mt-1">{errors.theme}</p>}
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          Auto-reconnect on connection loss
                        </label>
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={formData.autoReconnect || false}
                            onChange={(e) => handleChange('autoReconnect', e.target.checked)}
                            className="rounded border-gray-600 text-blue-600 focus:ring-blue-500 mr-2"
                          />
                          <span className="text-sm text-gray-400">
                            Automatically attempt to reconnect when a session is unexpectedly disconnected
                          </span>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          Enable keepalive
                        </label>
                        <div className="flex items-center mb-2">
                          <input
                            type="checkbox"
                            checked={formData.enableKeepalive || false}
                            onChange={(e) => handleChange('enableKeepalive', e.target.checked)}
                            className="rounded border-gray-600 text-blue-600 focus:ring-blue-500 mr-2"
                          />
                          <span className="text-sm text-gray-400">
                            Send periodic keepalive packets to maintain connections
                          </span>
                        </div>
                        
                        {formData.enableKeepalive && (
                          <div className="ml-6">
                            <label className="form-label text-sm">Keepalive interval (seconds)</label>
                            <input
                              type="number"
                              value={formData.keepaliveInterval || 30}
                              onChange={(e) => handleChange('keepaliveInterval', parseInt(e.target.value))}
                              className="form-input w-24"
                              min="10"
                              max="300"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'terminal' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-white mb-4">Terminal Settings</h3>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div className="form-group">
                          <label className="form-label">Font Size</label>
                          <input
                            type="number"
                            value={formData.fontSize || 14}
                            onChange={(e) => handleChange('fontSize', parseInt(e.target.value))}
                            className="form-input"
                            min="8"
                            max="24"
                          />
                          {errors.fontSize && <p className="text-red-400 text-xs mt-1">{errors.fontSize}</p>}
                        </div>

                        <div className="form-group">
                          <label className="form-label">Font Family</label>
                          <select
                            value={formData.fontFamily || 'JetBrains Mono'}
                            onChange={(e) => handleChange('fontFamily', e.target.value)}
                            className="form-select"
                          >
                            <option value="JetBrains Mono">JetBrains Mono</option>
                            <option value="Monaco">Monaco</option>
                            <option value="Menlo">Menlo</option>
                            <option value="Ubuntu Mono">Ubuntu Mono</option>
                            <option value="Consolas">Consolas</option>
                            <option value="Courier New">Courier New</option>
                          </select>
                        </div>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Scrollback Buffer Size</label>
                        <input
                          type="number"
                          value={formData.scrollback || 1000}
                          onChange={(e) => handleChange('scrollback', parseInt(e.target.value))}
                          className="form-input"
                          min="100"
                          max="10000"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          Number of lines to keep in terminal history
                        </p>
                        {errors.scrollback && <p className="text-red-400 text-xs mt-1">{errors.scrollback}</p>}
                      </div>

                      <div className="form-group">
                        <label className="form-label">Default Shell</label>
                        <input
                          type="text"
                          value={formData.defaultShell || '/bin/bash'}
                          onChange={(e) => handleChange('defaultShell', e.target.value)}
                          className="form-input"
                          placeholder="/bin/bash"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          Shell to use for new terminal sessions
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'logging' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-white mb-4">Audit Logging</h3>
                      
                      <div className="form-group">
                        <label className="form-label">Log Retention (days)</label>
                        <input
                          type="number"
                          value={formData.logRetentionDays || 90}
                          onChange={(e) => handleChange('logRetentionDays', parseInt(e.target.value))}
                          className="form-input"
                          min="1"
                          max="365"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          How long to keep audit logs before automatic cleanup
                        </p>
                        {errors.logRetentionDays && <p className="text-red-400 text-xs mt-1">{errors.logRetentionDays}</p>}
                      </div>

                      <div className="form-group">
                        <label className="form-label">
                          Mask sensitive data in logs
                        </label>
                        <div className="flex items-center">
                          <input
                            type="checkbox"
                            checked={formData.maskSensitiveData || false}
                            onChange={(e) => handleChange('maskSensitiveData', e.target.checked)}
                            className="rounded border-gray-600 text-blue-600 focus:ring-blue-500 mr-2"
                          />
                          <span className="text-sm text-gray-400">
                            Automatically mask passwords and other sensitive information in audit logs
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeTab === 'security' && (
                  <div className="space-y-6">
                    <div>
                      <h3 className="text-lg font-medium text-white mb-4">Security Settings</h3>
                      
                      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
                        <h4 className="text-sm font-medium text-gray-300 mb-2">Credential Storage</h4>
                        <p className="text-xs text-gray-400 mb-3">
                          Passwords and private key passphrases are securely stored using your system&apos;s 
                          credential manager (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux).
                        </p>
                        <div className="flex items-center text-green-400 text-sm">
                          <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                          Secure credential storage enabled
                        </div>
                      </div>

                      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
                        <h4 className="text-sm font-medium text-gray-300 mb-2">Connection Security</h4>
                        <ul className="text-xs text-gray-400 space-y-1">
                          <li>• All SSH connections use strong encryption</li>
                          <li>• Host key verification is enforced</li>
                          <li>• Private keys are loaded from secure storage only</li>
                          <li>• No credentials are stored in plain text</li>
                        </ul>
                      </div>

                      <div className="bg-gray-700 border border-gray-600 rounded-lg p-4">
                        <h4 className="text-sm font-medium text-gray-300 mb-2">Data Protection</h4>
                        <ul className="text-xs text-gray-400 space-y-1">
                          <li>• Database is encrypted at rest</li>
                          <li>• Sensitive command patterns are masked in logs</li>
                          <li>• No telemetry or data collection</li>
                          <li>• All data stays on your device</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex justify-end gap-2 p-6 border-t border-gray-700">
                <button
                  type="button"
                  onClick={onClose}
                  className="btn btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn btn-primary"
                >
                  {saving ? (
                    <>
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
                      Saving...
                    </>
                  ) : (
                    'Save Settings'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}