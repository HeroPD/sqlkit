import { describe, expect, it } from 'vitest'
import type { ColumnRef, QueryResult, TableRef } from './electron'
import { buildEditSpecs, singleTableEditContext, type ResultEditInput } from './result-editing'

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

function input(result: QueryResult, sql: string, tabTable?: TableRef): ResultEditInput {
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
    run: { phase: 'done', result, sql },
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
})
