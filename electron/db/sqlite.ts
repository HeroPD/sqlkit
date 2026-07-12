import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConnectionProfile } from '../../src/electron'
import type { Driver } from './driver'
import type { SqliteParam } from './sqlite-engine'
import type { SqliteRequest, SqliteRequestBody, SqliteResponse, SqliteResultByRequest } from './sqlite-protocol'
import { prepareSqlRun } from './sql-script'

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

// A worker that never answers `open` (failed spawn that didn't even emit exit)
// must not hang connect forever.
const OPEN_TIMEOUT_MS = 15_000

export function createSqliteDriver(profile: ConnectionProfile, spawn: SqliteSpawner = defaultSpawn): Driver {
  let channel: SqliteChannel | null = null
  let file = ''
  let nextId = 1
  // The worker is synchronous, so exactly one request is in flight (activeId);
  // the rest wait in `queue`. Explicit serialization is what lets cancel()
  // target one execution without disturbing unrelated queued work.
  type Pending = {
    message: SqliteRequestBody
    executionId?: string
    timeoutMs?: number
    timer: ReturnType<typeof setTimeout> | null
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }
  const pending = new Map<number, Pending>()
  const queue: number[] = []
  let activeId: number | null = null

  const removeFromQueue = (id: number) => {
    const index = queue.indexOf(id)
    if (index >= 0) queue.splice(index, 1)
  }

  const rejectEntry = (id: number, message: string) => {
    const entry = pending.get(id)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    pending.delete(id)
    removeFromQueue(id)
    if (activeId === id) activeId = null
    entry.reject(new Error(message))
  }

  const rejectAll = (message: string) => {
    for (const id of [...pending.keys()]) rejectEntry(id, message)
    queue.length = 0
    activeId = null
  }

  const pump = () => {
    if (!channel || activeId !== null) return
    let id = queue.shift()
    while (id !== undefined && !pending.has(id)) id = queue.shift()
    if (id === undefined) return
    const entry = pending.get(id)!
    const target = channel
    activeId = id
    if (entry.timeoutMs) {
      entry.timer = setTimeout(() => {
        // A worker that never answered is wedged: drop it so the next call respawns.
        if (activeId !== id || channel !== target) return
        channel = null
        target.kill()
        rejectEntry(id, 'SQLite engine timed out')
        rejectAll('SQLite engine stopped after a timeout')
      }, entry.timeoutMs)
    }
    target.post({ id, ...entry.message })
  }

  const spawnChannel = () => {
    const opened = spawn()
    opened.onMessage((message) => {
      if (channel !== opened || activeId !== message.id) return
      const entry = pending.get(message.id)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      pending.delete(message.id)
      activeId = null
      if (message.ok) entry.resolve(message.value)
      else entry.reject(new Error(message.error))
      pump()
    })
    opened.onExit(() => {
      // Ignore the exit of a channel we've already replaced (reconnect/cancel).
      if (channel !== opened) return
      channel = null
      rejectAll('SQLite engine stopped unexpectedly')
    })
    channel = opened
  }

  const request = <B extends SqliteRequestBody>(
    message: B,
    timeoutMs?: number,
    executionId?: string,
    priority = false,
  ): Promise<SqliteResultByRequest[B['type']]> => {
    if (!channel) return Promise.reject(new Error('Not connected'))
    const id = nextId++
    return new Promise<SqliteResultByRequest[B['type']]>((resolve, reject) => {
      pending.set(id, {
        message,
        executionId,
        timeoutMs,
        timer: null,
        resolve: (value) => resolve(value as SqliteResultByRequest[B['type']]),
        reject,
      })
      // `open` must run before queued work replayed onto a fresh worker.
      if (priority) queue.unshift(id)
      else queue.push(id)
      pump()
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
    return request({ type: 'open', file: dbFile }, OPEN_TIMEOUT_MS, undefined, true)
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

    async query(sql, params = [], _childDb = null, sort = null, executionId) {
      const plan = prepareSqlRun({ engine: 'sqlite', sql, params, sort })
      return request({ type: 'query', sql: plan.batches[0]!, params: plan.params as SqliteParam[] }, undefined, executionId)
    },

    async runBatch(statements, _childDb = null) {
      return request({
        type: 'runBatch',
        statements: statements as { sql: string; params: SqliteParam[]; expectedRows?: number }[],
      })
    },

    async runDdl(statements, _childDb = null) {
      return request({ type: 'runDdl', statements })
    },

    async exportQuery({ sql, params, sort, filePath, format }) {
      const plan = prepareSqlRun({ engine: 'sqlite', sql, params, sort })
      return request({ type: 'exportQuery', sql: plan.batches[0]!, params: plan.params as SqliteParam[], filePath, format })
    },

    async listTables() {
      return request({ type: 'listTables' })
    },

    async listColumns() {
      return request({ type: 'listColumns' })
    },

    async inspectTable(table) {
      return request({ type: 'inspectTable', table })
    },

    async cancel(executionId) {
      const targets = [...pending.entries()].filter(([, entry]) =>
        entry.executionId !== undefined && (executionId === undefined || entry.executionId === executionId),
      )
      const running = targets.length
      if (!running) return { running: 0, cancelled: 0 }

      const cancellingActive = activeId !== null && targets.some(([id]) => id === activeId)
      for (const [id] of targets) rejectEntry(id, 'Query cancelled.')

      // A queued query can be removed without disturbing the running request.
      // Cancelling the active synchronous query requires replacing the worker
      // (node:sqlite has no interrupt); unrelated queued work stays pending and
      // resumes once the replacement worker has opened the database.
      if (cancellingActive) {
        const closing = channel
        channel = null
        closing?.kill()
        if (file) await open(file)
      } else {
        pump()
      }
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
