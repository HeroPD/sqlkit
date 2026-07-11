import type { BatchResult, ColumnRef, DdlResult, QueryResult, TableInspection, TableRef } from '../../src/electron'
import type { SqliteParam } from './sqlite-engine'

export type SqliteRequestBodyByType = {
  open: { type: 'open'; file: string }
  query: { type: 'query'; sql: string; params: SqliteParam[] }
  runBatch: { type: 'runBatch'; statements: { sql: string; params: SqliteParam[]; expectedRows?: number }[] }
  runDdl: { type: 'runDdl'; statements: string[] }
  listTables: { type: 'listTables' }
  listColumns: { type: 'listColumns' }
  inspectTable: { type: 'inspectTable'; table: TableRef }
}

export type SqliteResultByRequest = {
  open: string
  query: QueryResult
  runBatch: BatchResult
  runDdl: DdlResult
  listTables: TableRef[]
  listColumns: ColumnRef[]
  inspectTable: TableInspection
}

export type SqliteRequestType = keyof SqliteRequestBodyByType
export type SqliteRequestBody<K extends SqliteRequestType = SqliteRequestType> = SqliteRequestBodyByType[K]
export type SqliteRequest<K extends SqliteRequestType = SqliteRequestType> = SqliteRequestBody<K> & { id: number }
export type SqliteResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }
