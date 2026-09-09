import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResult, TableRef } from './electron'
import { buildEditSpecs, buildInsertRows, buildPendingUpdate, resultKeyColumns, rowKeysForDelete, singleTableEditContext, type ResultEditInput } from './result-editing'

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

  it('reports the key columns a row can be recognised by after a re-run', () => {
    const projected = input({
      columns: ['name', 'id'],
      columnSources: [source(accounts, 'name'), source(accounts, 'id')],
      rows: [['Ada', 1]],
      rowCount: 1,
      durationMs: 1,
    }, 'select name, id from public.accounts')
    expect(resultKeyColumns(projected)).toEqual([1])

    // No key in the projection is the same bar a write has to clear, so the
    // panel is told nothing rather than something it could mistake for identity.
    const keyless = input({
      columns: ['name'],
      columnSources: [source(accounts, 'name')],
      rows: [['Ada']],
      rowCount: 1,
      durationMs: 1,
    }, 'select name from public.accounts')
    expect(resultKeyColumns(keyless)).toEqual([])
    expect(singleTableEditContext(keyless)).toBeNull()
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


// A column origin names the table a column came from, not which reference in
// the query produced it. Two references to one table (a self-join, a derived
// table, a CTE) make every origin for it ambiguous, and the first match is not
// the right one: the manager's name below would be written against the
// employee's key. Equal values are the dangerous case — the optimistic guard
// happens to reject the rest — and a delete, which matches on the key alone,
// has no guard at all.
describe('result edit context: ambiguous sources', () => {
  const employees: TableRef = { schema: 'public', name: 'employees', kind: 'table' }
  const employeeColumns = [
    column(employees, 'id', true),
    column(employees, 'name'),
    column(employees, 'manager_id'),
  ]
  const selfJoin = 'select e.id, m.id, m.name from public.employees e join public.employees m on m.id = e.manager_id'

  // Row: employee 1 reports to manager 2; both are called Grace, so an UPDATE
  // keyed on the wrong id would match a row and look like it worked.
  const selfJoinInput = (sql = selfJoin, tabTable?: TableRef): ResultEditInput => ({
    tab: { id: 'tab-1', kind: 'sql', name: 'Query.sql', path: null, content: sql, savedContent: sql, ...(tabTable ? { table: tabTable } : {}) },
    profileId: 'profile-1',
    engine: 'postgresql',
    run: {
      phase: 'done',
      sql,
      result: {
        columns: ['id', 'id', 'name'],
        columnSources: [source(employees, 'id'), source(employees, 'id'), source(employees, 'name')],
        rows: [[1, 2, 'Grace']],
        rowCount: 1,
        durationMs: 1,
      },
    },
    tables: [employees],
    columns: employeeColumns,
  })

  it('refuses to edit a column whose row cannot be identified', () => {
    const editInput = selfJoinInput()
    expect(buildEditSpecs(editInput, [{ row: 0, col: 2 }], 'Grace Hopper')).toMatchObject({
      ok: false,
      issue: { title: 'Cannot edit this result' },
    })
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 2, value: 'Grace Hopper' }])).toMatchObject({ ok: false })
  })

  // The same result opened from the table's own tab reaches the single-table
  // path, which is what turns on row deletes and new rows.
  it('offers no row identity, deletes or inserts for the same result', () => {
    const editInput = selfJoinInput(selfJoin, employees)
    expect(singleTableEditContext(editInput)).toBeNull()
    expect(resultKeyColumns(editInput)).toEqual([])
    expect(buildInsertRows(editInput, [{ after: 0, cells: [null, null, 'Ada'] }])).toMatchObject({
      ok: false,
      issue: { title: 'Cannot edit this result' },
    })
  })

  it('explains a single-source CTE refusal accurately for edits and inserts', () => {
    const editInput = selfJoinInput('with c as (select * from employees) select * from c', employees)
    const issue = { title: 'Cannot edit this result', detail: 'Editing results from CTE queries is not supported yet. Query the base table directly to edit its rows.' }
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 2, value: 'Changed' }])).toMatchObject({ ok: false, issue })
    expect(buildInsertRows(editInput, [{ after: 0, cells: [null, null, 'Ada'] }])).toMatchObject({ ok: false, issue })
  })

  it('keeps base-table cells editable alongside a named window', () => {
    const sql = 'select id, name, row_number() over w from employees window w as (partition by manager_id)'
    const editInput: ResultEditInput = {
      ...selfJoinInput(sql),
      run: { phase: 'done', sql, result: {
        columns: ['id', 'name', 'row_number'],
        columnSources: [source(employees, 'id'), source(employees, 'name'), { schema: null, table: null, column: null }],
        rows: [[2, 'Grace', 1]], rowCount: 1, durationMs: 1,
      } },
    }
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 1, value: 'Changed' }])).toMatchObject({ ok: true })
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 2, value: '2' }])).toMatchObject({ ok: false })
  })

  it('refuses grouped self-joins and CTEs after earlier statements', () => {
    for (const sql of [
      'select e.id, m.id, m.name from (employees e join employees m on m.id=e.manager_id)',
      'select e.id, m.id, m.name from (table employees) e join employees m on m.id=e.manager_id',
      'select 0; with c as (select * from employees) select e.id, m.id, m.name from c e join c m on m.id=e.manager_id',
    ]) {
      const editInput = selfJoinInput(sql, employees)
      expect(buildPendingUpdate(editInput, [{ row: 0, col: 2, value: 'Changed manager' }])).toMatchObject({ ok: false })
      expect(singleTableEditContext(editInput)).toBeNull()
      expect(resultKeyColumns(editInput)).toEqual([])
      expect(buildInsertRows(editInput, [{ after: 0, cells: [null, null, 'Ada'] }])).toMatchObject({ ok: false })
    }
  })

  it('refuses quoted self-joins and a CTE joined to itself', () => {
    for (const sql of [
      'select e.id, m.id, m.name from "employees" e join "employees" m on m.id=e.manager_id',
      'with c as (select * from employees) select e.id, m.id, m.name from c e join c m on m.id=e.manager_id',
    ]) {
      const editInput = selfJoinInput(sql, employees)
      expect(buildPendingUpdate(editInput, [{ row: 0, col: 2, value: 'Changed' }])).toMatchObject({ ok: false })
      expect(singleTableEditContext(editInput)).toBeNull()
      expect(resultKeyColumns(editInput)).toEqual([])
    }
  })

  it('refuses a derived table or CTE over the same table', () => {
    for (const sql of [
      'select e.id, d.id, d.name from public.employees e join (select id, name from public.employees) d on d.id = e.manager_id',
      'with m as (select id, name from public.employees) select e.id, m.id, m.name from public.employees e join m on m.id = e.manager_id',
    ]) {
      expect(buildPendingUpdate(selfJoinInput(sql), [{ row: 0, col: 2, value: 'Grace Hopper' }])).toMatchObject({ ok: false })
    }
  })

  it('edits the final independent result using its column origins', () => {
    const sql = 'select * from employees; select id, name from employees'
    const editInput: ResultEditInput = {
      ...selfJoinInput(sql, employees),
      run: { phase: 'done', sql, result: {
        columns: ['id', 'name'],
        columnSources: [source(employees, 'id'), source(employees, 'name')],
        rows: [[2, 'Grace']], rowCount: 1, durationMs: 1,
      } },
    }
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 1, value: 'Changed' }])).toMatchObject({
      ok: true, value: { edits: [{ column: 'name', pks: [{ name: 'id', value: 2 }] }] },
    })
    // The first SELECT cannot establish provenance for a later computed result.
    const computedSql = 'select id, name from employees; select 1 as id, \'Grace\' as name'
    editInput.run = { phase: 'done', sql: computedSql, result: {
      columns: ['id', 'name'], rows: [[1, 'Grace']], rowCount: 1, durationMs: 1,
    } }
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 1, value: 'Changed' }])).toMatchObject({ ok: false })
    expect(resultKeyColumns(editInput)).toEqual([])
  })

  // The guard must not cost the common shape it resembles: a subquery filter
  // over the same table projects nothing, so the result stays writable.
  it('still edits a result filtered by a subquery over the same table', () => {
    const sql = 'select e.id, e.name from public.employees e where e.id in (select manager_id from public.employees)'
    const editInput: ResultEditInput = {
      ...selfJoinInput(sql),
      run: {
        phase: 'done',
        sql,
        result: {
          columns: ['id', 'name'],
          columnSources: [source(employees, 'id'), source(employees, 'name')],
          rows: [[2, 'Grace']],
          rowCount: 1,
          durationMs: 1,
        },
      },
    }
    expect(buildPendingUpdate(editInput, [{ row: 0, col: 1, value: 'Grace Hopper' }])).toMatchObject({
      ok: true,
      value: { table: employees, edits: [{ column: 'name', pks: [{ name: 'id', value: 2 }] }] },
    })
  })
})
