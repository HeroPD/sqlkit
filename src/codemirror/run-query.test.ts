import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { MSSQL, MySQL, PostgreSQL, SQLite, sql, type SQLDialect } from '@codemirror/lang-sql'
import { queryToRun } from './run-query'
import { SQL_DIALECTS, type SqlDialectName } from './dialects'

// The app's postgres dialect: dollar-quoted bodies parse as plain SQL, so the
// dollar-quote tests below exercise the span-based splitting, not the parser.
const stateAt = (
  doc: string,
  cursor: number,
  options: { anchor?: number; dialect?: SQLDialect } = {},
) =>
  EditorState.create({
    doc,
    selection: { anchor: options.anchor ?? cursor, head: cursor },
    extensions: sql({ dialect: options.dialect ?? SQL_DIALECTS.postgres.dialect }),
  })

/** Cursor placed where `|` appears in the doc. */
const queryAtCaret = (docWithCaret: string, dialect?: SQLDialect, name?: SqlDialectName) => {
  const cursor = docWithCaret.indexOf('|')
  const doc = docWithCaret.replace('|', '')
  return queryToRun(stateAt(doc, cursor, { dialect }), name)?.sql ?? ''
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
    expect(queryToRun(state)?.sql).toBe('SELECT 2;')
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

    it('keeps dollar-quote splitting when the dialect tokenizes them as strings', () => {
      const doc = 'CREATE FUNCTION g() RETURNS int AS $fn$ SELECT 1;| $fn$ LANGUAGE sql;\nSELECT 2;'
      expect(queryAtCaret(doc, PostgreSQL)).toBe(
        'CREATE FUNCTION g() RETURNS int AS $fn$ SELECT 1; $fn$ LANGUAGE sql;',
      )
    })

    it('runs the statement after a function whole, not merged into it', () => {
      const doc = 'CREATE FUNCTION g() RETURNS int AS $fn$ SELECT 1; $fn$ LANGUAGE sql;\nSELECT |2;'
      expect(queryAtCaret(doc)).toBe('SELECT 2;')
    })

    it('keeps a BEGIN ATOMIC routine body whole', () => {
      // The SQL-standard body holds `;`-terminated statements but is one
      // CREATE. The parser splits on `;` alone, so the caret inside the body
      // used to run a truncated function the server could only reject.
      const doc =
        'CREATE FUNCTION f() RETURNS int LANGUAGE SQL\nBEGIN ATOMIC\n  DELETE FROM t;\n  SELECT 1;\nEND;\nSELECT 2;'
      const fn = doc.slice(0, doc.indexOf('\nSELECT 2;'))
      expect(queryAtCaret(doc.replace('  DELETE', '  DELETE|'), SQL_DIALECTS.postgres.dialect, 'postgres')).toBe(fn)
      expect(queryAtCaret(doc.replace('SELECT 2', 'SELECT |2'), SQL_DIALECTS.postgres.dialect, 'postgres')).toBe('SELECT 2;')
    })

    it('does not split inside an unterminated dollar-quote being typed', () => {
      const doc = 'DO $$\nBEGIN\n  PERFORM 1;|\nEND'
      expect(queryAtCaret(doc)).toBe('DO $$\nBEGIN\n  PERFORM 1;\nEND')
    })
  })

  describe('blank-line separation', () => {
    it('runs an unterminated query alone when the parser merged it into the next statement', () => {
      // The examples.sql bug: `SELECT ... LIMIT 200` has no `;`, so the
      // parser sees it and the WITH query as ONE statement - the blank line
      // must still separate them.
      const doc =
        'SELECT * FROM postings LIMIT 200\n\nWITH f AS (\n  SELECT id FROM t\n)\nSELECT count(*) FROM f;\n\nalter table t add column x int\n\nselect 2;'

      expect(queryAtCaret(doc.replace('LIMIT 200', 'LIMIT| 200'))).toBe(
        'SELECT * FROM postings LIMIT 200',
      )
      expect(queryAtCaret(doc.replace('WITH f', 'WITH| f'))).toBe(
        'WITH f AS (\n  SELECT id FROM t\n)\nSELECT count(*) FROM f;',
      )
      expect(queryAtCaret(doc.replace('alter table', 'alter| table'))).toBe(
        'alter table t add column x int',
      )
    })

    it('splits at a top-level blank line even inside a terminated statement', () => {
      expect(queryAtCaret('SELECT 1,\n\n  |2;')).toBe('2;')
    })

    it('keeps a statement whole when the blank line is inside parentheses', () => {
      const doc = 'WITH f AS (\n  SELECT 1\n\n)\nSELECT * |FROM f;\nSELECT 2;'
      expect(queryAtCaret(doc)).toBe('WITH f AS (\n  SELECT 1\n\n)\nSELECT * FROM f;')
    })

    it('keeps a DO block whole when blank lines are inside the dollar-quoted body', () => {
      const doc = 'DO $$\nBEGIN\n\n  PERFORM| 1;\n\nEND $$;\n\nSELECT 2;'
      expect(queryAtCaret(doc)).toBe('DO $$\nBEGIN\n\n  PERFORM 1;\n\nEND $$;')
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

  describe('statement-keyword separation', () => {
    // Reported: `SELECT ... LIMIT 200` with no `;` directly above DDL. The
    // parser merges them into one statement (it splits on `;` alone) and there
    // is no blank line to clip on, so both used to run — and the server
    // answered `syntax error at or near "ALTER"`.
    const scratch =
      'SELECT * FROM "public"."pos_terminals" LIMIT 200\nALTER TABLE segments ADD COLUMN IF NOT EXISTS custom_type TEXT;\nALTER TABLE segments ADD COLUMN c2 TEXT;'

    it('ends an unterminated query at the next statement keyword', () => {
      expect(queryAtCaret(scratch.replace('LIMIT 200', 'LIMIT| 200'))).toBe(
        'SELECT * FROM "public"."pos_terminals" LIMIT 200',
      )
    })

    it('runs the statement the cursor is on, not the one it was merged with', () => {
      expect(queryAtCaret(scratch.replace('ALTER TABLE segments ADD COLUMN IF', 'ALTER| TABLE segments ADD COLUMN IF'))).toBe(
        'ALTER TABLE segments ADD COLUMN IF NOT EXISTS custom_type TEXT;',
      )
    })

    it('leaves indented continuation clauses attached', () => {
      // MERGE's UPDATE/INSERT branches are clauses, not statements: they are
      // indented, and only a flush-left keyword opens a query.
      const doc =
        'MERGE INTO t USING s ON s.id = t.id\nWHEN MATCHED THEN\n  UPDATE SET x = 1\nWHEN NOT MATCHED THEN\n  INSERT VALUES (s.id);'
      expect(queryAtCaret(doc.replace('MERGE INTO', 'MERGE| INTO'))).toBe(doc)
    })

    it('keeps a multi-line ALTER TABLE with its ALTER COLUMN action', () => {
      const doc = 'ALTER TABLE t\nALTER COLUMN c TYPE int;'
      expect(queryAtCaret(doc.replace('ALTER TABLE', 'ALTER TABLE|'))).toBe(doc)
      expect(queryAtCaret(doc.replace('ALTER COLUMN', 'ALTER| COLUMN'))).toBe(doc)
    })

    it('still ends an unterminated query at an explicit transaction start', () => {
      expect(queryAtCaret('SELECT 1|\nBEGIN TRANSACTION;')).toBe('SELECT 1')
      expect(queryAtCaret('SELECT 1|\nBEGIN;')).toBe('SELECT 1')
    })

    it('keeps a T-SQL block and its body attached', () => {
      const doc = 'IF @x = 1\nBEGIN\nUPDATE t SET y = 2\nEND'
      expect(queryAtCaret(doc.replace('IF', 'IF|'), MSSQL)).toBe(doc)
      expect(queryAtCaret(doc.replace('UPDATE', 'UPDATE|'), MSSQL)).toBe(doc)
    })

    it('keeps a bare statement under T-SQL control flow attached', () => {
      const doc = 'IF @x = 1\nUPDATE t SET y = 2;'
      expect(queryAtCaret(doc.replace('IF', 'IF|'), MSSQL)).toBe(doc)
    })

    it('keeps flush-left MERGE branches attached', () => {
      const doc = 'MERGE INTO t USING s ON s.id = t.id\nWHEN MATCHED THEN\nUPDATE SET x = 1;'
      expect(queryAtCaret(doc.replace('MERGE', 'MERGE|'))).toBe(doc)
    })

    it('ignores a statement keyword inside parentheses', () => {
      const doc = 'WITH d AS (\nDELETE FROM t RETURNING *\n)\nSELECT * |FROM d;'
      expect(queryAtCaret(doc)).toBe(doc.replace('|', ''))
    })

    it('ignores a statement keyword inside a string or a dollar-quoted body', () => {
      const inString = "SELECT 'x\nALTER TABLE t'| AS a;"
      expect(queryAtCaret(inString)).toBe("SELECT 'x\nALTER TABLE t' AS a;")

      const body = 'CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\nUPDATE t SET x = 1;|\nEND\n$$ LANGUAGE plpgsql;'
      expect(queryAtCaret(body)).toBe(body.replace('|', ''))
    })
  })

  describe('consecutive queries without semicolons', () => {
    // Reported: the formatter puts every keyword flush left, so a query typed
    // under a finished one has nothing separating them - no `;`, no blank
    // line, and SELECT opens no statement on its own. Both used to run as one
    // and the server answered `syntax error at or near "SELECT"`.
    const pg = SQL_DIALECTS.postgres.dialect
    const scratch = [
      'BEGIN',
      'SELECT',
      '  *',
      'FROM',
      '  "public"."pos_transactions"',
      'LIMIT',
      '  200',
      'SELECT',
      '  *',
      'FROM',
      '  pos_transactions pt',
      'WHERE',
      '  pt.id = 1',
    ].join('\n')

    it('runs only the query the cursor is in', () => {
      expect(queryAtCaret(scratch.replace('LIMIT', 'LIMIT|'), pg, 'postgres')).toBe(
        'SELECT\n  *\nFROM\n  "public"."pos_transactions"\nLIMIT\n  200',
      )
      expect(queryAtCaret(scratch.replace('WHERE', 'WHERE|'), pg, 'postgres')).toBe(
        'SELECT\n  *\nFROM\n  pos_transactions pt\nWHERE\n  pt.id = 1',
      )
    })

    it('reports the second query starting where it does, for error lines', () => {
      const state = stateAt(scratch, scratch.indexOf('WHERE'), { dialect: pg })
      expect(queryToRun(state, 'postgres')?.from).toBe(scratch.indexOf('SELECT', 10))
    })

    it('keeps the halves of a set operation together', () => {
      const doc = 'SELECT 1\nUNION ALL\nSELECT |2'
      expect(queryAtCaret(doc)).toBe(doc.replace('|', ''))
      expect(queryAtCaret('SELECT 1\nEXCEPT\nSELECT |2')).toBe('SELECT 1\nEXCEPT\nSELECT 2')
      expect(queryAtCaret('SELECT 1\nUNION ALL -- both\nSELECT |2')).toBe(
        'SELECT 1\nUNION ALL -- both\nSELECT 2',
      )
    })

    it('keeps an INSERT and the SELECT it inserts together', () => {
      const doc = 'INSERT INTO archive\n  (id, name)\nSELECT\n  id, name\nFROM |t'
      expect(queryAtCaret(doc)).toBe(doc.replace('|', ''))
    })

    it('starts a new query at a SELECT under a finished INSERT', () => {
      expect(queryAtCaret('INSERT INTO t VALUES (1)\nSELECT |2')).toBe('SELECT 2')
    })

    it('keeps a SELECT that is another statement body attached', () => {
      const view = 'CREATE VIEW v AS\nSELECT *\nFROM |t'
      expect(queryAtCaret(view)).toBe(view.replace('|', ''))
      const explain = 'EXPLAIN\nSELECT *\nFROM |t'
      expect(queryAtCaret(explain)).toBe(explain.replace('|', ''))
    })

    it('splits the query typed under a CTE from the CTE itself', () => {
      const doc = 'WITH r AS (\n  SELECT 1\n)\nSELECT * FROM r\nSELECT 2'
      expect(queryAtCaret(doc.replace('SELECT * FROM r', 'SELECT * |FROM r'))).toBe(
        'WITH r AS (\n  SELECT 1\n)\nSELECT * FROM r',
      )
      expect(queryAtCaret(doc.replace('SELECT 2', 'SELECT |2'))).toBe('SELECT 2')
    })

    it('ends a query at a flush-left WITH', () => {
      const doc = 'SELECT 1\nWITH r AS (\n  SELECT 2\n)\nSELECT * FROM r'
      expect(queryAtCaret(doc.replace('SELECT 1', 'SELECT |1'))).toBe('SELECT 1')
      expect(queryAtCaret(doc.replace('FROM r', 'FROM |r'))).toBe(
        'WITH r AS (\n  SELECT 2\n)\nSELECT * FROM r',
      )
    })

    it('runs a query merged into the statement above it alone', () => {
      expect(queryAtCaret('ALTER TABLE t ADD COLUMN x int\nSELECT |1\nFROM t')).toBe(
        'SELECT 1\nFROM t',
      )
    })

    it('keeps a query attached to the comment above it', () => {
      expect(queryAtCaret('SELECT 1\n\n-- recent orders\nSELECT |2\nFROM t')).toBe(
        '-- recent orders\nSELECT 2\nFROM t',
      )
    })
  })

  describe('openers judged against the statement above', () => {
    const pg = SQL_DIALECTS.postgres.dialect

    // Reported: DROP was left out of the opener list because `ALTER TABLE t` /
    // `DROP COLUMN c` gets written across two lines. So an unterminated query
    // above a `DROP INDEX` swallowed it, and the server answered
    // `syntax error at or near "DROP"` — the same shape as the SELECT leak.
    it('ends a query at a DROP that opens its own statement', () => {
      const doc = 'SELECT *\nFROM t\nLIMIT\n  1\nDROP INDEX IF EXISTS idx;'
      expect(queryAtCaret(doc.replace('FROM t', 'FROM |t'), pg, 'postgres')).toBe('SELECT *\nFROM t\nLIMIT\n  1')
      expect(queryAtCaret(doc.replace('DROP INDEX', 'DROP |INDEX'), pg, 'postgres')).toBe('DROP INDEX IF EXISTS idx;')
    })

    it('keeps every action of a multi-line ALTER attached', () => {
      const doc = 'ALTER TABLE t\nADD COLUMN a int,\nDROP COLUMN b,\nALTER COLUMN c TYPE text;'
      expect(queryAtCaret(doc.replace('DROP COLUMN', 'DROP| COLUMN'), pg, 'postgres')).toBe(doc)
    })

    it('keeps UPDATE with its SET, and still ends a query at a bare SET', () => {
      expect(queryAtCaret('UPDATE t\nSET x = |1', pg, 'postgres')).toBe('UPDATE t\nSET x = 1')
      expect(queryAtCaret('SELECT 1\nFROM |t\nSET search_path = public', pg, 'postgres')).toBe('SELECT 1\nFROM t')
    })

    it('keeps an INSERT with its rows and ends it once they are named', () => {
      expect(queryAtCaret('INSERT INTO t\nVALUES |(1)', pg, 'postgres')).toBe('INSERT INTO t\nVALUES (1)')
      expect(queryAtCaret('INSERT INTO t VALUES (1)\nTRUNCATE |u', pg, 'postgres')).toBe('TRUNCATE u')
    })

    it('restarts at a second body under a statement that already took one', () => {
      const doc = 'INSERT INTO t\nSELECT 1\nSELECT 2'
      expect(queryAtCaret(doc.replace('SELECT 1', 'SELECT |1'), pg, 'postgres')).toBe('INSERT INTO t\nSELECT 1')
      expect(queryAtCaret(doc.replace('SELECT 2', 'SELECT |2'), pg, 'postgres')).toBe('SELECT 2')
    })

    it('keeps EXPLAIN with the statement it plans', () => {
      const doc = 'EXPLAIN\nSELECT *\nFROM t\nDROP TABLE u;'
      expect(queryAtCaret(doc.replace('FROM t', 'FROM |t'), pg, 'postgres')).toBe('EXPLAIN\nSELECT *\nFROM t')
      expect(queryAtCaret(doc.replace('DROP TABLE', 'DROP |TABLE'), pg, 'postgres')).toBe('DROP TABLE u;')
    })
  })

  // Swallowing the next statement has been reported three times — once for
  // ALTER, once for SELECT, once for DROP — so the whole vocabulary is swept
  // here rather than one keyword per bug report.
  describe('nothing swallows the statement below it', () => {
    const DIALECTS: Record<SqlDialectName, SQLDialect> = {
      postgres: SQL_DIALECTS.postgres.dialect,
      mysql: MySQL,
      mssql: MSSQL,
      sqlite: SQLite,
    }
    const unterminated = 'SELECT *\nFROM t\nLIMIT\n  200'

    const followers: Array<[SqlDialectName, string]> = [
      ['postgres', 'DROP INDEX IF EXISTS i;'],
      ['postgres', 'DROP TABLE t;'],
      ['postgres', 'CREATE TABLE x (id int);'],
      ['postgres', 'CREATE INDEX i ON t (c);'],
      ['postgres', 'ALTER TABLE t ADD COLUMN c int;'],
      ['postgres', 'INSERT INTO t VALUES (1);'],
      ['postgres', 'UPDATE t SET x = 1;'],
      ['postgres', 'DELETE FROM t;'],
      ['postgres', 'TRUNCATE t;'],
      ['postgres', 'SELECT 2;'],
      ['postgres', 'WITH a AS (SELECT 1) SELECT * FROM a;'],
      ['postgres', 'VALUES (1);'],
      ['postgres', 'TABLE t;'],
      ['postgres', 'SET search_path = public;'],
      ['postgres', 'RESET ALL;'],
      ['postgres', 'GRANT SELECT ON t TO r;'],
      ['postgres', 'REVOKE SELECT ON t FROM r;'],
      ['postgres', "COMMENT ON TABLE t IS 'x';"],
      ['postgres', 'VACUUM t;'],
      ['postgres', 'ANALYZE t;'],
      ['postgres', 'REINDEX TABLE t;'],
      ['postgres', 'REFRESH MATERIALIZED VIEW v;'],
      ['postgres', 'CLUSTER t USING i;'],
      ['postgres', "COPY t FROM '/tmp/f';"],
      ['postgres', 'EXPLAIN SELECT 1;'],
      ['postgres', 'BEGIN;'],
      ['postgres', 'COMMIT;'],
      ['postgres', 'ROLLBACK;'],
      ['postgres', 'SAVEPOINT s;'],
      ['postgres', 'RELEASE SAVEPOINT s;'],
      ['postgres', 'LOCK TABLE t;'],
      ['postgres', 'LISTEN c;'],
      ['postgres', 'NOTIFY c;'],
      ['postgres', 'DISCARD ALL;'],
      ['postgres', 'CHECKPOINT;'],
      ['postgres', 'PREPARE p AS SELECT 1;'],
      ['postgres', 'DEALLOCATE p;'],
      ['postgres', 'EXECUTE p;'],
      ['postgres', 'CALL p();'],
      ['postgres', 'SHOW search_path;'],
      ['postgres', "LOAD 'lib';"],
      ['postgres', 'MERGE INTO t USING s ON s.id = t.id WHEN MATCHED THEN UPDATE SET x = 1;'],
      ['mysql', 'RENAME TABLE a TO b;'],
      ['mysql', 'FLUSH TABLES;'],
      ['mysql', 'OPTIMIZE TABLE t;'],
      ['mysql', 'REPAIR TABLE t;'],
      ['mysql', 'KILL 1;'],
      ['mysql', 'HANDLER t OPEN;'],
      ['mysql', 'USE db;'],
      ['mysql', 'REPLACE INTO t VALUES (1);'],
      ['mssql', "PRINT 'x';"],
      ['mssql', 'IF @x = 1 SELECT 2;'],
      ['mssql', "RAISERROR('x', 16, 1);"],
      ['mssql', 'EXEC sp_who;'],
      ['mssql', 'DECLARE @x int;'],
      ['mssql', "BACKUP DATABASE d TO DISK = 'x';"],
      ['mssql', "WAITFOR DELAY '00:01';"],
      ['mssql', 'TRUNCATE TABLE t;'],
      ['sqlite', 'PRAGMA table_info(t);'],
      ['sqlite', "ATTACH DATABASE 'f' AS d;"],
      ['sqlite', 'DETACH d;'],
      ['sqlite', 'VACUUM;'],
    ]

    it.each(followers)('%s runs the query above %s alone', (name, follower) => {
      const doc = `${unterminated}\n${follower}`
      expect(queryAtCaret(doc.replace('FROM t', 'FROM |t'), DIALECTS[name], name)).toBe(unterminated)
      expect(queryAtCaret(doc.replace(follower, `${follower.slice(0, 2)}|${follower.slice(2)}`), DIALECTS[name], name)).toBe(follower)
    })

    // THROW is absent on purpose: @codemirror/lang-sql does not carry it in the
    // T-SQL keyword table, so the parser reads it as an identifier and it
    // cannot be told apart from a column of that name.
  })

  describe('continuations stay with the statement they belong to', () => {
    const wholeFrom = (doc: string, dialect: SQLDialect, name: SqlDialectName) => {
      const seen = new Set<string>()
      let offset = 0
      for (const line of doc.split('\n')) {
        seen.add(queryToRun(stateAt(doc, offset + Math.min(1, line.length), { dialect }), name)?.sql ?? '')
        offset += line.length + 1
      }
      return [...seen]
    }

    const whole: Array<[SqlDialectName, string]> = [
      ['postgres', 'ALTER TABLE t\nDROP COLUMN c;'],
      ['postgres', 'ALTER TABLE t\nADD COLUMN c int;'],
      ['postgres', 'ALTER TABLE t\nALTER COLUMN c TYPE int;'],
      ['postgres', 'ALTER TABLE t\nRENAME TO u;'],
      ['postgres', 'ALTER TABLE t\nRENAME COLUMN a TO b;'],
      ['postgres', 'ALTER TABLE t\nSET SCHEMA s;'],
      ['postgres', 'ALTER TABLE t\nOWNER TO r;'],
      ['postgres', 'ALTER TABLE t\nENABLE ROW LEVEL SECURITY;'],
      ['postgres', 'DROP INDEX\nIF EXISTS i;'],
      ['postgres', 'DROP TABLE\nIF EXISTS t;'],
      ['postgres', 'CREATE TABLE\nIF NOT EXISTS t (id int);'],
      ['postgres', 'CREATE VIEW v AS\nSELECT 1;'],
      ['postgres', 'CREATE TABLE t AS\nSELECT 1;'],
      ['postgres', 'INSERT INTO t\nSELECT 1;'],
      ['postgres', 'INSERT INTO t\nVALUES (1);'],
      ['postgres', 'INSERT INTO t (a)\nVALUES (1);'],
      ['postgres', 'INSERT INTO t\nDEFAULT VALUES;'],
      ['postgres', 'UPDATE t\nSET x = 1;'],
      ['postgres', 'UPDATE t\nSET x = 1\nWHERE y = 2;'],
      ['postgres', 'DELETE FROM t\nWHERE x = 1;'],
      ['postgres', 'DELETE FROM t\nUSING u;'],
      ['postgres', 'WITH a AS (SELECT 1)\nSELECT * FROM a;'],
      ['postgres', 'WITH a AS (SELECT 1)\nDELETE FROM t;'],
      ['postgres', 'SELECT 1\nUNION ALL\nSELECT 2'],
      ['postgres', 'SELECT 1\nEXCEPT\nSELECT 2'],
      ['postgres', 'SELECT 1\nINTERSECT\nSELECT 2'],
      ['postgres', 'EXPLAIN\nSELECT 1;'],
      ['postgres', 'EXPLAIN ANALYZE\nSELECT 1;'],
      ['postgres', 'PREPARE p AS\nSELECT 1;'],
      ['postgres', 'GRANT SELECT\nON t\nTO r;'],
      ['postgres', 'TRUNCATE\nTABLE t;'],
      // DESC and FETCH are clause spellings first, so they open nothing.
      ['postgres', 'SELECT a\nFROM t\nORDER BY a\nDESC'],
      ['postgres', 'SELECT a\nFROM t\nOFFSET 10 ROWS\nFETCH NEXT 5 ROWS ONLY'],
      ['postgres', 'MERGE INTO t USING s ON s.id = t.id\nWHEN MATCHED THEN\nUPDATE SET x = 1\nWHEN NOT MATCHED THEN\nINSERT VALUES (1);'],
      ['mssql', "IF @x = 1\nPRINT 'a';"],
      ['mssql', 'BEGIN\nSELECT 1\nEND'],
      ['mssql', 'IF @x = 1\nBEGIN\nUPDATE t SET y = 2\nEND'],
      ['mssql', 'WHILE @x < 2\nBEGIN\nSET @x = @x + 1\nEND'],
    ]

    it.each(whole)('%s keeps %j whole from every line in it', (name, doc) => {
      const dialect = name === 'mssql' ? MSSQL : name === 'mysql' ? MySQL : name === 'sqlite' ? SQLite : SQL_DIALECTS.postgres.dialect
      expect(wholeFrom(doc, dialect, name)).toEqual([doc])
    })
  })

  describe('lone BEGIN transactions', () => {
    // Reported: manual transactions are typed as a lone BEGIN with the query
    // on the next line and no semicolons. Both used to run as one statement -
    // the server answered `syntax error at or near "SELECT"`.
    const pg = SQL_DIALECTS.postgres.dialect
    const scratch = 'BEGIN\nSELECT * FROM "public"."pos_transactions"\n  LIMIT 200'

    it('runs a lone BEGIN alone instead of the query merged below it', () => {
      expect(queryAtCaret(scratch.replace('BEGIN', 'BEGIN|'), pg, 'postgres')).toBe('BEGIN')
    })

    it('runs the query below a lone BEGIN without it', () => {
      expect(queryAtCaret(scratch.replace('SELECT', 'SELECT|'), pg, 'postgres')).toBe(
        'SELECT * FROM "public"."pos_transactions"\n  LIMIT 200',
      )
      expect(queryAtCaret(scratch.replace('LIMIT', 'LIMIT|'), pg, 'postgres')).toBe(
        'SELECT * FROM "public"."pos_transactions"\n  LIMIT 200',
      )
    })

    it('recognizes a lone BEGIN after a terminated statement', () => {
      expect(queryAtCaret('COMMIT;\nBEGIN|\nUPDATE t SET x = 1;', pg, 'postgres')).toBe('BEGIN')
      expect(queryAtCaret('COMMIT;\nBEGIN\nUPDATE| t SET x = 1;', pg, 'postgres')).toBe('UPDATE t SET x = 1;')
    })

    it('keeps a T-SQL block and its body attached under the mssql dialect', () => {
      const doc = 'BEGIN\nUPDATE t SET y = 2\nEND'
      expect(queryAtCaret(doc.replace('BEGIN', 'BEGIN|'), MSSQL, 'mssql')).toBe(doc)
      expect(queryAtCaret(doc.replace('UPDATE', 'UPDATE|'), MSSQL, 'mssql')).toBe(doc)
    })

    it('keeps a SQLite trigger body under its unterminated header', () => {
      const doc = 'CREATE TRIGGER trg AFTER INSERT ON t\nBEGIN\n  UPDATE t SET x = 1;|\nEND;'
      expect(queryAtCaret(doc, SQLite, 'sqlite')).toBe(
        'CREATE TRIGGER trg AFTER INSERT ON t\nBEGIN\n  UPDATE t SET x = 1;',
      )
    })

    it('leaves a lone BEGIN inside a dollar-quoted body attached', () => {
      const doc =
        'CREATE FUNCTION f() RETURNS void AS $$\nDECLARE x int;\nBEGIN|\n  UPDATE t SET x = 1;\nEND\n$$ LANGUAGE plpgsql;'
      expect(queryAtCaret(doc, pg, 'postgres')).toBe(doc.replace('|', ''))
    })

    it('keeps merging without a dialect', () => {
      expect(queryAtCaret(scratch.replace('BEGIN', 'BEGIN|'))).toBe(scratch)
    })
  })

  describe('selection handling', () => {
    it('falls back to the nearest block when the selection is only whitespace', () => {
      const doc = 'SELECT 1;  \n  SELECT 2;'
      const state = stateAt(doc, 11, { anchor: 9 })
      expect(queryToRun(state)?.sql).toBe('SELECT 1;')
    })

    it('returns a partial statement when that is what is selected', () => {
      const doc = 'SELECT 1, 2 FROM t;'
      const state = stateAt(doc, 11, { anchor: 0 })
      expect(queryToRun(state)?.sql).toBe('SELECT 1, 2')
    })

    it('snaps a selection ending mid-identifier out to whole lines', () => {
      const doc = "SELECT * FROM accounts a\nJOIN companies c ON a.company_id = c.id\nwhere a.name = 'x'"
      const state = stateAt(doc, doc.indexOf('a.company_id') + 4, { anchor: 0 })
      expect(queryToRun(state)?.sql).toBe('SELECT * FROM accounts a\nJOIN companies c ON a.company_id = c.id')
    })

    it('snaps a selection starting mid-keyword out to whole lines', () => {
      const doc = 'SELECT 1;\nSELECT 2 FROM t;'
      const state = stateAt(doc, doc.length, { anchor: doc.indexOf('ELECT 2') })
      expect(queryToRun(state)?.sql).toBe('SELECT 2 FROM t;')
    })

    it('snaps a selection cutting a string literal out to whole lines', () => {
      const doc = "SELECT 'abc' FROM t;"
      const state = stateAt(doc, doc.indexOf('bc'), { anchor: 0 })
      expect(queryToRun(state)?.sql).toBe("SELECT 'abc' FROM t;")
    })
  })
})
