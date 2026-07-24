import type { ConnectionProfile, DatabaseCreateOptions, DdlResult, Engine, TableRef } from '../electron'
import type { DialogsController } from './dialogs'
import { dialectFor } from '../dialect'
import {
  buildColumnAdd,
  buildColumnAlter,
  buildColumnDrop,
  buildCreateTable,
  quoteQualified,
  type ColumnAdd,
  type ColumnAlter,
} from '../sql-write'
import { tableKindLabel } from '../table-kinds'
import { capabilitiesFor } from '../engine-capabilities'
import { buildInspectOperation, type InspectOperation } from '../inspect-operations'
import { t } from '../i18n'

// Staged column edits from the Inspect tab, plus how to reach the connection and
// refresh the view once the change lands. `onApplied` reloads the inspect tab.
export type ColumnAlterSpec = {
  profileId: string
  childDb: string | null
  table: TableRef
  engine: Engine
  edits: ColumnAlter[]
  additions: ColumnAdd[]
  drops: string[]
  operations?: InspectOperation[]
  createTable?: boolean
  onApplied: () => void
}

type Deps = {
  activeProfile: () => ConnectionProfile | null
  dialogs: DialogsController
  openPreview: (sql: string) => void
  runSql: (sql: string) => Promise<void>
  refresh: (profileId: string) => void
  // Workbench cleanup after a child database is dropped on the server.
  onDatabaseDropped: (profileId: string, database: string) => void
}

const DROP_VERBS: Record<TableRef['kind'], string> = {
  table: 'DROP TABLE',
  view: 'DROP VIEW',
  matview: 'DROP MATERIALIZED VIEW',
  foreign: 'DROP FOREIGN TABLE',
}

// Owns server-side schema mutations: building the DDL and routing it through
// the confirm/prompt dialogs and the normal query path (so results, Tasks and
// history all see it). Workbench-level state cleanup is delegated back via deps.
export class SchemaOpsController {
  private deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  // Refresh runs as a visible statement: it lands in the preview tab and
  // through the normal query path, so it shows in results, Tasks (matview
  // refreshes are classic long-runners), and history.
  refreshMatview(table: TableRef) {
    const profile = this.deps.activeProfile()
    if (!profile) return
    const statement = `REFRESH MATERIALIZED VIEW ${quoteQualified(table, dialectFor(profile.engine))};`
    this.deps.openPreview(statement)
    void this.deps.runSql(statement)
  }

  dropTable(table: TableRef) {
    const profile = this.deps.activeProfile()
    if (!profile) return
    const statement = `${DROP_VERBS[table.kind]} ${quoteQualified(table, dialectFor(profile.engine))};`
    this.deps.dialogs.confirm = {
      message: t('schema.dropPrompt', { kind: tableKindLabel(table.kind), name: table.name }),
      detail: t('schema.dropDetail'),
      confirmLabel: t('schema.drop'),
      action: () => {
        this.deps.openPreview(statement)
        // The schema changed: re-fetch tables/columns once the drop lands.
        void this.deps.runSql(statement).then(() => this.deps.refresh(profile.id))
      },
    }
  }

  truncateTable(table: TableRef) {
    const profile = this.deps.activeProfile()
    if (!profile) return
    // SQLite has no TRUNCATE; an unqualified DELETE is its idiom.
    const qualified = quoteQualified(table, dialectFor(profile.engine))
    const statement = profile.engine === 'sqlite' ? `DELETE FROM ${qualified};` : `TRUNCATE TABLE ${qualified};`
    this.deps.dialogs.confirm = {
      message: t('schema.truncatePrompt', { name: table.name }),
      detail: t('schema.truncateDetail', { statement }),
      confirmLabel: t('schema.truncate'),
      action: () => {
        this.deps.openPreview(statement)
        void this.deps.runSql(statement)
      },
    }
  }

