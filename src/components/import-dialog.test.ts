// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ColumnRef, TableRef } from '../electron'
import { isSqlNull } from '../sql-write'
import type { ImportColumn, ImportConfirmDetail } from './import-dialog'
import './import-dialog'

const table: TableRef = { schema: 'public', name: 'users', kind: 'table' }
const columns: ColumnRef[] = [
  { schema: 'public', table: 'users', name: 'id', dataType: 'integer', nullable: false, primaryKey: true, foreignKey: false },
  { schema: 'public', table: 'users', name: 'name', dataType: 'text', nullable: true, primaryKey: false, foreignKey: false },
  { schema: 'public', table: 'users', name: 'created_at', dataType: 'timestamp', nullable: false, primaryKey: false, foreignKey: false },
]
const importColumns: ImportColumn[] = columns.map((column) => ({ column, generated: false, identity: null }))

type Internals = {
  _source: string
  _mapping: Array<number | null>
  _emptyAsNull: boolean
  _parseAndMap(): void
  _confirm(): Promise<void>
}

const mount = async () => {
  const dialog = document.createElement('import-dialog')
  dialog.table = table
  dialog.columns = importColumns
  document.body.append(dialog)
  await dialog.updateComplete
  return dialog
}

describe('import-dialog', () => {
  it('maps matching headers and omits table columns absent from the CSV', async () => {
    const dialog = await mount()
    const inner = dialog as never as Internals
    inner._source = 'NAME,id\nAda,1'
    inner._parseAndMap()

    expect(inner._mapping).toEqual([1, 0, null])
    dialog.remove()
  })

  it('passes mapped rows to the importer and can turn empty fields into NULL', async () => {
    const dialog = await mount()
    const inner = dialog as never as Internals
    const run = vi.fn((_detail: ImportConfirmDetail) => Promise.resolve(null))
    const done = vi.fn()
    dialog.run = run
    dialog.addEventListener('dialog-done', done)
    inner._source = 'id,name\n1,'
    inner._parseAndMap()
    inner._emptyAsNull = true

    await inner._confirm()

    const detail = run.mock.calls[0]?.[0]
    expect(detail?.columns.map((column) => column.name)).toEqual(['id', 'name'])
    expect(detail?.rows[0]?.[0]).toBe('1')
    expect(isSqlNull(detail?.rows[0]?.[1])).toBe(true)
    expect(done).toHaveBeenCalledOnce()
    dialog.remove()
  })

  it('skips identities by default and locks server-generated columns', async () => {
    const dialog = document.createElement('import-dialog')
    dialog.table = table
    const sequenceColumn: ColumnRef = { ...columns[0]!, name: 'sequence_id' }
    dialog.columns = [
      { column: columns[0]!, generated: false, identity: 'always' },
      { column: columns[1]!, generated: false, identity: null },
      { column: columns[2]!, generated: true, identity: null },
      { column: sequenceColumn, generated: false, identity: 'default' },
    ]
    document.body.append(dialog)
    await dialog.updateComplete
    const inner = dialog as never as Internals
    inner._source = 'id,name,created_at,sequence_id\n1,Ada,2026-01-01,10'
    inner._parseAndMap()
    await dialog.updateComplete

    expect(inner._mapping).toEqual([null, 1, null, null])
    const selects = dialog.shadowRoot!.querySelectorAll<HTMLSelectElement>('.mapping select')
    expect(selects[0]?.disabled).toBe(true)
    expect(selects[1]?.disabled).toBe(false)
    expect(selects[2]?.disabled).toBe(true)
    expect(selects[3]?.disabled).toBe(false)
    dialog.remove()
  })
})
