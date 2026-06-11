import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { MSSQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql'
import { queryToRun } from './run-query'

const stateAt = (
  doc: string,
  cursor: number,
  options: { anchor?: number; dialect?: SQLDialect } = {},
) =>
  EditorState.create({
    doc,
    selection: { anchor: options.anchor ?? cursor, head: cursor },
    extensions: sql({ dialect: options.dialect ?? PostgreSQL }),
  })

/** Cursor placed where `|` appears in the doc. */
const queryAtCaret = (docWithCaret: string, dialect?: SQLDialect) => {
  const cursor = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  return queryToRun(stateAt(doc, cursor, { dialect }))
}

describe('queryToRun', () => {
  it('runs the statement under the cursor', () => {
    expect(queryAtCaret('SELECT 1;\nSELECT |2;\nSELECT 3;')).toBe('SELECT 2;')
  })

  it('runs the nearest statement when the cursor sits between statements', () => {
    expect(queryAtCaret('SELECT 1;\n|\n\n\nSELECT 2;')).toBe('SELECT 1;')
  })

  it('prefers the selection over the nearest statement', () => {
    const doc = 'SELECT 1;\nSELECT 2;'
    const state = stateAt(doc, doc.indexOf('SELECT 2'), { anchor: doc.length })
    expect(queryToRun(state)).toBe('SELECT 2;')
  })

  it('runs the trailing statement without a semicolon', () => {
    expect(queryAtCaret('SELECT 1;\nSELECT |2')).toBe('SELECT 2')
  })

  it('does not split on a semicolon inside a string literal', () => {
    expect(queryAtCaret("SELECT| 'a;b';\nSELECT 2;")).toBe("SELECT 'a;b';")
  })

  it('does not split on semicolons inside a dollar-quoted body', () => {
    const doc =
      'CREATE FUNCTION f() RETURNS void AS $$\n  SELECT 1;| SELECT 2;\n$$ LANGUAGE sql;\nSELECT 3;'
    expect(queryAtCaret(doc)).toBe(
      'CREATE FUNCTION f() RETURNS void AS $$\n  SELECT 1; SELECT 2;\n$$ LANGUAGE sql;',
    )
  })

  it('keeps a CTE and its body as one statement', () => {
    const doc = 'WITH r AS (\n  SELECT 1\n)\nSELECT * |FROM r;\nSELECT 2;'
    expect(queryAtCaret(doc)).toBe('WITH r AS (\n  SELECT 1\n)\nSELECT * FROM r;')
  })

  it('does not split on a comment containing a semicolon', () => {
    expect(queryAtCaret('SELECT 1 -- note;\n  + |2;\nSELECT 3;')).toBe('SELECT 1 -- note;\n  + 2;')
  })

  it('falls back to blank-line blocks when the doc has no semicolons', () => {
    expect(queryAtCaret('SELECT 1\nFROM a\n\nSELECT |2\nFROM b')).toBe('SELECT 2\nFROM b')
  })

  it('treats a single semicolon-less query with no blank lines as one block', () => {
    expect(queryAtCaret('SELECT 1\nFROM |a\nWHERE x = 1')).toBe('SELECT 1\nFROM a\nWHERE x = 1')
  })

  it('returns an empty string for an empty or whitespace-only doc', () => {
    expect(queryAtCaret('|')).toBe('')
    expect(queryAtCaret('  \n|\n  ')).toBe('')
  })

  it('works with other dialects', () => {
    expect(queryAtCaret('SELECT TOP 1 * FROM a;\nPRAGMA |table_info(b);', SQLite)).toBe(
      'PRAGMA table_info(b);',
    )
    expect(queryAtCaret('SELECT TOP 5 * FROM a;\nSELECT |2;', MSSQL)).toBe('SELECT 2;')
  })

  describe('cursor at boundaries', () => {
    it('picks the first statement when the cursor is at the start of the doc', () => {
      expect(queryAtCaret('|\n\nSELECT 1;\nSELECT 2;')).toBe('SELECT 1;')
    })

    it('picks the last statement when the cursor is in trailing whitespace', () => {
      expect(queryAtCaret('SELECT 1;\nSELECT 2;\n\n  |')).toBe('SELECT 2;')
    })

    it('covers the statement when the cursor is on its first character', () => {
      expect(queryAtCaret('SELECT 1;\n|SELECT 2;\nSELECT 3;')).toBe('SELECT 2;')
    })

    it('covers the statement when the cursor is right after its semicolon', () => {
      expect(queryAtCaret('SELECT 1;|\nSELECT 2;')).toBe('SELECT 1;')
    })

    it('prefers the earlier statement when equidistant', () => {
      expect(queryAtCaret('SELECT 1;\n|\nSELECT 2;')).toBe('SELECT 1;')
    })

    it('runs inside whitespace in the middle of a multi-line statement', () => {
      expect(queryAtCaret('SELECT 1,\n   |   2\nFROM t;\nSELECT 3;')).toBe(
        'SELECT 1,\n      2\nFROM t;',
      )
    })
  })

  describe('non-statement content', () => {
    it('picks the nearest statement when the cursor is inside a top-level comment', () => {
      expect(queryAtCaret('SELECT 1;\n-- |c\n\n\n\nSELECT 2;')).toBe('SELECT 1;')
      expect(queryAtCaret('SELECT 1;\n\n\n\n-- |c\nSELECT 2;')).toBe('SELECT 2;')
    })

    it('skips bare semicolons when looking for the nearest statement', () => {
      expect(queryAtCaret('SELECT 1;\n;\n;\n|\nSELECT 2;')).toBe('SELECT 2;')
    })

    it('falls back to the text block in a comment-only doc', () => {
      expect(queryAtCaret('-- just |notes\n-- more notes')).toBe('-- just notes\n-- more notes')
    })
  })

  describe('statement kinds', () => {
    it('handles DML statements with tricky string contents', () => {
      const doc = "INSERT INTO t VALUES (1);\nUPDATE t SET x = ';' WHERE| y = 2;\nDELETE FROM t;"
      expect(queryAtCaret(doc)).toBe("UPDATE t SET x = ';' WHERE y = 2;")
    })

    it('does not split on a semicolon inside a quoted identifier', () => {
      expect(queryAtCaret('SELECT "a;b" FROM| t;\nSELECT 2;')).toBe('SELECT "a;b" FROM t;')
    })

    it('does not split on semicolons inside a tagged dollar-quote', () => {
      const doc = 'CREATE FUNCTION g() RETURNS int AS $fn$ SELECT 1;| $fn$ LANGUAGE sql;\nSELECT 2;'
      expect(queryAtCaret(doc)).toBe(
        'CREATE FUNCTION g() RETURNS int AS $fn$ SELECT 1; $fn$ LANGUAGE sql;',
      )
    })
  })

  describe('paragraph fallback', () => {
    it('keeps a single terminated statement whole even across blank lines', () => {
      expect(queryAtCaret('SELECT 1,\n\n  |2;')).toBe('SELECT 1,\n\n  2;')
    })

    it('splits a semicolon-less scratch even when a string contains a semicolon', () => {
      const doc = "SELECT 'a;b'\nFROM t\n\nSELECT |2\nFROM x"
      expect(queryAtCaret(doc)).toBe('SELECT 2\nFROM x')
      expect(queryAtCaret("SELECT 'a;b'\nFROM| t\n\nSELECT 2\nFROM x")).toBe("SELECT 'a;b'\nFROM t")
    })

    it('picks the nearer block when the cursor is on a blank line', () => {
      expect(queryAtCaret('SELECT 1\n\n\n\n|\nSELECT 2')).toBe('SELECT 2')
      expect(queryAtCaret('SELECT 1\n|\n\n\n\nSELECT 2')).toBe('SELECT 1')
    })

    it('treats whitespace-only lines as block separators', () => {
      expect(queryAtCaret('SELECT 1\nFROM a\n \t \nSELECT |2\nFROM b')).toBe('SELECT 2\nFROM b')
    })
  })

  describe('selection handling', () => {
    it('falls back to the nearest block when the selection is only whitespace', () => {
      const doc = 'SELECT 1;  \n  SELECT 2;'
      const state = stateAt(doc, 11, { anchor: 9 })
      expect(queryToRun(state)).toBe('SELECT 1;')
    })

    it('returns a partial statement when that is what is selected', () => {
      const doc = 'SELECT 1, 2 FROM t;'
      const state = stateAt(doc, 11, { anchor: 0 })
      expect(queryToRun(state)).toBe('SELECT 1, 2')
    })
  })
})
