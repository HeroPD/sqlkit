import { expect, test } from 'vitest'
import type { Engine } from './electron'
import { maskSql, type SqlModeFlags } from './sql-mask'

// `⟦…⟧` marks the spans the mask must blank; the fixture is otherwise the SQL
// verbatim, so a case reads as SQL rather than as column counting. Comparing
// whole strings keeps the offsets honest — a masked space and a real one are
// the same character, and only the position tells them apart.
function expectMask(marked: string, engine?: Engine, mode?: SqlModeFlags) {
  const sql = marked.replaceAll('⟦', '').replaceAll('⟧', '')
  const expected = marked.replace(/⟦([^⟧]*)⟧/g, (_, span: string) => span.replace(/[^\n\r]/g, ' '))
  expect(maskSql(sql, engine, mode), sql).toBe(expected)
}

const ENGINES: (Engine | undefined)[] = [undefined, 'postgresql', 'mysql', 'sqlserver', 'sqlite']

// Every consumer indexes the original SQL by offsets read off the mask —
// statement splitting, edit-context inference, the destructive preflight — so
// this is the invariant the whole module exists to keep.
test('the mask only ever blanks, and never moves a character', () => {
  const script = "SELECT 'a\nb', /* c\nd */ `e`, [f], $$g\nh$$ -- i\r\nFROM t; # j\n"
  const newlines = (text: string) => [...text.matchAll(/\r|\n/g)].map((match) => match.index)
  for (const engine of ENGINES) {
    const masked = maskSql(script, engine)
    expect(masked, `${engine}`).toHaveLength(script.length)
    expect(newlines(masked), `${engine}`).toEqual(newlines(script))
    for (let i = 0; i < script.length; i += 1) {
      const kept = masked[i] === script[i]
      expect(kept || masked[i] === ' ', `${engine} at ${i}`).toBe(true)
    }
  }
})

test('a line comment ends at the newline, which survives it', () => {
  expectMask('SELECT 1 ⟦-- drop⟧\nFROM t')
  // an unterminated one runs to the end rather than off it
  expectMask('SELECT 1 ⟦-- drop⟧')
})

test('MySQL needs whitespace after --, so 3--2 stays subtraction', () => {
  expectMask('SELECT 3--2 FROM t', 'mysql')
  expectMask('SELECT 3⟦-- 2 FROM t⟧', 'mysql')
  // `--` at the very end has nothing after it to require
  expectMask('SELECT 3⟦--⟧', 'mysql')
  // every other engine reads `--` as a comment regardless
  expectMask('SELECT 3⟦--2 FROM t⟧', 'postgresql')
})

test('# opens a comment in MySQL alone', () => {
  expectMask('SELECT 1 ⟦# note⟧\nFROM t', 'mysql')
  expectMask('SELECT 1 # note\nFROM t', 'postgresql')
})

test('block comments nest in Postgres and T-SQL, and not in MySQL or SQLite', () => {
  expectMask('SELECT ⟦/* a /* b */ c */⟧ 1', 'postgresql')
  expectMask('SELECT ⟦/* a /* b */ c */⟧ 1', 'sqlserver')
  // the inner terminator closes the only comment there is
  expectMask('SELECT ⟦/* a /* b */⟧ c */ 1', 'sqlite')
  // MySQL blanks the stray terminator too: outside a comment `*/` can only be
  // the tail of a version comment, so there is no valid token to keep
  expectMask('SELECT ⟦/* a /* b */⟧ c ⟦*/⟧ 1', 'mysql')
})

// The guards downstream must see the statement a version comment carries: MySQL
// executes it, so masking the body would hide a DROP from the destructive check.
test('a MySQL version comment masks its wrapper and leaves the SQL inside', () => {
  expectMask('SELECT ⟦/*!40101 ⟧id ⟦*/⟧ FROM t', 'mysql')
  expectMask('⟦/*!⟧DROP TABLE t⟦*/⟧', 'mysql')
  // to any other engine the same text is an ordinary, inert comment
  expectMask('SELECT ⟦/*!40101 id */⟧ FROM t', 'postgresql')
})

test('a quoted string is masked whole, doubling and all', () => {
  expectMask("SELECT ⟦'it''s'⟧ FROM t")
  expectMask("SELECT ⟦'a'⟧ , ⟦'b'⟧")
  // an unterminated string takes the rest of the input, not more
  expectMask("SELECT ⟦'abc⟧")
})

