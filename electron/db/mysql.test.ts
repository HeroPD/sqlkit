import { describe, expect, it } from 'vitest'
import { mysqlVersion } from './mysql'

describe('mysqlVersion', () => {
  it('labels plain MySQL versions', () => {
    expect(mysqlVersion('9.3.0')).toBe('MySQL 9.3.0')
    expect(mysqlVersion('8.0.36')).toBe('MySQL 8.0.36')
  })

  it('recognizes MariaDB version strings', () => {
    expect(mysqlVersion('11.4.2-MariaDB-1:11.4.2+maria~ubu2404')).toBe('MariaDB 11.4.2')
  })
})
