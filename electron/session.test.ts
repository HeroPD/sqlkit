import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SessionTab, WorkspaceSession } from '../src/electron'
import { dropBackup, hasBackup, markSessionClean, readBackup, readSession, writeBackup, writeSession, writeShutdownBackup } from './session'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8'),
    getSelectedStorageBackend: () => 'keychain',
  },
}))

let workspace = ''

const sqlTab = (overrides: Partial<Extract<SessionTab, { kind: 'sql' }>> = {}): SessionTab => ({
  kind: 'sql',
  id: 'tab-1',
  name: 'Untitled-1',
  path: null,
  ...overrides,
})

const session = (tabs: SessionTab[]): WorkspaceSession => ({
  version: 1,
  contexts: [{ profileId: 'p1', childDb: null, tabs, activeTabId: tabs[0]?.id ?? null, selectedTable: null }],
})

const sessionFile = () => path.join(workspace, '.sqlkit', 'session.json')
const backupsDir = () => path.join(workspace, '.sqlkit', 'backups')

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-session-'))
  state.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-userdata-'))
})

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(state.userData, { recursive: true, force: true })
})

describe('session file', () => {
  it('round-trips the open tabs', () => {
    const saved = session([sqlTab({ id: 'file:/ws/a.sql', name: 'a.sql', path: '/ws/a.sql', dirty: true })])
    expect(writeSession(workspace, saved).success).toBe(true)

    const loaded = readSession(workspace)
    expect(loaded?.contexts[0]).toMatchObject({ profileId: 'p1', childDb: null, activeTabId: 'file:/ws/a.sql' })
    expect(loaded?.contexts[0]?.tabs[0]).toMatchObject({ id: 'file:/ws/a.sql', path: '/ws/a.sql', dirty: true })
  })

  // The format is a released contract: these are the shapes a future version has
  // to keep reading, or migrate deliberately under a new filename.
  it('keeps the database identity as its parts, not a composite key', () => {
    writeSession(workspace, {
      version: 1,
      contexts: [{ profileId: 'p1', childDb: 'billing', tabs: [sqlTab()], activeTabId: 'tab-1', selectedTable: 'public.users' }],
    })
    expect(readSession(workspace)?.contexts[0]).toMatchObject({ profileId: 'p1', childDb: 'billing', selectedTable: 'public.users' })
  })

  it('reads back the no-context bucket', () => {
    writeSession(workspace, {
      version: 1,
      contexts: [{ profileId: null, childDb: null, tabs: [sqlTab()], activeTabId: 'tab-1', selectedTable: null }],
    })
    expect(readSession(workspace)?.contexts[0]).toMatchObject({ profileId: null, childDb: null })
  })

  it('ignores a session too large to be one this app wrote', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({ version: 1, contexts: [], filler: 'x'.repeat(6 * 1024 * 1024) }))
    expect(readSession(workspace)).toBeNull()
  })

  it('drops fields it does not know rather than refusing the session', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({
      version: 1,
      somethingLater: { nested: true },
      contexts: [{ profileId: 'p1', childDb: null, tabs: [{ ...sqlTab(), somethingLater: 1 }], activeTabId: 'tab-1', selectedTable: null }],
    }))
    const loaded = readSession(workspace)
    expect(loaded?.contexts[0]?.tabs).toHaveLength(1)
    expect(loaded).not.toHaveProperty('somethingLater')
  })

  it('reads as nothing to restore when there is no file', () => {
    expect(readSession(workspace)).toBeNull()
    expect(readSession(null)).toBeNull()
  })

  it('leaves a broken file alone rather than restoring garbage', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), '{ not json')
    expect(readSession(workspace)).toBeNull()
    // The file survives: the buffers beside it may still be wanted.
    expect(fs.existsSync(sessionFile())).toBe(true)
  })

  it('refuses a session from an unknown version, leaving the file for it', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({ version: 99, contexts: [] }))
    expect(readSession(workspace)).toBeNull()
    // Nothing restores, but a newer version's file is not destroyed on read —
    // an incompatible future format belongs in a file of its own.
    expect(JSON.parse(fs.readFileSync(sessionFile(), 'utf8')).version).toBe(99)
  })

  it('marks every write unclean and clears it only on an orderly quit', () => {
    writeSession(workspace, session([sqlTab()]))
    expect(readSession(workspace)?.unclean).toBe(true)

    markSessionClean(workspace)
    expect(readSession(workspace)?.unclean).toBe(false)
  })

  it('keeps the session out of version control', () => {
    writeSession(workspace, session([sqlTab()]))
    const ignored = fs.readFileSync(path.join(workspace, '.sqlkit', '.gitignore'), 'utf8')
    expect(ignored).toContain('session.json')
    expect(ignored).toContain('backups/')
  })

  it('never persists a password typed into a config tab', () => {
    const tab: SessionTab = {
      kind: 'config',
      id: 'p1',
      profileId: 'p1',
      draft: {
        id: 'p1',
        name: 'prod',
        engine: 'postgresql',
        host: 'db.example.com',
        port: '5432',
        username: 'app',
        password: 'hunter2',
        database: 'app',
        file: '',
        folder: 'prod',
        ssh: {
          enabled: true,
          host: 'bastion',
          port: '22',
          username: 'ops',
          authType: 'password',
          password: 'sshsecret',
          keyPath: '',
          passphrase: 'keysecret',
        },
      },
    }
    writeSession(workspace, session([tab]))

    expect(fs.readFileSync(sessionFile(), 'utf8')).not.toContain('hunter2')
    const restored = readSession(workspace)?.contexts[0]?.tabs[0]
    expect(restored).toMatchObject({ kind: 'config', draft: { password: '' } })
    expect(restored?.kind === 'config' && restored.draft?.ssh).toMatchObject({ password: '', passphrase: '' })
  })

  it('drops a tab kind it does not understand, and the pointer to it', () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true })
    fs.writeFileSync(sessionFile(), JSON.stringify({
      version: 1,
      contexts: [{ profileId: 'p1', childDb: null, tabs: [{ kind: 'notebook', id: 'n1' }], activeTabId: 'n1', selectedTable: null }],
    }))
    const loaded = readSession(workspace)
    expect(loaded?.contexts[0]?.tabs).toEqual([])
    expect(loaded?.contexts[0]?.activeTabId).toBeNull()
  })
})

