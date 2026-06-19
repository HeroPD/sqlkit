import { afterEach, describe, expect, it } from 'vitest'
import type { ConnectionStatus } from '../../src/electron'
import type { ConnectionManager } from './manager'
import { createConnectionManager, testConnection } from './manager'
import { PAGE_SIZE } from './result-sessions'
import { adminPool, profileFromUrl, testDatabaseUrl } from './test-db'

const url = testDatabaseUrl()
const describeDb = url ? describe : describe.skip

const databaseUrl = (base: string, database: string) => {
  const parsed = new URL(base)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

// Drives the connection lifecycle (connect/disconnect/supersede/cancel and the
// buffered-result paging) through the manager against a real Postgres. Skips
// when TEST_DATABASE_URL is unset (see .env.example).
describeDb('connection manager (integration)', () => {
  const dbUrl = url ?? ''
  const managers: ConnectionManager[] = []

  const makeManager = (onBroadcast: (statuses: ConnectionStatus[]) => void = () => {}): ConnectionManager => {
    const manager = createConnectionManager(onBroadcast)
    managers.push(manager)
    return manager
  }

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disconnectAll()))
  })

  it('connects, reports the version, and broadcasts connecting then connected', async () => {
    const broadcasts: ConnectionStatus[][] = []
    const manager = makeManager((statuses) => broadcasts.push(statuses))
    const profile = profileFromUrl(dbUrl)

    const result = await manager.connect(profile)
    expect(result.success).toBe(true)
    if (result.success) expect(result.serverVersion).toMatch(/^PostgreSQL/)

    expect(manager.statuses().find((status) => status.profileId === profile.id)?.phase).toBe('connected')
    const phases = broadcasts.map((batch) => batch.find((status) => status.profileId === profile.id)?.phase)
    expect(phases).toContain('connecting')
    expect(phases).toContain('connected')
  })

  it('returns "Not connected" for a query on an unknown profile', async () => {
    const manager = makeManager()
    expect(await manager.query('ghost', null, 'select 1')).toEqual({ success: false, error: 'Not connected' })
  })

  it('surfaces a SQL error as a failed response rather than throwing', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl)
    await manager.connect(profile)
    const response = await manager.query(profile.id, null, 'select * from sqlkit_no_such_table')
    expect(response.success).toBe(false)
    if (!response.success) expect(response.error).toMatch(/sqlkit_no_such_table|does not exist/i)
  })

  it('buffers a large result and pages it through fetchRows', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl)
    await manager.connect(profile)

    const response = await manager.query(profile.id, null, `select generate_series(1, ${PAGE_SIZE * 2}) as n`)
    expect(response.success).toBe(true)
    if (!response.success) return

    expect(response.result.rows).toHaveLength(PAGE_SIZE)
    expect(response.result.bufferedRowCount).toBe(PAGE_SIZE * 2)
    const sessionId = response.result.sessionId
    expect(sessionId).toBeTruthy()
    if (!sessionId) return

    const page = manager.fetchRows(sessionId, PAGE_SIZE, PAGE_SIZE)
    expect(page.success).toBe(true)
    if (page.success) expect(page.rows).toHaveLength(PAGE_SIZE)

    manager.closeSession(sessionId)
    expect(manager.fetchRows(sessionId, 0, PAGE_SIZE).success).toBe(false)
  })

  it('disconnect removes the status, frees buffers, and rebroadcasts', async () => {
    const broadcasts: ConnectionStatus[][] = []
    const manager = makeManager((statuses) => broadcasts.push(statuses))
    const profile = profileFromUrl(dbUrl)
    await manager.connect(profile)

    const response = await manager.query(profile.id, null, `select generate_series(1, ${PAGE_SIZE * 2}) as n`)
    const sessionId = response.success ? response.result.sessionId : undefined

    await manager.disconnect(profile.id)
    expect(manager.statuses().find((status) => status.profileId === profile.id)).toBeUndefined()
    expect(broadcasts.at(-1)?.some((status) => status.profileId === profile.id)).toBe(false)
    if (sessionId) expect(manager.fetchRows(sessionId, 0, PAGE_SIZE).success).toBe(false)
  })

  it('keeps a single connected entry when the same profile reconnects', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl)
    await manager.connect(profile)
    await manager.connect(profile)
    const entries = manager.statuses().filter((status) => status.profileId === profile.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.phase).toBe('connected')
  })

  it('keeps a single connected entry when two connects race', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl)
    const [first, second] = await Promise.all([manager.connect(profile), manager.connect(profile)])
    expect([first.success, second.success].some(Boolean)).toBe(true)

    const entries = manager.statuses().filter((status) => status.profileId === profile.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.phase).toBe('connected')
    expect((await manager.query(profile.id, null, 'select 1 as a')).success).toBe(true)
  })

  it('retains a failed connection in the error phase', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl, { id: 'bad', password: 'definitely-the-wrong-password' })
    const result = await manager.connect(profile)
    expect(result.success).toBe(false)
    const status = manager.statuses().find((entry) => entry.profileId === 'bad')
    expect(status?.phase).toBe('error')
    expect(status?.error).toBeTruthy()
  })

  it('cancelQuery interrupts an in-flight query', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl)
    await manager.connect(profile)

    const running = manager.query(profile.id, null, 'select pg_sleep(30)')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await manager.cancelQuery(profile.id)).success).toBe(true)

    const response = await running
    expect(response.success).toBe(false)
    if (!response.success) expect(response.error).toMatch(/cancel/i)
  }, 20000)

  it('createDatabase and dropDatabase update children and rebroadcast', async () => {
    const manager = makeManager()
    const profile = profileFromUrl(dbUrl, { databaseMode: 'all' })
    await manager.connect(profile)
    const name = 'sqlkit_mgr_created'

    await manager.dropDatabase(profile.id, name) // best-effort pre-clean of a leftover
    const created = await manager.createDatabase(profile.id, name)
    expect(created.success).toBe(true)
    expect(manager.statuses().find((s) => s.profileId === profile.id)?.children?.some((c) => c.name === name)).toBe(true)

    const dropped = await manager.dropDatabase(profile.id, name)
    expect(dropped.success).toBe(true)
    expect(manager.statuses().find((s) => s.profileId === profile.id)?.children?.some((c) => c.name === name)).toBe(false)
  }, 20000)

  it('lists functions from the active child database only in all-databases mode', async () => {
    const manager = makeManager()
    const admin = adminPool(dbUrl)
    const dbA = 'sqlkit_mgr_scope_a'
    const dbB = 'sqlkit_mgr_scope_b'
    const drop = (database: string) => admin.query(`drop database if exists ${database}`).catch(() => {})
    const seed = async (database: string, functionName: string) => {
      const pool = adminPool(databaseUrl(dbUrl, database))
      try {
        await pool.query('create schema sqlkit_scope')
        await pool.query(`create function sqlkit_scope.${functionName}() returns text language sql as $$ select '${functionName}' $$`)
      } finally {
        await pool.end().catch(() => {})
      }
    }

    try {
      await drop(dbA)
      await drop(dbB)
      await admin.query(`create database ${dbA}`)
      await admin.query(`create database ${dbB}`)
      await seed(dbA, 'fn_only_in_a')
      await seed(dbB, 'fn_only_in_b')

      const profile = profileFromUrl(dbUrl, { database: dbA, databaseMode: 'all' })
      expect((await manager.connect(profile)).success).toBe(true)

      expect(manager.setActiveChild(profile.id, dbA)).toEqual({ success: true })
      const fromA = await manager.listObjects(profile.id)
      expect(fromA.success).toBe(true)
      if (!fromA.success) return
      const namesA = fromA.objects.functions.map((fn) => fn.name)
      expect(namesA).toContain('fn_only_in_a')
      expect(namesA).not.toContain('fn_only_in_b')

      expect(manager.setActiveChild(profile.id, dbB)).toEqual({ success: true })
      const fromB = await manager.listObjects(profile.id)
      expect(fromB.success).toBe(true)
      if (!fromB.success) return
      const namesB = fromB.objects.functions.map((fn) => fn.name)
      expect(namesB).toContain('fn_only_in_b')
      expect(namesB).not.toContain('fn_only_in_a')
    } finally {
      await manager.disconnectAll()
      await drop(dbB)
      await drop(dbA)
      await admin.end().catch(() => {})
    }
  }, 20000)

  it('testConnection succeeds against a reachable database', async () => {
    const result = await testConnection(profileFromUrl(dbUrl))
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.serverVersion).toMatch(/^PostgreSQL/)
      expect(result.tookMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('testConnection reports failure for bad credentials', async () => {
    const result = await testConnection(profileFromUrl(dbUrl, { password: 'definitely-the-wrong-password' }))
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toBeTruthy()
  })
})
