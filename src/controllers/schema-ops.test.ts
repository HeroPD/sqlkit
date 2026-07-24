// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, TableRef } from '../electron'
import { DialogsController } from './dialogs'
import { SchemaOpsController, type ColumnAlterSpec } from './schema-ops'
import type { InspectOperation } from '../inspect-operations'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

const profile = (engine: ConnectionProfile['engine'] = 'postgresql'): ConnectionProfile =>
  ({ id: 'p1', engine } as ConnectionProfile)

const users: TableRef = { schema: 'public', name: 'users', kind: 'table' }

// Resolves once queued microtasks (the controller's fire-and-forget IPC
// promises) have settled, so assertions see the post-await state.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const sqlkit = {
  runDdl: vi.fn(),
  databaseCreateMeta: vi.fn(),
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
}

type Harness = {
  ops: SchemaOpsController
  dialogs: DialogsController
  openPreview: ReturnType<typeof vi.fn>
  runSql: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  onDatabaseDropped: ReturnType<typeof vi.fn>
}

const harness = (active: ConnectionProfile | null = profile()): Harness => {
  const dialogs = new DialogsController(host())
  const openPreview = vi.fn()
  const runSql = vi.fn(() => Promise.resolve())
  const refresh = vi.fn()
  const onDatabaseDropped = vi.fn()
  const ops = new SchemaOpsController({
    activeProfile: () => active,
    dialogs,
    openPreview,
    runSql,
    refresh,
    onDatabaseDropped,
  })
  return { ops, dialogs, openPreview, runSql, refresh, onDatabaseDropped }
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { sqlkit: unknown }).sqlkit = sqlkit
})

describe('dropTable', () => {
  it('confirms first and only runs the DROP on accept', async () => {
    const h = harness()
    h.ops.dropTable(users)

    expect(h.runSql).not.toHaveBeenCalled()
    expect(h.dialogs.confirm?.message).toBe('Drop table "users"?')

    h.dialogs.acceptConfirm()
    await flush()
    expect(h.openPreview).toHaveBeenCalledWith('DROP TABLE "public"."users";')
    expect(h.runSql).toHaveBeenCalledWith('DROP TABLE "public"."users";')
    expect(h.refresh).toHaveBeenCalledWith('p1')
  })

  it('uses the drop verb for the object kind and the engine dialect quoting', () => {
    const h = harness(profile('sqlserver'))
    h.ops.dropTable({ ...users, kind: 'view' })
    h.dialogs.acceptConfirm()
    expect(h.runSql).toHaveBeenCalledWith('DROP VIEW [public].[users];')

    h.ops.dropTable({ ...users, kind: 'matview' })
    h.dialogs.acceptConfirm()
    expect(h.runSql).toHaveBeenCalledWith('DROP MATERIALIZED VIEW [public].[users];')
  })

  it('does nothing without an active profile', () => {
    const h = harness(null)
    h.ops.dropTable(users)
    expect(h.dialogs.confirm).toBeNull()
    expect(h.runSql).not.toHaveBeenCalled()
  })
})

describe('truncateTable', () => {
  it('confirms first and truncates on accept', () => {
    const h = harness()
    h.ops.truncateTable(users)
    expect(h.runSql).not.toHaveBeenCalled()
    h.dialogs.acceptConfirm()
    expect(h.runSql).toHaveBeenCalledWith('TRUNCATE TABLE "public"."users";')
  })

  it('uses DELETE FROM on SQLite, which has no TRUNCATE', () => {
    const h = harness(profile('sqlite'))
    h.ops.truncateTable({ schema: null, name: 'users', kind: 'table' })
    h.dialogs.acceptConfirm()
    expect(h.runSql).toHaveBeenCalledWith('DELETE FROM "users";')
  })
})

describe('refreshMatview', () => {
  it('runs immediately through the visible query path', () => {
    const h = harness()
    h.ops.refreshMatview({ ...users, kind: 'matview' })
    expect(h.dialogs.confirm).toBeNull()
    expect(h.openPreview).toHaveBeenCalledWith('REFRESH MATERIALIZED VIEW "public"."users";')
    expect(h.runSql).toHaveBeenCalledWith('REFRESH MATERIALIZED VIEW "public"."users";')
  })
})