test('backslash escapes follow the engine and its sql_mode', () => {
  // MySQL: the escaped quote does not close the string, so the comma is inside it
  expectMask("SELECT ⟦'a\\' , b'⟧", 'mysql')
  // NO_BACKSLASH_ESCAPES makes the same text two strings with SQL between them
  expectMask("SELECT ⟦'a\\'⟧ , b⟦'⟧", 'mysql', { noBackslashEscapes: true })
  // Postgres escapes only inside an E'' string
  expectMask("SELECT E⟦'a\\'b'⟧ FROM t", 'postgresql')
  expectMask("SELECT ⟦'a\\'⟧b⟦' FROM t⟧", 'postgresql')
  // and `E` must be its own token, not the tail of an identifier
  expectMask("SELECT te⟦'a\\'⟧b⟦' FROM t⟧", 'postgresql')
})

test('double quotes are strings or identifiers by engine, and ANSI_QUOTES switches MySQL', () => {
  // MySQL treats "" as a string, so a backslash escapes the closing quote
  expectMask('SELECT ⟦"a\\" FROM t⟧', 'mysql')
  // under ANSI_QUOTES it is an identifier, which escapes only by doubling
  expectMask('SELECT ⟦"a\\"⟧ FROM t', 'mysql', { ansiQuotes: true })
  // Postgres identifiers never take backslash escapes either
  expectMask('SELECT ⟦"a\\"⟧ FROM t', 'postgresql')
})

test('backticks quote identifiers where the engine accepts them', () => {
  expectMask('SELECT ⟦`my col`⟧ FROM t', 'mysql')
  expectMask('SELECT ⟦`my col`⟧ FROM t', 'sqlite')
  expectMask('SELECT ⟦`my col`⟧ FROM t')
  // to Postgres a backtick is not a quote, so nothing here is masked
  expectMask('SELECT `my col` FROM t', 'postgresql')
})

test('brackets quote identifiers in T-SQL and SQLite, not in Postgres', () => {
  expectMask('SELECT ⟦[my col]⟧ FROM t', 'sqlserver')
  expectMask('SELECT ⟦[my col]⟧ FROM t', 'sqlite')
  // a doubled ] escapes, so the identifier runs past it
  expectMask('SELECT ⟦[a]]b]⟧ FROM t', 'sqlserver')
  // Postgres subscripts an array with the same characters
  expectMask('SELECT tags[1] FROM t', 'postgresql')
  expectMask('SELECT ⟦[abc⟧', 'sqlserver')
})

test('dollar quoting is masked for Postgres, and placeholders are not', () => {
  expectMask("SELECT ⟦$$a'b$$⟧ FROM t", 'postgresql')
  expectMask('SELECT ⟦$fn$ x $fn$⟧ FROM t', 'postgresql')
  // $1/$2 open no tag, so a parameterised statement is left intact
  expectMask('SELECT * FROM t WHERE a = $1 AND b = $2', 'postgresql')
  // an unterminated tag stops at the end of the input
  expectMask('SELECT ⟦$$abc⟧', 'postgresql')
  // MySQL has no dollar quoting, so the apostrophe inside opens a string instead
  expectMask("SELECT $$a⟦'b$$ FROM t⟧", 'mysql')
})

// sql-destructive and sql-readonly decide what a script does by reading the
// mask. Text that only looks like a comment must not hide the rest of a
// statement from them, and a real comment must not be readable as one.
test('nothing can smuggle a statement past the mask, in either direction', () => {
  expectMask("DELETE FROM t WHERE note = ⟦'-- keep'⟧ AND id = 1", 'postgresql')
  expectMask("UPDATE t SET note = ⟦'/* keep */'⟧ WHERE id = 1", 'postgresql')
  // and the reverse: a comment holding SQL is gone by the time a guard reads it
  expectMask('SELECT 1; ⟦-- DELETE FROM t⟧\nSELECT 2', 'postgresql')
  expectMask('SELECT ⟦/* DROP TABLE t */⟧ 1', 'postgresql')
  // a semicolon inside a string cannot split the script early
  expectMask("SELECT ⟦'a;b'⟧ FROM t", 'postgresql')
})

test('an unterminated construct ends at the input, whatever the engine', () => {
  for (const engine of ENGINES) {
    for (const sql of ["SELECT 'a", 'SELECT /* a', 'SELECT `a', 'SELECT [a', 'SELECT $$a', 'SELECT "a']) {
      expect(maskSql(sql, engine), `${engine}: ${sql}`).toHaveLength(sql.length)
    }
  }
})

test('an empty or comment-only script masks without complaint', () => {
  expect(maskSql('')).toBe('')
  expectMask('⟦-- just a note⟧')
  expectMask('⟦/* just a note */⟧')
})
