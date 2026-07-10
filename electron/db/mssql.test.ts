import { describe, expect, it } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ConnectionProfile } from '../../src/electron'
import { mssqlTls, mssqlVersion } from './mssql'

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
