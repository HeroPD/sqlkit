import { describe, expect, it } from 'vitest'
import {
  batchStatements,
  connectionProfile,
  databaseObject,
  databaseObjectKind,
  exportFormat,
  historyItems,
  nonNegativeInteger,
  queryPayload,
  querySort,
  tableReference,
  workspaceConfig,
} from './ipc-validation'

const profile = () => ({
  id: 'p1', name: 'db', engine: 'postgresql', host: 'localhost', port: '5432', username: 'u', password: '',
  database: 'app', file: '', folder: 'db',
})

describe('IPC validation', () => {
  it('accepts and copies a valid profile/config', () => {
    expect(connectionProfile(profile())).toMatchObject({ id: 'p1', engine: 'postgresql' })
    expect(workspaceConfig({ version: 1, connections: [profile()] }).connections).toHaveLength(1)
  })

  it('rejects invalid engines, malformed configs, and oversized collections', () => {
    expect(() => connectionProfile({ ...profile(), engine: 'oracle' })).toThrow(/engine/i)
    expect(() => workspaceConfig({ version: 1, connections: {} })).toThrow(/connections/i)
    expect(() => queryPayload('select 1', Array.from({ length: 10_001 }), null, null, 'q1')).toThrow(/params/i)
    expect(() => queryPayload('select 1', [], null, 'x'.repeat(10_001), 'q1')).toThrow(/filter/i)
    expect(() => batchStatements(Array.from({ length: 1_001 }, () => ({ sql: 'select 1', params: [] })))).toThrow(/Batch/i)
  })

  it('bounds paging values and validates expected affected rows', () => {
    expect(nonNegativeInteger(200, 'limit', 200)).toBe(200)
    expect(() => nonNegativeInteger(201, 'limit', 200)).toThrow()
    expect(batchStatements([{ sql: 'update t set a=?', params: [1], expectedRows: 1 }])[0]?.expectedRows).toBe(1)
    expect(() => batchStatements([{ sql: 'x', params: [], expectedRows: -1 }])).toThrow(/expectedRows/i)
  })

  it('validates metadata references instead of trusting renderer object shapes', () => {
    expect(tableReference({ schema: 'public', name: 'users', kind: 'table' })).toEqual({ schema: 'public', name: 'users', kind: 'table' })
    expect(databaseObject({ schema: null, name: 'status', detail: 'enum' })).toEqual({ schema: null, name: 'status', detail: 'enum' })
    expect(databaseObjectKind('function')).toBe('function')
    expect(() => tableReference({ schema: null, name: 'users', kind: 'procedure' })).toThrow(/kind/i)
    expect(() => databaseObject({ schema: [], name: 'x', detail: '' })).toThrow(/schema/i)
    expect(() => databaseObjectKind('procedure')).toThrow(/kind/i)
  })
})

describe('exportFormat', () => {
  it('accepts the supported formats', () => {
    expect(exportFormat('csv')).toBe('csv')
    expect(exportFormat('tsv')).toBe('tsv')
    expect(exportFormat('json')).toBe('json')
  })

  it('rejects anything else', () => {
    expect(() => exportFormat('xml')).toThrow()
    expect(() => exportFormat('')).toThrow()
    expect(() => exportFormat(undefined)).toThrow()
  })
})

describe('querySort', () => {
  it('treats null and undefined as no sort', () => {
    expect(querySort(null)).toBeNull()
    expect(querySort(undefined)).toBeNull()
  })

  it('parses a valid sort by column index', () => {
    expect(querySort({ columnIndex: 0, direction: 'asc' })).toEqual({ columnIndex: 0, direction: 'asc' })
    expect(querySort({ columnIndex: 3, direction: 'desc' })).toEqual({ columnIndex: 3, direction: 'desc' })
  })

  it('rejects an invalid direction or column index', () => {
    expect(() => querySort({ columnIndex: 0, direction: 'up' })).toThrow()
    expect(() => querySort({ columnIndex: -1, direction: 'asc' })).toThrow()
    expect(() => querySort({ columnIndex: 'x', direction: 'asc' })).toThrow()
    expect(() => querySort('name')).toThrow()
  })
})

describe('historyItems', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'h1',
    contextKey: 'p1',
    sql: 'select 1',
    success: true,
    durationMs: 4,
    rowCount: 1,
    error: '',
    createdAt: '2026-07-19T00:00:00Z',
    ...over,
  })

  it('accepts well-formed entries and truncates oversized text instead of rejecting', () => {
    const [item] = historyItems([entry({ sql: 'x'.repeat(20_000), error: 'e'.repeat(5_000) })])
    expect(item?.sql).toHaveLength(10_000)
    expect(item?.error).toHaveLength(2_000)
    expect(item?.rowCount).toBe(1)
  })

  it('rejects malformed shapes', () => {
    expect(() => historyItems('nope')).toThrow()
    expect(() => historyItems([entry({ success: 'yes' })])).toThrow()
    expect(() => historyItems([entry({ durationMs: 'slow' })])).toThrow()
    expect(() => historyItems([entry({ rowCount: 'many' })])).toThrow()
    expect(() => historyItems([null])).toThrow()
  })

  it('caps the number of stored entries', () => {
    const flood = Array.from({ length: 6_000 }, (_, index) => entry({ id: `h${index}` }))
    expect(historyItems(flood)).toHaveLength(5_000)
  })
})
