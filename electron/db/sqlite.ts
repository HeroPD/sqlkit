import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BatchResult, ColumnRef, ConnectionProfile, DdlResult, QueryResult, TableInspection, TableRef } from '../../src/electron'
import { dialectFor } from '../../src/dialect'
import type { Driver } from './driver'
import type { SqliteParam } from './sqlite-engine'
import type { SqliteRequest, SqliteResponse } from './sqlite-protocol'

// node:sqlite is synchronous and has no statement interrupt, so a long query
// blocks whatever runs it. We run it in a separate Electron utilityProcess to
// keep the main process responsive; cancel and the open handshake bound the
// wait by killing that process (which closes the file and releases its locks)
// and bringing a fresh one up. createSqliteDriver here is just the proxy: it
// owns request/response correlation and lifecycle, not the SQL itself.

// A channel to one SQLite worker. Abstracted so the proxy's orchestration is
// unit-testable with an in-process fake while production drives a utilityProcess.
export type SqliteChannel = {
  post(message: SqliteRequest): void
  kill(): void
  onMessage(listener: (message: SqliteResponse) => void): void
  onExit(listener: () => void): void
}

export type SqliteSpawner = () => SqliteChannel

// Distributes over the request union so each variant keeps its own fields
// (a plain Omit<SqliteRequest, 'id'> would collapse to the shared `type` only).
type SqliteRequestBody = SqliteRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never

// A worker that never answers `open` (failed spawn that didn't even emit exit)
// must not hang connect forever.
const OPEN_TIMEOUT_MS = 15_000

export function createSqliteDriver(profile: ConnectionProfile, spawn: SqliteSpawner = defaultSpawn): Driver {
  const dialect = dialectFor(profile.engine)
  let channel: SqliteChannel | null = null
  let file = ''
  let nextId = 1
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  const rejectAll = (message: string) => {
    for (const entry of pending.values()) entry.reject(new Error(message))
    pending.clear()
  }

  const spawnChannel = () => {
    const opened = spawn()
    opened.onMessage((message) => {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error))
    })
    opened.onExit(() => {
      // Ignore the exit of a channel we've already replaced (reconnect/cancel).
      if (channel !== opened) return
      channel = null
      rejectAll('SQLite engine stopped unexpectedly')
    })
    channel = opened
  }

  const request = <T>(message: SqliteRequestBody, timeoutMs?: number): Promise<T> => {
    const target = channel
    if (!target) return Promise.reject(new Error('Not connected'))
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            if (!pending.delete(id)) return
            // A worker that never answered is wedged: drop it so the next call respawns.
            if (channel === target) channel = null
            target.kill()
            reject(new Error('SQLite engine timed out'))
          }, timeoutMs)
        : null
      pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          if (timer) clearTimeout(timer)
          reject(error)
        },
      })
      target.post({ id, ...message })
    })
  }

  const teardown = (reason: string) => {
    const closing = channel
    channel = null
    rejectAll(reason)
    closing?.kill()
  }

  const open = (dbFile: string): Promise<string> => {
    spawnChannel()
    return request<string>({ type: 'open', file: dbFile }, OPEN_TIMEOUT_MS)
  }

  return {
    async connect() {
      file = profile.file.trim()
      if (!file) throw new Error('Choose a database file first.')
      // A reconnect replaces the worker (and its database handle) outright.
      if (channel) teardown('Reconnecting')
      return open(file)
    },

    async disconnect() {
      teardown('Disconnected')
      file = ''
    },

    async query(sql, params = [], _childDb = null, sort = null) {
      const finalSql = sort ? dialect.applyOrderBy(sql, sort) : sql
      return request<QueryResult>({ type: 'query', sql: finalSql, params: params as SqliteParam[] })
    },

    async runBatch(statements, _childDb = null) {
      return request<BatchResult>({ type: 'runBatch', statements: statements as { sql: string; params: SqliteParam[] }[] })
    },

    async runDdl(statements, _childDb = null) {
      return request<DdlResult>({ type: 'runDdl', statements })
    },

    async listTables() {
      return request<TableRef[]>({ type: 'listTables' })
    },

    async listColumns() {
      return request<ColumnRef[]>({ type: 'listColumns' })
    },

    async inspectTable(table) {
      return request<TableInspection>({ type: 'inspectTable', table })
    },

    async cancel() {
      const running = pending.size
      if (!running) return { running: 0, cancelled: 0 }
      // No interrupt in node:sqlite: kill the worker (which rolls its connection
      // back cleanly) and bring a fresh one up on the same file so work continues.
      teardown('Query cancelled.')
      if (file) await open(file)
      return { running, cancelled: running }
    },
  }
}

const requireElectron = createRequire(import.meta.url)
const workerPath = () => join(dirname(fileURLToPath(import.meta.url)), 'sqlite.worker.js')

// Production spawner: an Electron utilityProcess running sqlite.worker.js, which
// sits next to this bundle in dist-electron. Electron is required lazily (not
// imported) so this module loads outside Electron — tests inject their own
// in-process spawner instead.
const defaultSpawn: SqliteSpawner = () => {
  const { utilityProcess } = requireElectron('electron') as typeof import('electron')
  const child = utilityProcess.fork(workerPath())
  return {
    post: (message) => child.postMessage(message),
    kill: () => void child.kill(),
    onMessage: (listener) => child.on('message', (message) => listener(message as SqliteResponse)),
    onExit: (listener) => child.on('exit', () => listener()),
  }
}
