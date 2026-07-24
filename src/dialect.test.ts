import { describe, expect, it } from 'vitest'
import { dialectFor, sqlOptionToken } from './dialect'

describe('sqlOptionToken', () => {
  it('passes charset/collation/locale names through unchanged', () => {
    for (const value of ['utf8mb4', 'utf8mb4_0900_ai_ci', 'Latin1_General_100_CI_AS', 'UTF8', 'en_US.UTF-8', 'C', 'POSIX']) {
      expect(sqlOptionToken(value)).toBe(value)
    }
  })

  it('rejects anything with quotes, spaces, or statement separators', () => {
    for (const value of ["utf8'; drop database x --", 'a b', 'x;y', 'utf8`', 'x)']) {
      expect(() => sqlOptionToken(value)).toThrow()
    }
  })
})

describe('dialectFor: identifier quoting', () => {
  it('quotes per engine and escapes the quote char', () => {
    expect(dialectFor('postgresql').quoteIdent('a"b')).toBe('"a""b"')
    expect(dialectFor('sqlite').quoteIdent('col')).toBe('"col"')
    expect(dialectFor('mysql').quoteIdent('a`b')).toBe('`a``b`')
    expect(dialectFor('sqlserver').quoteIdent('a]b')).toBe('[a]]b]')
  })
})

describe('dialectFor: placeholder', () => {
  it('numbers Postgres/SQL Server params and uses ? elsewhere', () => {
    expect(dialectFor('postgresql').placeholder(1)).toBe('$1')
    expect(dialectFor('postgresql').placeholder(7)).toBe('$7')
    expect(dialectFor('sqlserver').placeholder(2)).toBe('@p2')
    expect(dialectFor('sqlite').placeholder(1)).toBe('?')
    expect(dialectFor('mysql').placeholder(3)).toBe('?')
  })
})

describe('dialectFor: applyOrderBy', () => {
  it('builds a positional ORDER BY so duplicate/expression columns sort unambiguously', () => {
    // columnIndex is 0-based; the emitted ordinal is 1-based (ORDER BY <n>).
    expect(dialectFor('postgresql').applyOrderBy('SELECT * FROM t LIMIT 5', { columnIndex: 1, direction: 'desc' })).toBe(
      'SELECT * FROM t\nORDER BY 2 DESC\nLIMIT 5',
    )
    expect(dialectFor('mysql').applyOrderBy('SELECT * FROM t', { columnIndex: 0, direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY 1 ASC',
    )
    expect(dialectFor('sqlserver').applyOrderBy('SELECT * FROM t', { columnIndex: 0, direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY 1 ASC',
    )
  })

  it('replaces an existing ORDER BY', () => {
    expect(dialectFor('postgresql').applyOrderBy('SELECT * FROM t ORDER BY id', { columnIndex: 2, direction: 'asc' })).toBe(
      'SELECT * FROM t\nORDER BY 3 ASC',
    )
  })
})

describe('dialectFor: table browsing', () => {
  it('uses TOP for SQL Server and LIMIT for the other engines', () => {
    expect(dialectFor('sqlserver').browseTable('[dbo].[users]', 200)).toBe('SELECT TOP 200 * FROM [dbo].[users]')
    expect(dialectFor('postgresql').browseTable('"public"."users"', 200)).toBe('SELECT * FROM "public"."users" LIMIT 200')
    expect(dialectFor('mysql').browseTable('`users`', 200)).toBe('SELECT * FROM `users` LIMIT 200')
    expect(dialectFor('sqlite').browseTable('"users"', 200)).toBe('SELECT * FROM "users" LIMIT 200')
  })
})

describe('dialectFor: bindBoolean', () => {
  it('binds 1/0 on sqlite and real booleans elsewhere', () => {
    expect(dialectFor('sqlite').bindBoolean(true)).toBe(1)
    expect(dialectFor('sqlite').bindBoolean(false)).toBe(0)
    expect(dialectFor('postgresql').bindBoolean(true)).toBe(true)
    expect(dialectFor('mysql').bindBoolean(false)).toBe(false)
  })
})

describe('dialectFor: column edit capabilities', () => {
  it('gates each column edit per engine', () => {
    const caps = (engine: 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver') => dialectFor(engine).columnEdits
    expect(caps('postgresql')).toEqual({ rename: true, dataType: true, nullable: true, default: true, comment: true, add: true, drop: true })
    expect(caps('sqlite')).toEqual({ rename: true, dataType: false, nullable: false, default: false, comment: false, add: true, drop: true })
    expect(caps('mysql')).toEqual({ rename: true, dataType: false, nullable: false, default: true, comment: false, add: true, drop: true })
    expect(caps('sqlserver')).toEqual({ rename: true, dataType: true, nullable: true, default: false, comment: false, add: true, drop: true })
  })

  it('lists common column types only for wired-up engines', () => {
    expect(dialectFor('postgresql').commonColumnTypes).toEqual(expect.arrayContaining([
      'integer',
      'int',
      'character varying',
      'varchar',
      'timestamptz',
      'jsonpath',
      'macaddr8',
      'tsvector',
      'int4range',
      'int4multirange',
      'regclass',
      'pg_lsn',
      'uuid[]',
      'varchar(255)',
      'timestamp(6) with time zone',
      'interval day to second',
    ]))
    expect(dialectFor('sqlite').commonColumnTypes).toContain('integer')
    expect(dialectFor('mysql').commonColumnTypes).toContain('datetime')
    expect(dialectFor('sqlserver').commonColumnTypes).toContain('nvarchar(255)')
  })

  it('offers engine-appropriate default-value expressions', () => {
    expect(dialectFor('postgresql').commonDefaultValues).toContain('now()')
    expect(dialectFor('postgresql').commonDefaultValues).toContain('true')
    // SQL Server spells these differently and rejects now()/booleans as defaults.
    expect(dialectFor('sqlserver').commonDefaultValues).toContain('GETDATE()')
    expect(dialectFor('sqlserver').commonDefaultValues).not.toContain('now()')
    expect(dialectFor('sqlite').commonDefaultValues).not.toContain('now()')
  })
})
