import type { DatabaseSync } from 'node:sqlite'
import { exportQuery, inspectTable, listColumns, listTables, openDatabase, queryDatabase, runBatch, runDdl, serverVersion } from './sqlite-engine'
import type { SqliteRequest, SqliteRequestType, SqliteResponse, SqliteResultByRequest } from './sqlite-protocol'
import { t } from '../../src/i18n'

// Electron utilityProcess entry: owns one synchronous SQLite handle and answers
// requests over parentPort. Running here (not the main process) means a heavy
// query or write blocks only this worker; the UI stays live, and cancel/quit
// kill the process, which closes the file and releases its locks cleanly.

type ParentPort = {
  on(event: 'message', listener: (event: { data: SqliteRequest }) => void): void
  postMessage(message: SqliteResponse): void
}

// parentPort is injected onto the child process by Electron at runtime; it
// isn't in the Node process typings, so reach it through a narrow cast.
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort

let db: DatabaseSync | null = null

const requireDb = (): DatabaseSync => {
  if (!db) throw new Error(t('connection.notConnected'))
  return db
}

const handle = (request: SqliteRequest): SqliteResultByRequest[SqliteRequestType] => {
  switch (request.type) {
    case 'open':
      db?.close()
      // Clear first: if openDatabase throws, a later request sees "Not connected"
      // rather than reusing the just-closed handle.
      db = null
      db = openDatabase(request.file, request.readOnly)
      return serverVersion(db)
    case 'query':
      return queryDatabase(requireDb(), request.sql, request.params)
    case 'runBatch':
      return runBatch(requireDb(), request.statements)
    case 'runDdl':
      return runDdl(requireDb(), request.statements)
    case 'exportQuery':
      return exportQuery(requireDb(), request.sql, request.params, request.filePath, request.format, request.sqlTarget)
    case 'listTables':
      return listTables(requireDb())
    case 'listColumns':
      return listColumns(requireDb())
    case 'inspectTable':
      return inspectTable(requireDb(), request.table)
  }
}

parentPort.on('message', ({ data }) => {
  try {
    parentPort.postMessage({ id: data.id, ok: true, value: handle(data) })
  } catch (error) {
    parentPort.postMessage({ id: data.id, ok: false, error: (error as Error).message })
  }
})
