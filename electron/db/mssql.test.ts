import { describe, expect, it } from 'vitest'
import sql from 'mssql'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionProfile } from '../../src/electron'
import { mssqlTls, mssqlVersion, normalizeMssqlRow, tediousToMssqlType, toBindable } from './mssql'

describe('mssqlVersion', () => {
  it('shortens the @@version banner to product and year', () => {
    expect(mssqlVersion('Microsoft SQL Server 2022 (RTM-CU14) (KB5038325) - 16.0.4135.4 (X64) \n\tJul  8 2024')).toBe(
      'Microsoft SQL Server 2022',
    )
    expect(mssqlVersion('Microsoft SQL Server 2019')).toBe('Microsoft SQL Server 2019')
  })
})

describe('mssqlTls', () => {
  const profile = (mode: 'disable' | 'require' | 'verify-ca' | 'verify-full', ca = ''): ConnectionProfile =>
    ({ ssl: { mode, ca } }) as ConnectionProfile

  it('maps disable to cleartext and require to trust-any-cert encryption', () => {
    expect(mssqlTls(profile('disable'))).toEqual({ encrypt: false, trustServerCertificate: true })
    expect(mssqlTls(profile('require'))).toEqual({ encrypt: true, trustServerCertificate: true })
  })

  it('maps verify-full to verified encryption and reads an optional CA file', () => {
    expect(mssqlTls(profile('verify-full'))).toEqual({ encrypt: true, trustServerCertificate: false })
    const file = join(tmpdir(), `sqlkit-ca-${crypto.randomUUID()}.pem`)
    try {
      writeFileSync(file, 'PEM DATA')
      expect(mssqlTls(profile('verify-full', file))).toEqual({
        encrypt: true,
        trustServerCertificate: false,
        ca: 'PEM DATA',
      })
    } finally {
      unlinkSync(file)
    }
  })

  it('rejects verify-ca because tedious cannot disable only hostname verification', () => {
    expect(() => mssqlTls(profile('verify-ca'))).toThrow(/does not support CA-only/i)
  })
})

describe('normalizeMssqlRow', () => {
  it('returns safe decimal and temporal values as exact text', () => {
    const timestamp = new Date('2026-07-10T03:04:05.123Z') as Date & { nanosecondsDelta?: number }
    Object.defineProperty(timestamp, 'nanosecondsDelta', { value: 0.000_045_6 })
    expect(normalizeMssqlRow(
      [12.34, timestamp],
      [
        { name: 'amount', type: sql.Decimal, precision: 8, scale: 2 },
        { name: 'created_at', type: sql.DateTime2, scale: 7 },
      ],
    )).toEqual(['12.34', '2026-07-10 03:04:05.1230456'])
  })

  it('rejects values the driver has already made lossy', () => {
    expect(() => normalizeMssqlRow(
      [9_007_199_254_740_992],
      [{ name: 'amount', type: sql.Decimal, precision: 19, scale: 0 }],
    )).toThrow(/CAST it to varchar/)
    expect(() => normalizeMssqlRow(
      [new Date('2026-07-10T00:00:00Z')],
      [{ name: 'at', type: sql.DateTimeOffset, scale: 7 }],
    )).toThrow(/original offset is discarded/)
  })
})

describe('toBindable', () => {
  it('converts Uint8Array (post-IPC binary) to Buffer so node-mssql infers VarBinary', () => {
    const bytes = new Uint8Array([1, 2, 255])
    const bound = toBindable(bytes)
    expect(Buffer.isBuffer(bound)).toBe(true)
    expect([...(bound as Buffer)]).toEqual([1, 2, 255])
  })

  it('respects byte offsets into a shared ArrayBuffer', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer
    const view = new Uint8Array(backing, 2, 3)
    expect([...(toBindable(view) as Buffer)]).toEqual([1, 2, 3])
  })

  it('passes Buffers and non-binary values through untouched', () => {
    const buffer = Buffer.from([7])
    expect(toBindable(buffer)).toBe(buffer)
    expect(toBindable('x')).toBe('x')
    expect(toBindable(42n)).toBe(42n)
    expect(toBindable(null)).toBeNull()
  })
})

describe('tediousToMssqlType', () => {
  const meta = (name: string, extra: Record<string, number> = {}) => ({ colName: 'c', type: { name }, ...extra })

  it('maps temporal tokens (which arrive as JS Date) to the mssql type so normalizeMssqlRow formats them', () => {
    expect(tediousToMssqlType(meta('DateTime2', { scale: 3 }))).toEqual({ type: sql.DateTime2, scale: 3 })
    expect(tediousToMssqlType(meta('Date'))).toEqual({ type: sql.Date })
    expect(tediousToMssqlType(meta('TimeN', { scale: 7 }))).toEqual({ type: sql.Time, scale: 7 })
    expect(tediousToMssqlType(meta('DateTimeOffset', { scale: 7 }))).toEqual({ type: sql.DateTimeOffset, scale: 7 })
  })

  it('distinguishes datetime from smalldatetime by payload length', () => {
    expect(tediousToMssqlType(meta('DateTimeN', { dataLength: 8 })).type).toBe(sql.DateTime)
    expect(tediousToMssqlType(meta('DateTimeN', { dataLength: 4 })).type).toBe(sql.SmallDateTime)
    expect(tediousToMssqlType(meta('MoneyN', { dataLength: 8 })).type).toBe(sql.Money)
    expect(tediousToMssqlType(meta('MoneyN', { dataLength: 4 })).type).toBe(sql.SmallMoney)
  })

  it('carries precision and scale for decimal and numeric', () => {
    expect(tediousToMssqlType(meta('DecimalN', { precision: 38, scale: 2 }))).toEqual({ type: sql.Decimal, precision: 38, scale: 2 })
    expect(tediousToMssqlType(meta('NumericN', { precision: 10, scale: 4 }))).toEqual({ type: sql.Numeric, precision: 10, scale: 4 })
  })

  it('returns no type for tokens that need no normalization (already-correct values)', () => {
    expect(tediousToMssqlType(meta('IntN'))).toEqual({})
    expect(tediousToMssqlType(meta('NVarChar'))).toEqual({})
    expect(tediousToMssqlType(meta('BitN'))).toEqual({})
  })
})
