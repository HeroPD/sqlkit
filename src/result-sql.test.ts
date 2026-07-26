import { describe, expect, it } from 'vitest'
import { insertStatementForRow, insertTargetName, sqlLiteral, sqlStringLiteral, toInsertStatements } from './result-sql'
import type { TableRef } from './electron'

const users: TableRef = { schema: 'public', name: 'users', kind: 'table' }

describe('sqlStringLiteral', () => {
  it('doubles embedded single quotes on every engine', () => {
    expect(sqlStringLiteral("O'Brien", 'postgresql')).toBe("'O''Brien'")
    expect(sqlStringLiteral("O'Brien", 'sqlserver')).toBe("'O''Brien'")
  })

  it('doubles backslashes on MySQL, where they escape inside a literal', () => {
    expect(sqlStringLiteral('C:\\temp', 'mysql')).toBe("'C:\\\\temp'")
    // A value ending in a backslash would otherwise swallow the closing quote.
    expect(sqlStringLiteral("x\\", 'mysql')).toBe("'x\\\\'")
    expect(sqlStringLiteral("\\'; DROP TABLE users; --", 'mysql')).toBe("'\\\\''; DROP TABLE users; --'")
  })

  it('leaves backslashes alone on the engines that treat them literally', () => {
    expect(sqlStringLiteral('C:\\temp', 'postgresql')).toBe("'C:\\temp'")
    expect(sqlStringLiteral('C:\\temp', 'sqlite')).toBe("'C:\\temp'")
    expect(sqlStringLiteral('C:\\temp', 'sqlserver')).toBe("'C:\\temp'")
  })
})

describe('sqlLiteral', () => {
  it('renders null and undefined as NULL', () => {
    expect(sqlLiteral(null, 'postgresql')).toBe('NULL')
    expect(sqlLiteral(undefined, 'postgresql')).toBe('NULL')
  })

  it('spells booleans per engine', () => {
    expect(sqlLiteral(true, 'postgresql')).toBe('TRUE')
    expect(sqlLiteral(false, 'postgresql')).toBe('FALSE')
    for (const engine of ['mysql', 'sqlite', 'sqlserver'] as const) {
      expect(sqlLiteral(true, engine)).toBe('1')
      expect(sqlLiteral(false, engine)).toBe('0')
    }
  })

  it('renders a bigint exactly, past what a double can hold', () => {
    expect(sqlLiteral(9007199254740993n, 'postgresql')).toBe('9007199254740993')
  })

  it('renders numbers bare and non-finite ones as NULL', () => {
    expect(sqlLiteral(-5, 'postgresql')).toBe('-5')
    expect(sqlLiteral(0.1, 'postgresql')).toBe('0.1')
    expect(sqlLiteral(Number.NaN, 'postgresql')).toBe('NULL')
    expect(sqlLiteral(Number.POSITIVE_INFINITY, 'postgresql')).toBe('NULL')
  })

  it('renders bytes in each engine binary literal form', () => {
    const bytes = new Uint8Array([0xde, 0xad, 0x00, 0x0f])
    expect(sqlLiteral(bytes, 'postgresql')).toBe("'\\xdead000f'::bytea")
    expect(sqlLiteral(bytes, 'mysql')).toBe("X'dead000f'")
    expect(sqlLiteral(bytes, 'sqlite')).toBe("X'dead000f'")
    expect(sqlLiteral(bytes, 'sqlserver')).toBe('0xdead000f')
  })

  it('casts an empty value on SQL Server, which has no 0x literal for it', () => {
    expect(sqlLiteral(new Uint8Array([]), 'sqlserver')).toBe("CONVERT(varbinary(max), '')")
    expect(sqlLiteral(new Uint8Array([]), 'mysql')).toBe("X''")
  })

  it('renders a Date as UTC text without the ISO T/Z that MySQL rejects', () => {
    expect(sqlLiteral(new Date('2026-07-26T04:05:06.789Z'), 'mysql')).toBe("'2026-07-26 04:05:06.789'")
  })

  it('renders an object or array column as a JSON string literal', () => {
    expect(sqlLiteral({ a: 1 }, 'postgresql')).toBe(`'{"a":1}'`)
    expect(sqlLiteral([1, 2], 'postgresql')).toBe(`'[1,2]'`)
    // A quote inside the JSON still has to be doubled.
    expect(sqlLiteral({ a: "it's" }, 'postgresql')).toBe(`'{"a":"it''s"}'`)
  })

  it('falls back to NULL for an unserializable value', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(sqlLiteral(cyclic, 'postgresql')).toBe('NULL')
  })
})

describe('insertTargetName', () => {
  it('qualifies and quotes a known table per engine', () => {
    expect(insertTargetName(users, 'postgresql')).toBe('"public"."users"')
    expect(insertTargetName(users, 'mysql')).toBe('`public`.`users`')
    expect(insertTargetName(users, 'sqlserver')).toBe('[public].[users]')
  })

  it('falls back to a quoted placeholder when the result has no single table', () => {
    expect(insertTargetName(null, 'postgresql')).toBe('"table_name"')
    expect(insertTargetName(undefined, 'mysql')).toBe('`table_name`')
  })
})

describe('toInsertStatements', () => {
  it('packs rows into one multi-row VALUES list', () => {
    const sql = toInsertStatements({
      columns: ['id', 'name'],
      rows: [[1, 'ada'], [2, null]],
      engine: 'postgresql',
      table: users,
    })
    expect(sql).toBe(
      'INSERT INTO "public"."users" ("id", "name")\n' +
        `VALUES (1, 'ada'),\n` +
        '       (2, NULL);\n',
    )
  })

  it('pads a short row so its values stay aligned to the column list', () => {
    const sql = toInsertStatements({ columns: ['a', 'b'], rows: [[1]], engine: 'sqlite' })
    expect(sql).toContain('VALUES (1, NULL);')
  })

  it('splits at 1000 rows — SQL Server rejects a longer VALUES list', () => {
    const rows = Array.from({ length: 2_001 }, (_, index) => [index])
    const sql = toInsertStatements({ columns: ['id'], rows, engine: 'sqlserver', table: users })
    const statements = sql.trimEnd().split(';').filter((part) => part.trim())
    expect(statements).toHaveLength(3)
    expect(statements[0]?.match(/\(\d+\)/g)).toHaveLength(1_000)
    expect(statements[2]?.match(/\(\d+\)/g)).toHaveLength(1)
  })

  it('returns nothing when there are no columns or no rows', () => {
    expect(toInsertStatements({ columns: [], rows: [[1]], engine: 'postgresql' })).toBe('')
    expect(toInsertStatements({ columns: ['id'], rows: [], engine: 'postgresql' })).toBe('')
  })
})

describe('insertStatementForRow', () => {
  it('emits one complete terminated statement', () => {
    expect(insertStatementForRow([1, 'ada'], { columns: ['id', 'name'], engine: 'mysql', table: users })).toBe(
      'INSERT INTO `public`.`users` (`id`, `name`)\n' + `VALUES (1, 'ada');\n`,
    )
  })
})
