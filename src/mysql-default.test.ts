import { describe, expect, it } from 'vitest'
import { mysqlCatalogDefault, wrappedInParens } from './mysql-default'

describe('mysqlCatalogDefault', () => {
  it('quotes literal defaults that information_schema returns bare', () => {
    expect(mysqlCatalogDefault('pending', '', 'varchar(20)')).toBe("'pending'")
    expect(mysqlCatalogDefault("it's", '', 'varchar(20)')).toBe("'it''s'")
    expect(mysqlCatalogDefault('a\\b', '', 'varchar(20)')).toBe("'a\\\\b'")
    expect(mysqlCatalogDefault('a\\b', '', 'varchar(20)', { noBackslashEscapes: true })).toBe("'a\\b'")
    expect(mysqlCatalogDefault('', '', 'varchar(20)')).toBe("''")
    expect(mysqlCatalogDefault('NULL', '', 'varchar(10)')).toBe("'NULL'")
    expect(mysqlCatalogDefault('2020-01-02', '', 'date')).toBe("'2020-01-02'")
    expect(mysqlCatalogDefault('y', '', "enum('x','y')")).toBe("'y'")
  })

  it('keeps numeric, bit and binary literals as they are', () => {
    expect(mysqlCatalogDefault('0', '', 'int')).toBe('0')
    expect(mysqlCatalogDefault('1.50', '', 'decimal(5,2)')).toBe('1.50')
    expect(mysqlCatalogDefault('-1000', '', 'double')).toBe('-1000')
    expect(mysqlCatalogDefault("b'1'", '', 'bit(1)')).toBe("b'1'")
    expect(mysqlCatalogDefault('0x6162', '', 'varbinary(4)')).toBe('0x6162')
  })

  it('spells DEFAULT_GENERATED expressions the way SHOW CREATE TABLE does', () => {
    expect(mysqlCatalogDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', 'timestamp')).toBe('CURRENT_TIMESTAMP')
    expect(mysqlCatalogDefault('CURRENT_TIMESTAMP(3)', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)', 'datetime(3)'))
      .toBe('CURRENT_TIMESTAMP(3)')
    expect(mysqlCatalogDefault('curdate()', 'DEFAULT_GENERATED', 'date')).toBe('(curdate())')
    expect(mysqlCatalogDefault('(1 + 2)', 'DEFAULT_GENERATED', 'int')).toBe('(1 + 2)')
    expect(mysqlCatalogDefault("_utf8mb4\\'it\\\\\\'s\\'", 'DEFAULT_GENERATED', 'varchar(20)')).toBe("(_utf8mb4'it\\'s')")
  })

  it('passes MariaDB defaults through, since MariaDB already returns SQL', () => {
    expect(mysqlCatalogDefault("'pending'", '', 'varchar(20)', { mariadb: true })).toBe("'pending'")
    expect(mysqlCatalogDefault('current_timestamp()', '', 'timestamp', { mariadb: true })).toBe('current_timestamp()')
  })

  it('keeps a missing default missing', () => {
    expect(mysqlCatalogDefault(null, '', 'varchar(20)')).toBeNull()
  })
})

describe('wrappedInParens', () => {
  it('requires one group around the whole value', () => {
    expect(wrappedInParens('(now())')).toBe(true)
    expect(wrappedInParens("(')')")).toBe(true)
    expect(wrappedInParens('(1) + (2)')).toBe(false)
    expect(wrappedInParens('now()')).toBe(false)
  })
})
