import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionProfile } from '../src/electron'
import {
  hydrateConnectionProfile,
  openWorkspace,
  readWorkspaceConfig,
  readWorkspaceConfigForRenderer,
  readWorkspaceHistory,
  readTheme,
  isWeakStorageBackend,
  writeWorkspaceConfig,
  writeWorkspaceHistory,
  writeTheme,
} from './workspace'

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
    getSelectedStorageBackend: () => 'gnome_libsecret',
  },
}))

describe('credential storage strength', () => {
  it('recognizes Electron basic_text as weak only on Linux', () => {
    expect(isWeakStorageBackend('linux', 'basic_text')).toBe(true)
    expect(isWeakStorageBackend('darwin', 'basic_text')).toBe(false)
    expect(isWeakStorageBackend('linux', 'gnome_libsecret')).toBe(false)
  })
})

describe('global theme', () => {
  it('defaults invalid or missing values to dark and persists a selection', () => {
    expect(readTheme()).toBe('dark')
    writeTheme('light')
    expect(readTheme()).toBe('light')
    writeTheme('midnight-blue')
    expect(readTheme()).toBe('midnight-blue')
    writeTheme('warm-dark')
    expect(readTheme()).toBe('warm-dark')
    fs.writeFileSync(path.join(state.userData, 'config.json'), JSON.stringify({ theme: 'unknown' }))
    expect(readTheme()).toBe('dark')
  })
})

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
    if (process.platform !== 'win32') expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600)

    const readBack = readWorkspaceConfig(workspaceDir)
    expect(readBack.error).toBeUndefined()
    const connection = readBack.config.connections[0]
    expect(connection?.password).toBe('pg-password-1')
    expect(connection?.ssh?.password).toBe('ssh-password-2')
    expect(connection?.ssh?.passphrase).toBe('key-passphrase-3')
  })

  it('never returns saved secret values to the renderer and restores them only in main', () => {
    const saved = profile({
      password: 'db-secret',
      ssh: {
        enabled: true,
        host: 'bastion',
        port: '22',
        username: 'ops',
        authType: 'password',
        password: 'ssh-secret',
        keyPath: '',
        passphrase: 'key-secret',
      },
    })
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [saved] })

    const renderer = readWorkspaceConfigForRenderer(workspaceDir).config.connections[0]!
    expect(renderer.password).toBe('')
    expect(renderer.passwordSaved).toBe(true)
    expect(renderer.ssh?.password).toBe('')
    expect(renderer.ssh?.passwordSaved).toBe(true)
    expect(renderer.ssh?.passphrase).toBe('')
    expect(renderer.ssh?.passphraseSaved).toBe(true)

    const hydrated = hydrateConnectionProfile(workspaceDir, renderer)
    expect(hydrated.password).toBe('db-secret')
    expect(hydrated.ssh?.password).toBe('ssh-secret')
    expect(hydrated.ssh?.passphrase).toBe('key-secret')
    expect(hydrated.passwordSaved).toBeUndefined()
  })

  it('preserves redacted saved secrets on config persistence and allows explicit replacement', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'old-secret' })] })
    const renderer = readWorkspaceConfigForRenderer(workspaceDir).config.connections[0]!
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [renderer] })
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('old-secret')

    writeWorkspaceConfig(workspaceDir, {
      version: 1,
      connections: [{ ...renderer, password: 'new-secret', passwordSaved: false }],
    })
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('new-secret')
  })

  it('does not forward a saved secret to a renderer-modified host', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'host-bound' })] })
    const renderer = readWorkspaceConfigForRenderer(workspaceDir).config.connections[0]!
    expect(hydrateConnectionProfile(workspaceDir, { ...renderer, host: 'attacker.example' }).password).toBe('')
  })

  it('decrypts a config sealed on another machine to empty rather than leaking it', () => {
    const foreign = `enc:v1:${Buffer.from('from-another-keychain').toString('base64')}`
    writeRawConfig({ version: 1, connections: [{ ...profile(), password: foreign }] })

    const result = readWorkspaceConfig(workspaceDir)
    expect(result.error).toBeUndefined()
    expect(result.config.connections[0]?.password).toBe('')
  })

  it('does not overwrite undecryptable encrypted secrets when opening the workspace', () => {
    const foreign = `enc:v1:${Buffer.from('from-another-keychain').toString('base64')}`
    writeRawConfig({ version: 1, connections: [{ ...profile(), password: foreign }] })

    expect(openWorkspace(workspaceDir).success).toBe(true)

    const stored = JSON.parse(rawConfig()) as { connections: { password: string }[] }
    expect(stored.connections[0]?.password).toBe(foreign)
  })

  it('does not wrap an already-encrypted secret a second time', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'twice' })] })
    const encrypted = (JSON.parse(rawConfig()) as { connections: { password: string }[] }).connections[0]?.password ?? ''

    // Save the stored (already-encrypted) form again — it must pass through untouched.
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: encrypted })] })
    expect((JSON.parse(rawConfig()) as { connections: { password: string }[] }).connections[0]?.password).toBe(encrypted)
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('twice')
  })

  it('stores secrets as plaintext and flags them unencrypted when the OS keychain is unavailable', () => {
    state.encryptionAvailable = false
    expect(writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'plain-fallback' })] }).success).toBe(true)

    // Plaintext is destructive-free and round-trips, so the password is usable
    // this session and the next; the read flag (and .gitignore) carry the risk.
    const stored = JSON.parse(rawConfig()) as { connections: { password: string }[] }
    expect(stored.connections[0]?.password).toBe('plain-fallback')
    const read = readWorkspaceConfig(workspaceDir)
    expect(read.config.connections[0]?.password).toBe('plain-fallback')
    expect(read.unencryptedSecrets).toBe(true)
  })

  it('does not flag unencrypted secrets when there are none, even without a keychain', () => {
    state.encryptionAvailable = false
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: '' })] })
    expect(readWorkspaceConfig(workspaceDir).unencryptedSecrets).toBeFalsy()
  })

  it('does not flag unencrypted secrets when the keychain encrypted them', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'sekret' })] })
    expect(readWorkspaceConfig(workspaceDir).unencryptedSecrets).toBeFalsy()
  })

  it('rewrites an existing password unchanged on a keyless re-save (no silent wipe)', () => {
    // The renderer's persist() ignores the result and fires on every context
    // switch; storing plaintext must round-trip so a re-save can't blank it.
    state.encryptionAvailable = false
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [profile({ password: 'still-here' })] })
    const reloaded = readWorkspaceConfig(workspaceDir).config.connections
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: reloaded })
    expect(readWorkspaceConfig(workspaceDir).config.connections[0]?.password).toBe('still-here')
  })
})