describe('alterColumns', () => {
  const spec = (over: Partial<ColumnAlterSpec> = {}): ColumnAlterSpec => ({
    profileId: 'p1',
    childDb: null,
    table: users,
    engine: 'postgresql',
    edits: [],
    additions: [],
    drops: [],
    onApplied: vi.fn(),
    ...over,
  })

  it('opens a review with drops before adds and runs the statements on accept', async () => {
    sqlkit.runDdl.mockResolvedValue({ success: true })
    const h = harness()
    const s = spec({
      drops: ['legacy'],
      additions: [{ name: 'age', dataType: 'integer', nullable: true, default: null, comment: null }],
    })
    h.ops.alterColumns(s)

    expect(sqlkit.runDdl).not.toHaveBeenCalled()
    expect(h.dialogs.review?.warning).toBeUndefined()
    expect(h.dialogs.review?.sql).toBe(
      'ALTER TABLE "public"."users" DROP COLUMN "legacy";\n\nALTER TABLE "public"."users" ADD COLUMN "age" integer;',
    )

    await h.dialogs.review!.run()
    expect(sqlkit.runDdl).toHaveBeenCalledWith('p1', null, [
      'ALTER TABLE "public"."users" DROP COLUMN "legacy"',
      'ALTER TABLE "public"."users" ADD COLUMN "age" integer',
    ])
    expect(s.onApplied).toHaveBeenCalledOnce()
    expect(h.refresh).toHaveBeenCalledWith('p1')
  })

  it('includes staged columns and schema objects in one review and one DDL batch', async () => {
    sqlkit.runDdl.mockResolvedValue({ success: true })
    const h = harness()
    const s = spec({
      additions: [{ name: 'tenant_id', dataType: 'integer', nullable: false, default: null, comment: null }],
      operations: [{ kind: 'index', spec: { name: 'users_tenant_idx', columns: ['tenant_id'] } }] as InspectOperation[],
    })

    h.ops.alterColumns(s)

    expect(h.dialogs.review?.sql).toBe(
      'ALTER TABLE "public"."users" ADD COLUMN "tenant_id" integer NOT NULL;\n\n' +
      'CREATE INDEX "users_tenant_idx" ON "public"."users" ("tenant_id");',
    )
    await h.dialogs.review!.run()
    expect(sqlkit.runDdl).toHaveBeenCalledWith('p1', null, [
      'ALTER TABLE "public"."users" ADD COLUMN "tenant_id" integer NOT NULL',
      'CREATE INDEX "users_tenant_idx" ON "public"."users" ("tenant_id")',
    ])
  })

  it('creates a table before its staged indexes in one reviewed batch', () => {
    const h = harness()
    h.ops.alterColumns(spec({
      table: { schema: 'public', name: 'projects', kind: 'table' },
      createTable: true,
      additions: [{ name: 'id', dataType: 'integer', nullable: false, default: null, comment: null }],
      operations: [
        { kind: 'constraint', spec: { name: 'projects_pkey', type: 'PRIMARY KEY', columns: ['id'] } },
        { kind: 'index', spec: { name: 'projects_id_idx', columns: ['id'], unique: false } },
      ],
    }))

    expect(h.dialogs.review?.sql).toBe(
      'CREATE TABLE "public"."projects" (\n' +
      '  "id" integer NOT NULL,\n' +
      '  CONSTRAINT "projects_pkey" PRIMARY KEY ("id")\n' +
      ');\n\n' +
      'CREATE INDEX "projects_id_idx" ON "public"."projects" ("id");',
    )
  })

  it('drops dependent objects before columns and creates objects after column changes', () => {
    const h = harness()
    h.ops.alterColumns(spec({
      drops: ['legacy'],
      additions: [{ name: 'tenant_id', dataType: 'integer', nullable: true, default: null, comment: null }],
      operations: [
        { kind: 'index', spec: { name: 'users_tenant_idx', columns: ['tenant_id'], unique: false } },
        { kind: 'drop', target: 'foreignKey', name: 'users_legacy_fk' },
      ],
    }))

    expect(h.dialogs.review?.sql).toBe(
      'ALTER TABLE "public"."users" DROP CONSTRAINT "users_legacy_fk";\n\n' +
      'ALTER TABLE "public"."users" DROP COLUMN "legacy";\n\n' +
      'ALTER TABLE "public"."users" ADD COLUMN "tenant_id" integer;\n\n' +
      'CREATE INDEX "users_tenant_idx" ON "public"."users" ("tenant_id");',
    )
  })

  it('opens no review when the staged edits produce no statements', () => {
    const h = harness()
    h.ops.alterColumns(spec())
    expect(h.dialogs.review).toBeNull()
  })

  it('reports which statement failed and that nothing was applied', async () => {
    sqlkit.runDdl.mockResolvedValue({ success: false, failedIndex: 1, error: 'boom' })
    const h = harness()
    const s = spec({ drops: ['a', 'b'] })
    h.ops.alterColumns(s)
    const error = await h.dialogs.review!.run()

    expect(error).toBe('Statement 2 of 2 failed: boom No changes were made.')
    expect(s.onApplied).not.toHaveBeenCalled()
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('reports MySQL partial progress, where committed DDL cannot roll back', async () => {
    sqlkit.runDdl.mockResolvedValue({ success: false, failedIndex: 1, partial: true, appliedCount: 1, error: 'boom' })
    const h = harness()
    h.ops.alterColumns(spec({ engine: 'mysql', drops: ['a', 'b'] }))
    expect(h.dialogs.review?.warning).toMatch(/commits schema statements individually/i)
    const error = await h.dialogs.review!.run()

    expect(error).toContain('1 earlier statement(s) were already committed by MySQL.')
  })

  it('surfaces a rejected runDdl IPC call as an inline failure message', async () => {
    sqlkit.runDdl.mockRejectedValue(new Error('ipc down'))
    const h = harness()
    const s = spec({ drops: ['a'] })
    h.ops.alterColumns(s)
    const error = await h.dialogs.review!.run()

    expect(error).toBe('ipc down No changes were made.')
    expect(s.onApplied).not.toHaveBeenCalled()
  })
})

describe('createDatabase / dropDatabase', () => {
  it('creates the database named in the dialog and stays quiet on success', async () => {
    sqlkit.databaseCreateMeta.mockResolvedValue({ success: true, meta: { engine: 'postgresql', collations: [] } })
    sqlkit.createDatabase.mockResolvedValue({ success: true })
    const h = harness()
    await h.ops.createDatabase('p1')
    expect(sqlkit.createDatabase).not.toHaveBeenCalled()

    h.dialogs.createDb?.action('analytics', { encoding: 'UTF8' })
    await flush()
    expect(sqlkit.createDatabase).toHaveBeenCalledWith('p1', 'analytics', { encoding: 'UTF8' })
    expect(h.dialogs.confirm).toBeNull()
  })

  it('notices a failed create', async () => {
    sqlkit.databaseCreateMeta.mockResolvedValue({ success: true, meta: { engine: 'postgresql', collations: [] } })
    sqlkit.createDatabase.mockResolvedValue({ success: false, error: 'exists' })
    const h = harness()
    await h.ops.createDatabase('p1')
    h.dialogs.createDb?.action('analytics', {})
    await flush()
    expect(h.dialogs.confirm?.message).toBe('Could not create "analytics"')
    expect(h.dialogs.confirm?.detail).toBe('exists')
  })

  it('notices when create metadata cannot be loaded', async () => {
    sqlkit.databaseCreateMeta.mockResolvedValue({ success: false, error: 'not connected' })
    const h = harness()
    await h.ops.createDatabase('p1')
    expect(h.dialogs.createDb).toBeNull()
    expect(h.dialogs.confirm?.detail).toBe('not connected')
  })

  it('drops only after confirm, then lets the workbench clean up its buckets', async () => {
    sqlkit.dropDatabase.mockResolvedValue({ success: true })
    const h = harness()
    h.ops.dropDatabase('p1', 'analytics')
    expect(sqlkit.dropDatabase).not.toHaveBeenCalled()

    h.dialogs.acceptConfirm()
    await flush()
    expect(sqlkit.dropDatabase).toHaveBeenCalledWith('p1', 'analytics')
    expect(h.onDatabaseDropped).toHaveBeenCalledWith('p1', 'analytics')
  })

  it('notices a refused drop and keeps the workbench state untouched', async () => {
    sqlkit.dropDatabase.mockResolvedValue({ success: false, error: 'in use' })
    const h = harness()
    h.ops.dropDatabase('p1', 'analytics')
    h.dialogs.acceptConfirm()
    await flush()
    expect(h.dialogs.confirm?.message).toBe('Could not drop "analytics"')
    expect(h.onDatabaseDropped).not.toHaveBeenCalled()
  })
})