  // Inspect-tab column edits: build the DDL, show it in the review dialog, then
  // run it atomically. On success the inspect tab reloads and metadata refreshes
  // so autocomplete/column lists pick up renames.
  alterColumns(spec: ColumnAlterSpec) {
    const operations = spec.operations ?? []
    if (spec.createTable) {
      const constraints = operations.filter((operation) => operation.kind === 'constraint').map((operation) => operation.spec)
      const foreignKeys = operations.filter((operation) => operation.kind === 'foreignKey').map((operation) => operation.spec)
      const postCreate = operations.filter((operation) => operation.kind === 'index' || operation.kind === 'trigger')
      const statements = [
        ...buildCreateTable(spec.table, spec.additions, constraints, foreignKeys, spec.engine),
        ...postCreate.map((operation) => buildInspectOperation(spec.table, operation, spec.engine)),
      ]
      this._reviewAlter(spec, statements)
      return
    }
    // Dependent objects are removed before columns; new objects are created
    // after the columns they may reference exist.
    const statements = [
      ...operations.filter((operation) => operation.kind === 'drop').map((operation) => buildInspectOperation(spec.table, operation, spec.engine)),
      ...buildColumnDrop(spec.table, spec.drops, spec.engine),
      ...buildColumnAlter(spec.table, spec.edits, spec.engine),
      ...buildColumnAdd(spec.table, spec.additions, spec.engine),
      ...operations.filter((operation) => operation.kind !== 'drop').map((operation) => buildInspectOperation(spec.table, operation, spec.engine)),
    ]
    this._reviewAlter(spec, statements)
  }

  private _reviewAlter(spec: ColumnAlterSpec, statements: string[]) {
    if (!statements.length) return
    this.deps.dialogs.review = {
      sql: statements.map((statement) => `${statement};`).join('\n\n'),
      params: [],
      warning: this._ddlWarning(spec.engine, statements.length),
      run: () => this._runAlter(spec, statements),
    }
  }

  private _ddlWarning(engine: Engine, statementCount: number): string | undefined {
    if (statementCount < 2 || capabilitiesFor(engine).ddlAtomicity === 'atomic') return undefined
    return t('schema.nonAtomicWarning')
  }

  // Resolves to an error message (shown inline in the review dialog) or null on
  // success, at which point the tab reloads and metadata refreshes.
  private async _runAlter(spec: { profileId: string; childDb: string | null; onApplied: () => void }, statements: string[]): Promise<string | null> {
    let result: DdlResult
    try {
      result = await window.sqlkit.runDdl(spec.profileId, spec.childDb, statements)
    } catch (error) {
      result = { success: false, error: (error as Error).message }
    }
    if (!result.success) {
      const reason =
        result.failedIndex !== undefined
          ? t('schema.statementFailed', { index: result.failedIndex + 1, total: statements.length, error: result.error })
          : result.error
      const outcome = result.partial
        ? t('schema.partialCommit', { count: result.appliedCount ?? result.failedIndex ?? 0 })
        : t('schema.noChanges')
      return `${reason} ${outcome}`
    }
    spec.onApplied()
    this.deps.refresh(spec.profileId)
    return null
  }

  async createDatabase(profileId: string) {
    const meta = await window.sqlkit.databaseCreateMeta(profileId)
    if (!meta.success) {
      this.deps.dialogs.notice(t('schema.createDatabase'), meta.error ?? t('common.unknownError'))
      return
    }
    this.deps.dialogs.createDb = {
      meta: meta.meta,
      action: (name, options) => void this._createDatabase(profileId, name, options),
    }
  }

  dropDatabase(profileId: string, database: string) {
    this.deps.dialogs.confirm = {
      message: t('schema.dropDatabasePrompt', { database }),
      detail: t('schema.dropDatabaseDetail'),
      confirmLabel: t('schema.dropDatabase'),
      action: () => void this._dropDatabase(profileId, database),
    }
  }

  private async _createDatabase(profileId: string, name: string, options: DatabaseCreateOptions) {
    const result = await window.sqlkit.createDatabase(profileId, name, options)
    if (!result.success) this.deps.dialogs.notice(t('schema.createFailed', { name }), result.error ?? t('common.unknownError'))
  }

  private async _dropDatabase(profileId: string, database: string) {
    const result = await window.sqlkit.dropDatabase(profileId, database)
    if (!result.success) {
      this.deps.dialogs.notice(t('schema.dropFailed', { name: database }), result.error ?? t('common.unknownError'))
      return
    }
    this.deps.onDatabaseDropped(profileId, database)
  }
}