describe('workspace config: credential .gitignore guard', () => {
  const gitignore = () => fs.readFileSync(path.join(workspaceDir, '.sqlkit', '.gitignore'), 'utf8')

  it('ignores config.json, history.json and their atomic-write temp files', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [] })
    const lines = gitignore().split('\n')
    expect(lines).toContain('config.json')
    expect(lines).toContain('config.json.tmp')
    expect(lines).toContain('history.json')
    expect(lines).toContain('history.json.tmp')
  })

  it('augments a hand-edited .gitignore with the missing rules instead of skipping', () => {
    fs.mkdirSync(path.join(workspaceDir, '.sqlkit'), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, '.sqlkit', '.gitignore'), 'custom\n')
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [] })
    const content = gitignore()
    expect(content).toContain('custom')
    expect(content.split('\n')).toContain('config.json')
    expect(content.split('\n')).toContain('config.json.tmp')
  })

  it('does not duplicate rules a .gitignore already covers', () => {
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [] })
    const first = gitignore()
    writeWorkspaceConfig(workspaceDir, { version: 1, connections: [] })
    expect(gitignore()).toBe(first)
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

  it('rejects a structurally invalid config instead of trusting a JSON cast', () => {
    writeRawConfig({ version: 1, connections: [{ ...profile(), engine: 'oracle' }] })
    const before = rawConfig()
    const result = readWorkspaceConfig(workspaceDir)
    expect(result.error).toMatch(/invalid configuration.*engine/i)
    expect(result.config.connections).toEqual([])
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

  it('preserves a legacy plaintext password when opened without a keychain (no silent wipe)', () => {
    writeRawConfig({ version: 1, connections: [{ ...profile(), password: 'legacy-plain' }] })
    state.encryptionAvailable = false

    expect(openWorkspace(workspaceDir).success).toBe(true)
    // Re-saved (folders/.gitignore) but, with no key store, the password is
    // rewritten as-is rather than encrypted or blanked.
    const stored = JSON.parse(rawConfig()) as { connections: { password: string }[] }
    expect(stored.connections[0]?.password).toBe('legacy-plain')
  })
})

describe('workspace query history', () => {
  const item = (id: string, sql = 'select 1'): import('../src/electron').HistoryItem =>
    ({ id, contextKey: 'p1', sql, success: true, durationMs: 3, rowCount: 1, error: '', createdAt: '2026-07-19T00:00:00Z' })

  it('round-trips history through .sqlkit/history.json', () => {
    expect(writeWorkspaceHistory(workspaceDir, [item('a'), item('b')])).toEqual({ success: true })
    expect(readWorkspaceHistory(workspaceDir).map((entry) => entry.id)).toEqual(['a', 'b'])
    // The file holds query text (possibly secrets) — the gitignore guard covers it.
    const rules = fs.readFileSync(path.join(workspaceDir, '.sqlkit', '.gitignore'), 'utf8').split('\n')
    expect(rules).toContain('history.json')
  })

  it('reads missing or corrupt history as empty instead of failing', () => {
    expect(readWorkspaceHistory(workspaceDir)).toEqual([])
    fs.mkdirSync(path.join(workspaceDir, '.sqlkit'), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir, '.sqlkit', 'history.json'), '{not json')
    expect(readWorkspaceHistory(workspaceDir)).toEqual([])
    fs.writeFileSync(path.join(workspaceDir, '.sqlkit', 'history.json'), JSON.stringify([{ bogus: true }, item('ok')]))
    expect(readWorkspaceHistory(workspaceDir).map((entry) => entry.id)).toEqual(['ok'])
  })

  it('reports no-workspace instead of writing anywhere', () => {
    expect(writeWorkspaceHistory(null, [item('a')]).success).toBe(false)
    expect(readWorkspaceHistory(null)).toEqual([])
  })
})
