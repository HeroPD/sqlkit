import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ConnectionOptions } from 'node:tls'
import type { ConnectionProfile, SslConfig } from '../../src/electron'
import { shortVersion, sslOptions } from './postgres'

// Only the ssl field matters here; the rest is filler so the type compiles.
const profileWithSsl = (ssl?: SslConfig): ConnectionProfile => ({
  id: 'test',
  name: 'test',
  engine: 'postgresql',
  host: 'localhost',
  port: '5432',
  username: 'u',
  password: 'p',
  database: 'postgres',
  file: '',
  folder: '',
  ssl,
})

const tmpDirs: string[] = []
const caFile = (contents: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-ca-'))
  tmpDirs.push(dir)
  const file = path.join(dir, 'ca.pem')
  fs.writeFileSync(file, contents)
  return file
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('sslOptions', () => {
  it('is false when ssl is absent or disabled', () => {
    expect(sslOptions(profileWithSsl(undefined))).toBe(false)
    expect(sslOptions(profileWithSsl({ mode: 'disable', ca: '' }))).toBe(false)
  })

  it('encrypts without verification for require mode', () => {
    expect(sslOptions(profileWithSsl({ mode: 'require', ca: '' }))).toEqual({ rejectUnauthorized: false })
  })

  it('verifies the certificate for verify-full with no CA override', () => {
    const options = sslOptions(profileWithSsl({ mode: 'verify-full', ca: '' })) as ConnectionOptions
    expect(options.rejectUnauthorized).toBe(true)
    expect(options.ca).toBeUndefined()
    // verify-full keeps the default hostname check.
    expect(options.checkServerIdentity).toBeUndefined()
  })

  it('skips the hostname check for verify-ca', () => {
    const options = sslOptions(profileWithSsl({ mode: 'verify-ca', ca: '' })) as ConnectionOptions
    expect(options.rejectUnauthorized).toBe(true)
    expect(typeof options.checkServerIdentity).toBe('function')
    expect(options.checkServerIdentity?.('host', {} as never)).toBeUndefined()
  })

  it('reads the CA certificate file when a path is given', () => {
    const file = caFile('---CERT---')
    const options = sslOptions(profileWithSsl({ mode: 'verify-full', ca: file })) as ConnectionOptions
    expect(options.ca).toBe('---CERT---')
  })

  it('ignores a blank (whitespace-only) CA path', () => {
    const options = sslOptions(profileWithSsl({ mode: 'verify-full', ca: '   ' })) as ConnectionOptions
    expect(options.ca).toBeUndefined()
  })

  it('throws a descriptive error when the CA file cannot be read', () => {
    expect(() => sslOptions(profileWithSsl({ mode: 'verify-full', ca: '/no/such/ca.pem' }))).toThrow(
      /Failed to read SSL CA certificate at \/no\/such\/ca\.pem/,
    )
  })
})

describe('shortVersion', () => {
  it('keeps just the product and version, dropping the build platform', () => {
    expect(shortVersion('PostgreSQL 17.2 on aarch64-apple-darwin, compiled by clang')).toBe('PostgreSQL 17.2')
  })

  it('returns the string unchanged when there is no platform suffix', () => {
    expect(shortVersion('PostgreSQL 17.2')).toBe('PostgreSQL 17.2')
  })
})
