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
    _urlDraft: string | null
    _urlError: string
    _onUrlInput(value: string): void
    _onUrlBlur(): void
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

  it('offers muted label colors and patches the selected preset', async () => {
    const { form, changes } = setup()
    document.body.appendChild(form)
    await form.updateComplete

    const colors = [...form.shadowRoot!.querySelectorAll<HTMLButtonElement>('.label-color')]
    expect(colors.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Ruby', 'Magenta', 'Violet', 'Indigo', 'Blue', 'Cyan', 'Teal', 'Green', 'Gold', 'Orange',
    ])
    colors[0]?.click()
    expect(changes[0]?.labelColor).toBe('accent-01')
    form.remove()
  })

  it('resets a finished connection test when the draft changes', () => {
    const { form } = setup()
    internals(form)._test = { phase: 'error', message: 'boom' }
    internals(form)._patch({ port: '5433' })
    expect(internals(form)._test).toEqual({ phase: 'idle' })
  })

  it('shows dots for saved secrets without putting the mask into the profile', async () => {
    const { form } = setup({
      passwordSaved: true,
      ssh: {
        enabled: true,
        host: 'bastion',
        port: '22',
        username: 'deploy',
        authType: 'password',
        keyPath: '',
        password: '',
        passwordSaved: true,
        passphrase: '',
      },
    })
    document.body.appendChild(form)
    await form.updateComplete

    const passwordInputs = [...form.shadowRoot!.querySelectorAll<HTMLInputElement>('input[type="password"]')]
    expect(passwordInputs).toHaveLength(2)
    expect(passwordInputs.every((input) => input.placeholder === '••••••••' && input.value === '')).toBe(true)
    expect(form.profile?.password).toBe('')
    expect(form.profile?.ssh?.password).toBe('')
    form.remove()
  })

  it('toggles the read-only guardrail and clears it back to undefined', async () => {
    const readOnlyToggle = (form: DbConfigForm) =>
      [...form.shadowRoot!.querySelectorAll<HTMLLabelElement>('label.toggle')]
        .find((label) => label.textContent?.includes('Read-only'))!
        .querySelector('input')!

    const on = setup()
    document.body.appendChild(on.form)
    await on.form.updateComplete
    readOnlyToggle(on.form).click()
    expect(on.changes.at(-1)?.readOnly).toBe(true)
    on.form.remove()

    // The toggle also renders for file-based engines, and unchecking drops the
    // flag entirely rather than persisting readOnly: false.
    const off = setup({ engine: 'sqlite', readOnly: true })
    document.body.appendChild(off.form)
    await off.form.updateComplete
    const toggle = readOnlyToggle(off.form)
    expect(toggle.checked).toBe(true)
    toggle.click()
    expect(off.changes.at(-1)?.readOnly).toBeUndefined()
    off.form.remove()
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

describe('DbConfigForm connection URL', () => {
  it('patches the profile live as a parseable URL is typed', () => {
    const { form, changes } = setup()
    internals(form)._onUrlInput('postgresql://app:secret@db.example.com:6543/prod?sslmode=require')

    expect(changes[0]).toMatchObject({
      engine: 'postgresql', host: 'db.example.com', port: '6543', username: 'app', password: 'secret',
      database: 'prod', ssl: { mode: 'require' },
    })
    expect(internals(form)._urlError).toBe('')
  })

  it('stays quiet on an incomplete URL while typing and reports it on blur', () => {
    const { form, changes } = setup()
    internals(form)._onUrlInput('not a url')
    expect(changes).toHaveLength(0)
    expect(internals(form)._urlError).toBe('')

    internals(form)._onUrlBlur()
    expect(internals(form)._urlError).toBe('Enter a valid database URL.')
  })

  it('drops the URL draft when a field edit re-derives the URL', () => {
    const { form } = setup()
    internals(form)._onUrlInput('nope')
    expect(internals(form)._urlDraft).toBe('nope')

    internals(form)._patch({ host: 'db.internal' })
    expect(internals(form)._urlDraft).toBeNull()
    expect(internals(form)._urlError).toBe('')
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

describe('DbConfigForm connection switch', () => {
  it('clears stale test and URL feedback when the edited connection changes', async () => {
    const { form } = setup()
    document.body.appendChild(form)
    await form.updateComplete

    internals(form)._test = { phase: 'error', message: 'connection refused' }
    internals(form)._sshTest = { phase: 'error', message: 'auth failed' }
    internals(form)._urlDraft = 'postgres://bad'
    internals(form)._urlError = 'Enter a valid database URL.'

    form.profile = profile({ id: 'p2', name: 'Other' })
    await form.updateComplete

    expect(internals(form)._test).toEqual({ phase: 'idle' })
    expect(internals(form)._sshTest).toEqual({ phase: 'idle' })
    expect(internals(form)._urlDraft).toBeNull()
    expect(internals(form)._urlError).toBe('')
    form.remove()
  })

  it('keeps test feedback when the same connection is re-rendered by a field edit', async () => {
    const { form } = setup()
    document.body.appendChild(form)
    await form.updateComplete

    internals(form)._test = { phase: 'ok', message: 'Connected' }
    // A parent field edit re-renders with a fresh profile object of the same id.
    form.profile = profile({ host: 'db.internal' })
    await form.updateComplete

    expect(internals(form)._test).toEqual({ phase: 'ok', message: 'Connected' })
    form.remove()
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
