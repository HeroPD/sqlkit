import type { DatabaseSync } from 'node:sqlite'
import { inspectTable, listColumns, listTables, openDatabase, queryDatabase, runBatch, serverVersion } from './sqlite-engine'
import type { SqliteRequest, SqliteResponse } from './sqlite-protocol'

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
  if (!db) throw new Error('Not connected')
  return db
}

const handle = (request: SqliteRequest): unknown => {
  switch (request.type) {
    case 'open':
      db?.close()
      db = openDatabase(request.file)
      return serverVersion(db)
    case 'query':
      return queryDatabase(requireDb(), request.sql, request.params)
    case 'runBatch':
      return runBatch(requireDb(), request.statements)
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