describe('session slots', () => {
  it('keeps a second window in its own file, leaving the first untouched', () => {
    writeSession(workspace, session([sqlTab({ id: 'first' })]))
    writeSession(workspace, session([sqlTab({ id: 'second' })]), 1)

    expect(readSession(workspace)?.contexts[0]?.tabs[0]?.id).toBe('first')
    expect(readSession(workspace, 1)?.contexts[0]?.tabs[0]?.id).toBe('second')
    // Slot 0 stays session.json, so a workspace one window ever opens is the
    // file it has always been.
    expect(fs.existsSync(sessionFile())).toBe(true)
    expect(fs.existsSync(path.join(workspace, '.sqlkit', 'session.1.json'))).toBe(true)
  })

  it('keeps a window buffers out of reach of the other, under the same tab id', () => {
    // Two windows with the same file open give their tabs the same id, so only
    // the slot keeps one window's unsaved text off the other's.
    writeBackup(workspace, 'file:/ws/a.sql', 'window one edit')
    writeBackup(workspace, 'file:/ws/a.sql', 'window two edit', 1)

    expect(readBackup(workspace, 'file:/ws/a.sql')).toBe('window one edit')
    expect(readBackup(workspace, 'file:/ws/a.sql', 1)).toBe('window two edit')

    // Saving in the first window drops its own copy, not the second's.
    dropBackup(workspace, 'file:/ws/a.sql')
    expect(readBackup(workspace, 'file:/ws/a.sql')).toBeNull()
    expect(readBackup(workspace, 'file:/ws/a.sql', 1)).toBe('window two edit')
  })

  it('sweeps only its own slot, so one window cannot orphan another', () => {
    writeBackup(workspace, 'kept-by-slot-1', 'select 1', 1)
    writeBackup(workspace, 'orphan', 'select 2')
    writeSession(workspace, session([sqlTab({ id: 'kept-by-slot-1', path: null })]), 1)

    // Slot 0 claims neither, and sweeps only what lives in its own directory.
    writeSession(workspace, session([sqlTab({ id: 'mine', path: null })]))

    expect(readBackup(workspace, 'kept-by-slot-1', 1)).toBe('select 1')
    expect(readBackup(workspace, 'orphan')).toBeNull()
  })

  it('clears the crash marker of one slot at a time', () => {
    writeSession(workspace, session([sqlTab({ id: 'first' })]))
    writeSession(workspace, session([sqlTab({ id: 'second' })]), 1)

    markSessionClean(workspace, 1)

    expect(readSession(workspace)?.unclean).toBe(true)
    expect(readSession(workspace, 1)?.unclean).toBe(false)
  })
})

