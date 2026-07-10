import { describe, expect, it } from 'vitest'
import {
  batchStatements,
  connectionProfile,
  databaseObject,
  databaseObjectKind,
  nonNegativeInteger,
  queryPayload,
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
    expect(() => queryPayload('select 1', Array.from({ length: 10_001 }), null, 'q1')).toThrow(/params/i)
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
