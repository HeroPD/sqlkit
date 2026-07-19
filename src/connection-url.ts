import type { ConnectionProfile, Engine, EngineFlavor, SslMode } from './electron'

const DEFAULT_PORTS: Partial<Record<Engine, string>> = {
  postgresql: '5432',
  mysql: '3306',
  sqlserver: '1433',
}

const scheme = (protocol: string): { engine: Engine; flavor?: EngineFlavor } | null => {
  switch (protocol.toLowerCase()) {
    case 'postgres:':
    case 'postgresql:':
      return { engine: 'postgresql' }
    case 'mysql:':
      return { engine: 'mysql' }
    case 'mariadb:':
      return { engine: 'mysql', flavor: 'mariadb' }
    case 'mssql:':
    case 'sqlserver:':
      return { engine: 'sqlserver' }
    default:
      return null
  }
}

const decoded = (value: string) => {
  try { return decodeURIComponent(value) } catch { return value }
}

const sslMode = (url: URL): SslMode => {
  const requested = url.searchParams.get('sslmode') ?? url.searchParams.get('ssl-mode')
  if (requested === 'disable' || requested === 'require' || requested === 'verify-ca' || requested === 'verify-full') {
    return requested
  }
  const ssl = url.searchParams.get('ssl') ?? url.searchParams.get('encrypt')
  if (ssl === 'true' || ssl === '1') return 'require'
  return 'disable'
}

/** Parses the connection URLs commonly emitted by hosted database providers. */
export function profileFromConnectionUrl(value: string, current: ConnectionProfile): ConnectionProfile {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Enter a valid database URL.')
  }
  const target = scheme(url.protocol)
  if (!target) throw new Error('Supported URL schemes: postgresql, postgres, mysql, mariadb, sqlserver, and mssql.')
  if (!url.hostname) throw new Error('The database URL must include a host.')

  const engine = target.engine
  const database = decoded(url.pathname.replace(/^\//, ''))
  return {
    ...current,
    engine,
    // A plain scheme keeps a same-engine flavor (Supabase URLs are postgres://).
    flavor: target.flavor ?? (engine === current.engine ? current.flavor : undefined),
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || DEFAULT_PORTS[engine] || '',
    username: decoded(url.username),
    database,
    ssl: { mode: sslMode(url), ca: current.ssl?.ca ?? '' },
    // A URL without a password keeps whatever the form already holds.
    ...(url.password ? { password: decoded(url.password), passwordSaved: false } : {}),
  }
}

/** Renders the canonical URL for a server profile; empty when none can represent it (sqlite, no host). */
export function connectionUrlFromProfile(profile: ConnectionProfile): string {
  if (profile.engine === 'sqlite' || !profile.host) return ''
  const protocol = profile.engine === 'mysql' && profile.flavor === 'mariadb' ? 'mariadb' : profile.engine
  const password = profile.password ? `:${encodeURIComponent(profile.password)}` : ''
  const auth = profile.username || password ? `${encodeURIComponent(profile.username)}${password}@` : ''
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host
  const port = profile.port && profile.port !== DEFAULT_PORTS[profile.engine] ? `:${profile.port}` : ''
  const database = profile.database ? `/${encodeURIComponent(profile.database)}` : ''
  const mode = profile.ssl?.mode
  return `${protocol}://${auth}${host}${port}${database}${mode && mode !== 'disable' ? `?sslmode=${mode}` : ''}`
}
