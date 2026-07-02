// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile, TestConnectionResult, TestSshResult } from '../electron'
import { DbConfigForm } from './db-config-form'

const profile = (over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({
  id: 'p1',
  name: 'Main',
  engine: 'postgresql',
  host: 'localhost',
  port: '5432',
  username: 'postgres',
  password: '',
  database: 'app',
  file: '',
  folder: 'main',
  ...over,
})

type TestState = { phase: string; message?: string }
const internals = (form: DbConfigForm) =>
  form as never as {
    _test: TestState
    _sshTest: TestState
    _patch(partial: Partial<ConnectionProfile>): void
    _onEngineChange(id: string): void
    _onSave(): void
    _onTest(): Promise<void>
    _onTestSsh(): Promise<void>
    _onBrowse(): Promise<void>
  }

const setup = (over: Partial<ConnectionProfile> = {}) => {
  const form = new DbConfigForm()
  form.profile = profile(over)
  const changes: ConnectionProfile[] = []
  form.addEventListener('config-change', (e) =>
    changes.push((e as CustomEvent<{ profile: ConnectionProfile }>).detail.profile),
  )
  return { form, changes }
}

describe('DbConfigForm draft editing', () => {
  it('emits config-change with the merged profile without mutating the input', () => {
    const { form, changes } = setup()
    const before = { ...form.profile! }
    internals(form)._patch({ host: 'db.internal' })

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ host: 'db.internal', name: 'Main' })
    expect(form.profile).toEqual(before)
  })

  it('resets a finished connection test when the draft changes', () => {
    const { form } = setup()
    internals(form)._test = { phase: 'error', message: 'boom' }
    internals(form)._patch({ port: '5433' })
    expect(internals(form)._test).toEqual({ phase: 'idle' })
  })
})

describe('DbConfigForm engine switch port carry', () => {
  it('swaps a default port for the new engine default', () => {
    const { form, changes } = setup({ port: '5432' })
    internals(form)._onEngineChange('mysql')
    expect(changes[0]).toMatchObject({ engine: 'mysql', port: '3306' })
  })

  it('fills an empty port with the new engine default', () => {
    const { form, changes } = setup({ port: '' })
    internals(form)._onEngineChange('sqlserver')
    expect(changes[0]).toMatchObject({ engine: 'sqlserver', port: '1433' })
  })

  it('keeps a user-customized port', () => {
    const { form, changes } = setup({ port: '6000' })
    internals(form)._onEngineChange('mysql')
    expect(changes[0]).toMatchObject({ engine: 'mysql', port: '6000' })
  })

  it('keeps the port when the new engine has no default (sqlite)', () => {
    const { form, changes } = setup({ port: '5432' })
    internals(form)._onEngineChange('sqlite')
    expect(changes[0]).toMatchObject({ engine: 'sqlite', port: '5432' })
  })

  it('maps compatible variants to their parent engine with a flavor tag', () => {
    const { form, changes } = setup({ port: '5432' })
    internals(form)._onEngineChange('supabase')
    expect(changes[0]).toMatchObject({ engine: 'postgresql', flavor: 'supabase', port: '5432' })

    internals(form)._onEngineChange('mariadb')
    expect(changes[1]).toMatchObject({ engine: 'mysql', flavor: 'mariadb', port: '3306' })
  })

  it('clears the flavor when switching back to a plain engine', () => {
    const { form, changes } = setup({ flavor: 'supabase' })
    internals(form)._onEngineChange('postgresql')
    expect(changes[0]?.flavor).toBeUndefined()
    expect(changes[0]).toMatchObject({ engine: 'postgresql' })
  })

  it('ignores roadmapped entries with no driver', () => {
    const { form, changes } = setup()
    internals(form)._onEngineChange('clickhouse')
    expect(changes).toHaveLength(0)
  })
})

describe('DbConfigForm save', () => {
  const saved = (form: DbConfigForm) => {
    const profiles: ConnectionProfile[] = []
    form.addEventListener('config-save', (e) =>
      profiles.push((e as CustomEvent<{ profile: ConnectionProfile }>).detail.profile),
    )
    return profiles
  }

  it('trims the name on save', () => {
    const { form } = setup({ name: '  Padded  ' })
    const profiles = saved(form)
    internals(form)._onSave()
    expect(profiles[0]?.name).toBe('Padded')
  })

  it('falls back to Untitled when the name is blank', () => {
    const { form } = setup({ name: '   ' })
    const profiles = saved(form)
    internals(form)._onSave()
    expect(profiles[0]?.name).toBe('Untitled')
  })
})

describe('DbConfigForm connection tests', () => {
  const stubSqlkit = (api: Record<string, unknown>) => {
    ;(window as never as { sqlkit: Record<string, unknown> }).sqlkit = api
  }

  it('reports a successful test with the server version', async () => {
    stubSqlkit({
      testConnection: vi.fn(() =>
        Promise.resolve<TestConnectionResult>({ success: true, serverVersion: 'PostgreSQL 17.2', tookMs: 12 }),
      ),
    })
    const { form } = setup()
    await internals(form)._onTest()
    expect(internals(form)._test).toEqual({ phase: 'ok', message: 'Connected — PostgreSQL 17.2 (12 ms)' })
  })

  it('reports a failed test with the driver error', async () => {
    stubSqlkit({
      testConnection: vi.fn(() =>
        Promise.resolve<TestConnectionResult>({ success: false, error: 'connection refused', tookMs: 5 }),
      ),
    })
    const { form } = setup()
    await internals(form)._onTest()
    expect(internals(form)._test).toEqual({ phase: 'error', message: 'connection refused' })
  })

  it('reports SSH tunnel test results', async () => {
    stubSqlkit({
      testSshTunnel: vi.fn(() => Promise.resolve<TestSshResult>({ success: false, error: 'auth failed', tookMs: 8 })),
    })
    const { form } = setup()
    await internals(form)._onTestSsh()
    expect(internals(form)._sshTest).toEqual({ phase: 'error', message: 'auth failed' })
  })
})

describe('DbConfigForm sqlite file picker', () => {
  it('patches the file path when the picker returns one', async () => {
    ;(window as never as { sqlkit: { pickSqliteFile: () => Promise<string | null> } }).sqlkit = {
      pickSqliteFile: vi.fn(() => Promise.resolve('/data/app.sqlite')),
    }
    const { form, changes } = setup({ engine: 'sqlite' })
    await internals(form)._onBrowse()
    expect(changes[0]).toMatchObject({ file: '/data/app.sqlite' })
  })

  it('emits nothing when the picker is cancelled', async () => {
    ;(window as never as { sqlkit: { pickSqliteFile: () => Promise<string | null> } }).sqlkit = {
      pickSqliteFile: vi.fn(() => Promise.resolve(null)),
    }
    const { form, changes } = setup({ engine: 'sqlite' })
    await internals(form)._onBrowse()
    expect(changes).toHaveLength(0)
  })
})
