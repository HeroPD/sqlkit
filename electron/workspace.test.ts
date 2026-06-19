import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionProfile } from '../src/electron'
import { openWorkspace, readWorkspaceConfig, writeWorkspaceConfig } from './workspace'

// A reversible stand-in for Electron's OS-keychain safeStorage: "SEALED:" marks
// a value this machine produced, so a blob from elsewhere fails to decrypt the
// same way a real cross-machine config would. `state` is mutable so tests can
// flip encryption availability and point app.getPath at a temp dir.
const state = vi.hoisted(() => ({ encryptionAvailable: true, userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (value: string) => Buffer.from(`SEALED:${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8')
      if (!text.startsWith('SEALED:')) throw new Error('cannot decrypt on this machine')
      return text.slice('SEALED:'.length)
    },
  },
}))

let workspaceDir = ''

const profile = (overrides: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'Main DB',
  engine: 'postgresql',
  host: 'localhost',
  port: '5432',
  username: 'u',
  password: 'pg-password-1',
  database: 'app',
  file: '',
  folder: '',
  ...overrides,
})

const configPath = () => path.join(workspaceDir, '.sqlkit', 'config.json')
const rawConfig = () => fs.readFileSync(configPath(), 'utf8')
const writeRawConfig = (data: unknown) => {
  fs.mkdirSync(path.join(workspaceDir, '.sqlkit'), { recursive: true })
  fs.writeFileSync(configPath(), typeof data === 'string' ? data : JSON.stringify(data))
}

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-ws-'))
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-ud-'))
  state.encryptionAvailable = true
})

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true })
  fs.rmSync(state.userData, { recursive: true, force: true })
})

describe('workspace config: credential round-trip', () => {
  it('encrypts every secret at rest and decrypts them back on read', () => {
    const config = {
      version: 1,
      connections: [
        profile({
          password: 'pg-password-1',
          ssh: {
            enabled: true,
            host: 'bastion',
            port: '22',
            username: 'ops',
            authType: 'password' as const,
            password: 'ssh-password-2',
            keyPath: '',
            passphrase: 'key-passphrase-3',
          },
        }),
      ],
    }
    expect(writeWorkspaceConfig(workspaceDir, config).success).toBe(true)

    const raw = rawConfig()
    for (const secret of ['pg-password-1', 'ssh-password-2', 'key-passphrase-3']) {
      expect(raw).not.toContain(secret)
    }
    const stored = JSON.parse(raw) as { connections: { password: string; ssh: { password: string; passphrase: string } }[] }
    expect(stored.connections[0]?.password).toMatch(/^enc:v1:/)
    expect(stored.connections[0]?.ssh.password).toMatch(/^enc:v1:/)
    expect(stored.connections[0]?.ssh.passphrase).toMatch(/^enc:v1:/)

    const readBack = readWorkspaceConfig(workspaceDir)
    expect(readBack.error).toBeUndefined()
    const connection = readBack.config.connections[0]
    expect(connection?.password).toBe('pg-password-1')
    expect(connection?.ssh?.password).toBe('ssh-password-2')
    expect(connection?.ssh?.passphrase).toBe('key-passphrase-3')
  })

  it('decrypts a config sealed on another machine to empty rather than leaking it', () => {
    const foreign = `enc:v1:${Buffer.from('from-another-keychain').toString('base64')}`
    writeRawConfig({ version: 1, connections: [{ ...profile(), password: foreign }] })

    const result = readWorkspaceConfig(workspaceDir)
    expect(result.error).toBeUndefined()
    expect(result.config.connections[0]?.password).toBe('')
  })

  it('does not wrap an already-encrypted secret a second time', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'twice' })] })
    const encrypted = (JSON.parse(rawConfig()) as { connections: { password: string }[] }).connections[0]?.password ?? ''

    // Save the stored (already-encrypted) form again — it must pass through untouched.
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: encrypted })] })
    expect((JSON.parse(rawConfig()) as { connections: { password: string }[] }).connections[0]?.password).toBe(encrypted)
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('twice')
  })

  it('stores secrets in plaintext when the OS keychain is unavailable', () => {
    state.encryptionAvailable = false
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'plain-fallback' })] })

    const stored = JSON.parse(rawConfig()) as { connections: { password: string }[] }
    expect(stored.connections[0]?.password).toBe('plain-fallback')
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('plain-fallback')
  })
})

describe('workspace config: missing vs corrupt', () => {
  it('returns defaults with no error when no config exists yet', () => {
    const result = readWorkspaceConfig(workspaceDir)
    expect(result.error).toBeUndefined()
    expect(result.config).toEqual({ version: 1, connections: [] })
  })

  it('preserves a corrupt config and reports the error instead of wiping it', () => {
    writeRawConfig('{ this is not json')
    const result = readWorkspaceConfig(workspaceDir)
    expect(result.error).toMatch(/not valid JSON/)
    expect(result.config.connections).toEqual([])

    // Opening must not re-seed over an unreadable config — that would silently
    // destroy every saved connection on a single hand-edit slip.
    const before = rawConfig()
    openWorkspace(workspaceDir)
    expect(rawConfig()).toBe(before)
  })
})

describe('workspace open: legacy migration', () => {
  it('re-encrypts a legacy plaintext config when the workspace is opened', () => {
    writeRawConfig({ version: 1, connections: [{ ...profile(), password: 'legacy-plain' }] })

    expect(openWorkspace(workspaceDir).success).toBe(true)
    const stored = JSON.parse(rawConfig()) as { connections: { password: string }[] }
    expect(stored.connections[0]?.password).toMatch(/^enc:v1:/)
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('legacy-plain')
  })
})
