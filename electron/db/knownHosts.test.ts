import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hostKeyFingerprint, verifyHostKey } from './knownHosts'

// knownHosts.ts imports `app` from electron only for storePath(), which these
// tests never hit (they pass an explicit store path). Stub it so importing the
// module under vitest doesn't require the real Electron binary.
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const tmpFiles: string[] = []
const tmpStore = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-kh-')), 'known_hosts.json')
  tmpFiles.push(file)
  return file
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

const keyA = Buffer.from('ssh-ed25519 AAAA-host-key-A')
const keyB = Buffer.from('ssh-ed25519 AAAA-host-key-B')

describe('verifyHostKey', () => {
  it('trusts and pins an unknown host on first use', () => {
    const file = tmpStore()
    const outcome = verifyHostKey(file, 'bastion:22', keyA)
    expect(outcome).toEqual({ trusted: true, firstUse: true })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty(['bastion:22'])
  })

  it('trusts a known host whose key is unchanged', () => {
    const file = tmpStore()
    verifyHostKey(file, 'bastion:22', keyA)
    expect(verifyHostKey(file, 'bastion:22', keyA)).toEqual({ trusted: true, firstUse: false })
  })

  it('rejects a known host whose key changed, reporting both fingerprints', () => {
    const file = tmpStore()
    verifyHostKey(file, 'bastion:22', keyA)
    const outcome = verifyHostKey(file, 'bastion:22', keyB)
    expect(outcome.trusted).toBe(false)
    if (outcome.trusted) return
    expect(outcome.pinned).toBe(hostKeyFingerprint(keyA))
    expect(outcome.presented).toBe(hostKeyFingerprint(keyB))
  })

  it('pins per host:port, so a different port is its own first use', () => {
    const file = tmpStore()
    verifyHostKey(file, 'bastion:22', keyA)
    expect(verifyHostKey(file, 'bastion:2222', keyB)).toEqual({ trusted: true, firstUse: true })
  })
})

describe('hostKeyFingerprint', () => {
  it('is the unpadded base64 SHA-256 of the key blob, OpenSSH style', () => {
    expect(hostKeyFingerprint(keyA)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/)
    expect(hostKeyFingerprint(keyA)).not.toContain('=')
  })
})
