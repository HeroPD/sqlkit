import { describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { sql } from '@codemirror/lang-sql'
import * as mask from '../sql-mask'
import { queryToRun } from './run-query'
import { SQL_DIALECTS } from './dialects'

vi.mock('../sql-mask', async (importOriginal) => {
  const original = await importOriginal<typeof import('../sql-mask')>()
  return { ...original, maskSql: vi.fn(original.maskSql), maskSqlRegions: vi.fn(original.maskSqlRegions) }
})

// A dump-shaped document: dollar-quoted function bodies force both full-text scans.
const body = Array.from({ length: 200 }, (_, index) =>
  `create function f${index}() returns int as $$ begin return ${index}; end $$ language plpgsql;\nselect ${index};\n`,
).join('\n')

const stateAt = (doc: string, cursor: number) =>
  EditorState.create({ doc, selection: { anchor: cursor }, extensions: sql({ dialect: SQL_DIALECTS.postgres.dialect }) })

describe('queryToRun full-text scan cache', () => {
  it('scans a document once however many lookups it serves, and again only after an edit', () => {
    const scans = () => vi.mocked(mask.maskSqlRegions).mock.calls.length + vi.mocked(mask.maskSql).mock.calls.length
    const state = stateAt(body, body.indexOf('select 150'))
    const before = scans()
    // Completion's two sources and the run gutter all ask on the same document.
    for (let index = 0; index < 5; index += 1) expect(queryToRun(state, 'postgres')?.sql).toBe('select 150;')
    const perDoc = scans() - before
    expect(perDoc).toBeGreaterThan(0)
    expect(perDoc).toBeLessThanOrEqual(2)

    // A different caret on the same Text reuses the scans too.
    queryToRun(state.update({ selection: { anchor: body.indexOf('select 20;') } }).state, 'postgres')
    expect(scans() - before).toBe(perDoc)

    const edited = state.update({ changes: { from: 0, insert: '-- note\n' } }).state
    expect(queryToRun(edited, 'postgres')?.sql).toBe('select 150;')
    expect(scans() - before).toBe(perDoc * 2)
  })
})
