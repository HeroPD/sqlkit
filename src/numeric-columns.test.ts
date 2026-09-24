import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResultSet } from './electron'
import { numericColumns } from './numeric-columns'

const column = (name: string, dataType: string): ColumnRef =>
  ({ schema: 'public', table: 't', name, dataType, nullable: true, primaryKey: false, foreignKey: false })

const traced = (name: string) => ({ schema: 'public', table: 't', column: name })

const result = (columns: string[], rows: unknown[][], sources?: QueryResultSet['columnSources']): QueryResultSet =>
  ({ columns, rows, rowCount: rows.length, ...(sources ? { columnSources: sources } : {}) })

describe('numericColumns', () => {
  it('goes by the declared type of a column traced to its table', () => {
    const found = numericColumns(
      result(['id', 'zip', 'price', 'ratio', 'name'], [[1, '02134', '9.99', 0.5, 'Ada']],
        [traced('id'), traced('zip'), traced('price'), traced('ratio'), traced('name')]),
      [column('id', 'bigint'), column('zip', 'varchar(10)'), column('price', 'numeric(10,2)'), column('ratio', 'double precision'), column('name', 'text')],
    )
    expect([...found]).toEqual([0, 2, 3])
  })

  it('reads engine spellings: MySQL unsigned ints, SQL Server money, SQLite affinities', () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const found = numericColumns(
      result(names, [], names.map(traced)),
      [column('a', 'int unsigned'), column('b', 'smallmoney'), column('c', 'INTEGER'), column('d', 'REAL'), column('e', 'interval')],
    )
    expect([...found]).toEqual([0, 1, 2, 3])
  })

  it('goes by the values for an expression, lossless numeric strings included', () => {
    const found = numericColumns(
      result(['count', 'sum', 'code', 'label', 'empty'], [['4', 12.5, '007', 'x', null], ['12', null, '9', 'y', null]]),
      [],
    )
    expect([...found]).toEqual([0, 1])
  })
})
