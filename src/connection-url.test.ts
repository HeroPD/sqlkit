import { describe, expect, it } from 'vitest'
import type { ConnectionProfile } from './electron'
import { connectionUrlFromProfile, profileFromConnectionUrl } from './connection-url'

const current = (): ConnectionProfile => ({
  id: 'p1', name: 'Main', engine: 'postgresql', host: '', port: '', username: '', password: '',
  database: '', file: '', folder: 'main',
})

describe('profileFromConnectionUrl', () => {
  it('parses a hosted PostgreSQL URL and SSL mode', () => {
    expect(profileFromConnectionUrl('postgresql://app%40user:s%23cret@db.example.com:6543/my%20db?sslmode=verify-full', current()))
      .toMatchObject({
        engine: 'postgresql', host: 'db.example.com', port: '6543', username: 'app@user', password: 's#cret',
        database: 'my db', ssl: { mode: 'verify-full', ca: '' }, passwordSaved: false,
      })
  })

  it('uses engine defaults and recognizes MariaDB and SQL Server URLs', () => {
    expect(profileFromConnectionUrl('mariadb://user:pass@localhost/shop', current()))
      .toMatchObject({ engine: 'mysql', flavor: 'mariadb', port: '3306', database: 'shop' })
    expect(profileFromConnectionUrl('sqlserver://sa:pass@localhost/app?encrypt=false', current()))
      .toMatchObject({ engine: 'sqlserver', port: '1433', ssl: { mode: 'disable' } })
  })

  it('rejects non-database URLs', () => {
    expect(() => profileFromConnectionUrl('https://example.com/db', current())).toThrow('Supported URL schemes')
  })

  it('keeps the password, CA path, and same-engine flavor when the URL omits them', () => {
    const existing: ConnectionProfile = {
      ...current(), flavor: 'supabase', password: 'kept', passwordSaved: true, ssl: { mode: 'disable', ca: '/certs/root.pem' },
    }
    expect(profileFromConnectionUrl('postgres://app@db.example.com/prod?sslmode=verify-ca', existing)).toMatchObject({
      flavor: 'supabase', username: 'app', password: 'kept', passwordSaved: true, ssl: { mode: 'verify-ca', ca: '/certs/root.pem' },
    })
    expect(profileFromConnectionUrl('mysql://db.example.com/prod', existing).flavor).toBeUndefined()
  })
})

describe('connectionUrlFromProfile', () => {
  it('renders a canonical URL that parses back to the same fields', () => {
    const profile: ConnectionProfile = {
      ...current(), host: 'db.example.com', port: '6543', username: 'app@user', password: 's#cret',
      database: 'my db', ssl: { mode: 'require', ca: '' },
    }
    const url = connectionUrlFromProfile(profile)
    expect(url).toBe('postgresql://app%40user:s%23cret@db.example.com:6543/my%20db?sslmode=require')
    expect(profileFromConnectionUrl(url, current())).toMatchObject({
      host: 'db.example.com', port: '6543', username: 'app@user', password: 's#cret', database: 'my db', ssl: { mode: 'require' },
    })
  })

  it('omits default ports, maps flavors to schemes, and is empty without a host', () => {
    expect(connectionUrlFromProfile({ ...current(), engine: 'mysql', flavor: 'mariadb', host: 'localhost', port: '3306', database: 'shop' }))
      .toBe('mariadb://localhost/shop')
    expect(connectionUrlFromProfile(current())).toBe('')
  })
})
