import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResult, TableRef } from './electron'
import { buildEditSpecs, rowKeysForDelete, singleTableEditContext, type ResultEditInput } from './result-editing'

const accounts: TableRef = { schema: 'public', name: 'accounts', kind: 'table' }
const companies: TableRef = { schema: 'public', name: 'companies', kind: 'table' }

const column = (table: TableRef, name: string, primaryKey = false): ColumnRef => ({
  schema: table.schema,
  table: table.name,
  name,
  dataType: primaryKey ? 'integer' : 'text',
  nullable: !primaryKey,
  primaryKey,
  foreignKey: false,
})

const source = (table: TableRef, name: string) => ({ schema: table.schema, table: table.name, column: name })

const columns = [
  column(accounts, 'id', true),
  column(accounts, 'name'),
  column(accounts, 'company_id'),
  column(companies, 'id', true),
  column(companies, 'name'),
]

function input(result: QueryResult, sql: string, tabTable?: TableRef, runTable?: TableRef): ResultEditInput {
  return {
    tab: {
      id: 'tab-1',
      kind: 'sql',
      name: 'Query.sql',
      path: null,
      content: sql,
      savedContent: sql,
      ...(tabTable ? { table: tabTable } : {}),
    },
    profileId: 'profile-1',
    engine: 'postgresql',
    run: { phase: 'done', result, sql, ...(runTable ? { table: runTable } : {}) },
    tables: [accounts, companies],
    columns,
  }
}

describe('result edit context', () => {
  it('uses source metadata to edit the selected table in a joined result', () => {
    const sql = 'select * from public.accounts a join public.companies c on c.id = a.company_id'
    const result: QueryResult = {
      columns: ['id', 'company_id', 'id', 'name', 'upper'],
      columnSources: [
        source(accounts, 'id'),
        source(accounts, 'company_id'),
        source(companies, 'id'),
        source(companies, 'name'),
        { schema: null, table: null, column: null },
      ],
      rows: [[1, 10, 10, 'Acme', 'ACME']],
      rowCount: 1,
      durationMs: 1,
    }
    const editInput = input(result, sql, accounts)

    expect(singleTableEditContext(editInput)).toBeNull()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 3 }], 'Globex')).toMatchObject({
      ok: true,
      value: { table: companies, edits: [{ column: 'name', pks: [{ name: 'id', value: 10 }] }] },
    })
    expect(buildEditSpecs(editInput, [{ row: 0, col: 4 }], 'Globex')).toMatchObject({ ok: false })
  })

  it('deletes by primary key alone, including from partial projections', () => {
    const complete = input({
      columns: ['id', 'name', 'company_id'],
      columnSources: [source(accounts, 'id'), source(accounts, 'name'), source(accounts, 'company_id')],
      rows: [[1, 'Ada', null]],
      rowCount: 1,
      durationMs: 1,
    }, 'select id, name, company_id from public.accounts')
    const ctx = singleTableEditContext(complete)
    expect(ctx).not.toBeNull()
    const keys = rowKeysForDelete(ctx!, [0])
    expect(keys.ok).toBe(true)
    if (keys.ok) {
      expect(keys.value[0]?.map(({ name, value }) => ({ name, value }))).toEqual([{ name: 'id', value: 1 }])
    }

    const partial = input({
      columns: ['id', 'name'],
      columnSources: [source(accounts, 'id'), source(accounts, 'name')],
      rows: [[1, 'Ada']],
      rowCount: 1,
      durationMs: 1,
    }, 'select id, name from public.accounts')
    expect(rowKeysForDelete(singleTableEditContext(partial)!, [0])).toMatchObject({
      ok: true,
      value: [[{ name: 'id', value: 1 }]],
    })
  })

  it('does not fall back to result column names when metadata says the PK is absent', () => {
    const sql = 'select name as id from public.accounts'
    const result: QueryResult = {
      columns: ['id'],
      columnSources: [source(accounts, 'name')],
      rows: [['Ada']],
      rowCount: 1,
      durationMs: 1,
    }
    const editInput = input(result, sql)

    expect(singleTableEditContext(editInput)).toBeNull()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 0 }], '7')).toMatchObject({ ok: false })
  })

  it('keeps name fallback for single-table results without driver metadata', () => {
    const sql = 'select id, name from public.accounts'
    const result: QueryResult = {
      columns: ['id', 'name'],
      rows: [[1, 'Ada']],
      rowCount: 1,
      durationMs: 1,
    }
    const editInput = input(result, sql)

    expect(singleTableEditContext(editInput)).not.toBeNull()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 1 }], 'Grace')).toMatchObject({
      ok: true,
      value: { table: accounts, edits: [{ column: 'name', pks: [{ name: 'id', value: 1 }] }] },
    })
  })

  it('maps single-table star results, including SQL Server TOP, without source metadata', () => {
    const sql = 'select top (200) * from [public].[accounts]'
    const result: QueryResult = {
      columns: ['id', 'name', 'company_id'],
      rows: [[1, 'Ada', null]],
      rowCount: 1,
      durationMs: 1,
    }
    const editInput = input(result, sql, accounts)
    const ctx = singleTableEditContext(editInput)
    expect(ctx).not.toBeNull()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 1 }], 'Grace')).toMatchObject({ ok: true })
    expect(rowKeysForDelete(ctx!, [0])).toMatchObject({ ok: true })
  })

  it('does not infer editability from source-less computed columns aliased as table columns', () => {
    const sql = "select 1 as id, 'x' as name from public.accounts"
    const result: QueryResult = {
      columns: ['id', 'name'],
      rows: [[1, 'x']],
      rowCount: 1,
      durationMs: 1,
    }
    const editInput = input(result, sql)

    expect(singleTableEditContext(editInput)).toBeNull()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 1 }], 'Grace')).toMatchObject({ ok: false })
  })
})

// A result reached by following a foreign key shows another table's rows in the
// tab it was opened from, so the tab's table is a stale write target. The run
// carries the real source and must win.
describe('result edit context: the run outranks the tab', () => {
  const companiesResult: QueryResult = {
    columns: ['id', 'name'],
    columnSources: [source(companies, 'id'), source(companies, 'name')],
    rows: [[7, 'Initech']],
    rowCount: 1,
    durationMs: 1,
  }

  it('edits the run table, not the tab it was opened from', () => {
    const editInput = input(companiesResult, 'select * from public.companies where id = 7', accounts, companies)

    expect(singleTableEditContext(editInput)?.table).toEqual(companies)
    expect(buildEditSpecs(editInput, [{ row: 0, col: 1 }], 'Initrode')).toMatchObject({
      ok: true,
      value: { table: companies },
    })
  })

  it('still falls back to the tab table when the run names none', () => {
    const editInput = input(companiesResult, 'select * from public.companies where id = 7', companies)

    expect(singleTableEditContext(editInput)?.table).toEqual(companies)
  })

  // Without column sources there is nothing to contradict a stale tab table, so
  // a wrong run table would silently retarget writes. Engines that report no
  // sources must therefore still be protected by the run carrying its own table.
  it('uses the run table even when the engine reports no column sources', () => {
    const sourceless: QueryResult = { columns: ['id', 'name'], rows: [[7, 'Initech']], rowCount: 1, durationMs: 1 }
    const editInput = input(sourceless, 'select * from public.companies where id = 7', accounts, companies)

    expect(singleTableEditContext(editInput)?.table).toEqual(companies)
    expect(buildEditSpecs(editInput, [{ row: 0, col: 1 }], 'Initrode')).toMatchObject({
      ok: true,
      value: { table: companies },
    })
  })
})
