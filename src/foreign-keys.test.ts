import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResult } from './electron'
import { foreignKeyTargets } from './foreign-keys'

const column = (table: string, name: string, references?: ColumnRef['references'], schema: string | null = 'public'): ColumnRef => ({
  schema,
  table,
  name,
  dataType: 'integer',
  nullable: true,
  primaryKey: false,
  foreignKey: !!references,
  ...(references ? { references } : {}),
})

const source = (table: string | null, name: string | null, schema: string | null = 'public') =>
  ({ schema, table, column: name })

const result = (columns: string[], sources?: ReturnType<typeof source>[]): QueryResult => ({
  columns,
  rows: [],
  rowCount: 0,
  durationMs: 1,
  ...(sources ? { columnSources: sources } : {}),
})

const authorRef = { schema: 'public', table: 'authors', column: 'id', constraint: 'books_author_fk' }

describe('foreignKeyTargets', () => {
  it('maps a followable column by its result index', () => {
    const targets = foreignKeyTargets(
      result(['title', 'author_id'], [source('books', 'title'), source('books', 'author_id')]),
      [column('books', 'title'), column('books', 'author_id', authorRef)],
    )
    expect([...targets.keys()]).toEqual([1])
    expect(targets.get(1)).toEqual(authorRef)
  })

  it('offers nothing without column sources, since no column can be traced to a table', () => {
    const targets = foreignKeyTargets(result(['author_id']), [column('books', 'author_id', authorRef)])
    expect(targets.size).toBe(0)
  })

  it('ignores expression columns, which belong to no table', () => {
    const targets = foreignKeyTargets(
      result(['computed', 'author_id'], [source(null, null), source('books', 'author_id')]),
      [column('books', 'author_id', authorRef)],
    )
    expect([...targets.keys()]).toEqual([1])
  })

  // Following one column of a composite key filters on half the key, matching
  // rows that merely share that half. Offering nothing is the honest option.
  it('refuses a composite key rather than following half of it', () => {
    const composite = (name: string, refColumn: string) =>
      column('child', name, { schema: 'public', table: 'parent', column: refColumn, constraint: 'child_comp' })
    const targets = foreignKeyTargets(
      result(['pa', 'pb'], [source('child', 'pa'), source('child', 'pb')]),
      [composite('pa', 'a'), composite('pb', 'b')],
    )
    expect(targets.size).toBe(0)
  })

  it('still follows a single-column key on a table that also has a composite one', () => {
    const columns = [
      column('child', 'pa', { schema: 'public', table: 'parent', column: 'a', constraint: 'child_comp' }),
      column('child', 'pb', { schema: 'public', table: 'parent', column: 'b', constraint: 'child_comp' }),
      column('child', 'author_id', authorRef),
    ]
    const targets = foreignKeyTargets(
      result(['pa', 'pb', 'author_id'], [source('child', 'pa'), source('child', 'pb'), source('child', 'author_id')]),
      columns,
    )
    expect([...targets.keys()]).toEqual([2])
  })

  it('maps a joined result to whichever table each column came from', () => {
    const targets = foreignKeyTargets(
      result(['title', 'author_id', 'name'], [source('books', 'title'), source('books', 'author_id'), source('authors', 'name')]),
      [column('books', 'author_id', authorRef), column('authors', 'name')],
    )
    expect([...targets.keys()]).toEqual([1])
  })

  it('matches a flat-namespace engine, where both sides carry a null schema', () => {
    const flatRef = { schema: null, table: 'authors', column: 'id', constraint: 'fk_0' }
    const targets = foreignKeyTargets(
      result(['author_id'], [source('books', 'author_id', null)]),
      [column('books', 'author_id', flatRef, null)],
    )
    expect(targets.get(0)).toEqual(flatRef)
  })

  // Identifiers that differ only by case are matched exactly first, so a folded
  // lookup can never bind a same-named sibling in preference to the real column.
  it('falls back to a case-insensitive match when nothing matches exactly', () => {
    const targets = foreignKeyTargets(
      result(['AUTHOR_ID'], [source('BOOKS', 'AUTHOR_ID')]),
      [column('books', 'author_id', authorRef)],
    )
    expect(targets.get(0)).toEqual(authorRef)
  })

  it('prefers the exactly-matching column over a case-folded one', () => {
    const lower = { schema: 'public', table: 'lower_target', column: 'id', constraint: 'c1' }
    const upper = { schema: 'public', table: 'upper_target', column: 'id', constraint: 'c2' }
    const targets = foreignKeyTargets(
      result(['ID'], [source('t', 'ID')]),
      [column('t', 'id', lower), column('t', 'ID', upper)],
    )
    expect(targets.get(0)).toEqual(upper)
  })

  it('offers nothing for a column with no foreign key', () => {
    const targets = foreignKeyTargets(result(['title'], [source('books', 'title')]), [column('books', 'title')])
    expect(targets.size).toBe(0)
  })
})
