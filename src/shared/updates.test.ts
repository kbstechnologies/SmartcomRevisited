import { describe, expect, it } from 'vitest'
import { selfUpdateSupport, type PackageKind } from './updates'

describe('selfUpdateSupport', () => {
  it('lets the installer and AppImage builds replace themselves', () => {
    expect(selfUpdateSupport('nsis').canInstall).toBe(true)
    expect(selfUpdateSupport('appimage').canInstall).toBe(true)
  })

  it('never writes over a package the system package manager owns', () => {
    // Replacing files dpkg/rpm tracks would leave their database wrong.
    const support = selfUpdateSupport('deb-rpm')
    expect(support.canInstall).toBe(false)
    expect(support.reason).toMatch(/package manager/i)
  })

  it('refuses to self-update unsigned macOS builds', () => {
    // Squirrel.Mac rejects unsigned bundles; trying would fail after the
    // download and look like a broken update.
    expect(selfUpdateSupport('mac').canInstall).toBe(false)
  })

  it('leaves a portable build to the user', () => {
    expect(selfUpdateSupport('portable').canInstall).toBe(false)
  })

  it('explains every case it cannot install, so nothing is a dead end', () => {
    const kinds: PackageKind[] = ['nsis', 'appimage', 'deb-rpm', 'mac', 'portable', 'dev']
    for (const kind of kinds) {
      const support = selfUpdateSupport(kind)
      if (!support.canInstall) {
        expect(support.reason, `${kind} has no explanation`).toBeTruthy()
      }
    }
  })
})
