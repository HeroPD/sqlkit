import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { ConnectionProfile } from '../../src/electron'
import type { Endpoint } from './transport'

// Integration DB connection string. An explicit env var wins (CI); otherwise
// the repo-root .env is read so `npm test` works locally with no exports.
// Undefined when neither is present — the integration suites then skip.
export function testDatabaseUrl(): string | undefined {
  return testUrl('TEST_DATABASE_URL')
}

/** MySQL integration URL (TEST_MYSQL_URL); undefined skips the mysql suite. */
export function testMysqlUrl(): string | undefined {
  return testUrl('TEST_MYSQL_URL')
}

/** SQL Server integration URL (TEST_MSSQL_URL); undefined skips the mssql suite. */
export function testMssqlUrl(): string | undefined {
  return testUrl('TEST_MSSQL_URL')
}

function testUrl(name: string): string | undefined {
  const fromEnv = process.env[name]?.trim()
  if (fromEnv) return fromEnv
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
    for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
      const value = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line)?.[1]
      if (value) return value.replace(/^["']|["']$/g, '')
    }
  } catch {
    // No .env on disk — leave it undefined so the suite skips.
  }
  return undefined
}

// Builds a postgres ConnectionProfile from a libpq URL; `overrides` tweak it
// per test (a wrong password, all-databases mode, a different id, …).
export function profileFromUrl(url: string, overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const parsed = new URL(url)
  const requireSsl = parsed.searchParams.get('sslmode') === 'require'
  return {
    id: 'integration',
    name: 'integration',
    engine: 'postgresql',
    host: parsed.hostname,
    port: parsed.port || '5432',
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    file: '',
    folder: '',
    ssl: { mode: requireSsl ? 'require' : 'disable', ca: '' },
    ...overrides,
  }
}

// A direct (untunneled) endpoint for driver-level tests — the connection
// manager resolves this itself, but driver tests construct the driver directly.
export function endpointFor(profile: ConnectionProfile): Endpoint {
  return { host: profile.host.trim() || 'localhost', port: Number(profile.port) || 5432, tunnel: null }
}

// A small out-of-band pool for arranging fixtures and cleanup, kept separate
// from the driver under test.
export function adminPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 2 })
}