describe('buffer backups', () => {
  it('round-trips a buffer and drops it on request', () => {
    expect(writeBackup(workspace, 'file:/ws/a.sql', 'select 1').success).toBe(true)
    expect(readBackup(workspace, 'file:/ws/a.sql')).toBe('select 1')

    dropBackup(workspace, 'file:/ws/a.sql')
    expect(readBackup(workspace, 'file:/ws/a.sql')).toBeNull()
  })

  it('names backups so a path-derived tab id is still a legal filename', () => {
    writeBackup(workspace, 'file:/ws/nested/dir/a.sql', 'select 1')
    const [name] = fs.readdirSync(backupsDir())
    expect(name).toMatch(/^[0-9a-f]{32}\.sql$/)
  })

  it('refuses a buffer past the size cap', () => {
    expect(writeBackup(workspace, 'tab-1', 'x'.repeat(11 * 1024 * 1024)).success).toBe(false)
  })

  it('sweeps backups no tab claims, keeping dirty and untitled ones', () => {
    writeBackup(workspace, 'kept-dirty', 'select 1')
    writeBackup(workspace, 'kept-untitled', 'select 2')
    writeBackup(workspace, 'orphan', 'select 3')

    writeSession(workspace, session([
      sqlTab({ id: 'kept-dirty', path: '/ws/a.sql', dirty: true }),
      sqlTab({ id: 'kept-untitled', path: null }),
    ]))

    expect(readBackup(workspace, 'kept-dirty')).toBe('select 1')
    expect(readBackup(workspace, 'kept-untitled')).toBe('select 2')
    expect(readBackup(workspace, 'orphan')).toBeNull()
  })

  it('sweeps the backup of a saved file, which is no longer dirty', () => {
    writeBackup(workspace, 'file:/ws/a.sql', 'select 1')
    writeSession(workspace, session([sqlTab({ id: 'file:/ws/a.sql', path: '/ws/a.sql' })]))
    expect(readBackup(workspace, 'file:/ws/a.sql')).toBeNull()
  })

  it('has nothing to write without a workspace', () => {
    expect(writeBackup(null, 'tab-1', 'select 1').success).toBe(false)
    expect(readBackup(null, 'tab-1')).toBeNull()
  })
})

// The shutdown flush is the one write whose outcome only this side sees, and the
// session it then writes decides which backups survive the prune.
describe('shutdown buffer writes', () => {
  const oversized = 'x'.repeat(11 * 1024 * 1024)

  it('reports a tab as backed once its buffer lands', () => {
    expect(writeShutdownBackup(workspace, 'tab-1', 'select 1')).toEqual({ unbacked: false })
    expect(readBackup(workspace, 'tab-1')).toBe('select 1')
  })

  it('leaves an older backup claimed when a newer write is refused', () => {
    writeBackup(workspace, 'tab-1', 'version A')
    // Refused, and the previous version is still sitting there: reporting this
    // tab as unbacked would drop it from the session and prune version A away.
    expect(writeShutdownBackup(workspace, 'tab-1', oversized)).toEqual({ unbacked: false })
    expect(readBackup(workspace, 'tab-1')).toBe('version A')
  })

  it('reports a tab as unbacked when the write is refused and nothing was there', () => {
    expect(writeShutdownBackup(workspace, 'tab-1', oversized)).toEqual({ unbacked: true })
    expect(readBackup(workspace, 'tab-1')).toBeNull()
  })

  it('survives the prune that the session write then runs', () => {
    writeBackup(workspace, 'tab-1', 'version A')
    writeShutdownBackup(workspace, 'tab-1', oversized)
    // The session still claims the tab, so its surviving copy is not swept.
    writeSession(workspace, session([sqlTab({ id: 'tab-1', dirty: true })]))
    expect(readBackup(workspace, 'tab-1')).toBe('version A')
  })

  it('knows whether a tab has anything on disk', () => {
    expect(hasBackup(workspace, 'tab-1')).toBe(false)
    writeBackup(workspace, 'tab-1', 'select 1')
    expect(hasBackup(workspace, 'tab-1')).toBe(true)
    dropBackup(workspace, 'tab-1')
    expect(hasBackup(workspace, 'tab-1')).toBe(false)
    expect(hasBackup(null, 'tab-1')).toBe(false)
  })
})
