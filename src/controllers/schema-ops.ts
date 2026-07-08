import type { ConnectionProfile, DdlResult, Engine, TableRef } from '../electron'
import type { DialogsController } from './dialogs'
import { dialectFor } from '../dialect'
import { buildColumnAdd, buildColumnAlter, buildColumnDrop, quoteQualified, type ColumnAdd, type ColumnAlter } from '../sql-write'
import { TABLE_KIND_LABELS } from '../table-kinds'

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
      message: `Drop ${TABLE_KIND_LABELS[table.kind]} "${table.name}"?`,
      detail: 'It is permanently deleted on the server. This cannot be undone.',
      confirmLabel: 'Drop',
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
      message: `Truncate "${table.name}"?`,
      detail: `All rows are permanently deleted (${statement}). This cannot be undone.`,
      confirmLabel: 'Truncate',
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
    // Drops run first so a rename or addition can reuse a freed name.
    const statements = [
      ...buildColumnDrop(spec.table, spec.drops, spec.engine),
      ...buildColumnAlter(spec.table, spec.edits, spec.engine),
      ...buildColumnAdd(spec.table, spec.additions, spec.engine),
    ]
    if (!statements.length) return
    this.deps.dialogs.review = {
      sql: statements.map((statement) => `${statement};`).join('\n\n'),
      params: [],
      run: () => void this._runAlter(spec, statements),
    }
  }

  private async _runAlter(spec: ColumnAlterSpec, statements: string[]) {
    let result: DdlResult
    try {
      result = await window.sqlkit.runDdl(spec.profileId, spec.childDb, statements)
    } catch (error) {
      result = { success: false, error: (error as Error).message }
    }
    if (!result.success) {
      const reason =
        result.failedIndex !== undefined
          ? `Statement ${result.failedIndex + 1} of ${statements.length} failed: ${result.error}`
          : result.error
      this.deps.dialogs.notice('Schema change failed', `${reason} No changes were made.`)
      return
    }
    spec.onApplied()
    this.deps.refresh(spec.profileId)
  }

  createDatabase(profileId: string) {
    this.deps.dialogs.prompt = {
      message: 'Create Database',
      detail: 'Name of the new database on this server.',
      confirmLabel: 'Create',
      placeholder: 'my_database',
      action: (name) => void this._createDatabase(profileId, name),
    }
  }

  dropDatabase(profileId: string, database: string) {
    this.deps.dialogs.confirm = {
      message: `Drop database "${database}"?`,
      detail: 'All data in it is permanently deleted on the server. This cannot be undone.',
      confirmLabel: 'Drop Database',
      action: () => void this._dropDatabase(profileId, database),
    }
  }

  private async _createDatabase(profileId: string, name: string) {
    const result = await window.sqlkit.createDatabase(profileId, name)
    if (!result.success) this.deps.dialogs.notice(`Could not create "${name}"`, result.error ?? 'Unknown error')
  }

  private async _dropDatabase(profileId: string, database: string) {
    const result = await window.sqlkit.dropDatabase(profileId, database)
    if (!result.success) {
      this.deps.dialogs.notice(`Could not drop "${database}"`, result.error ?? 'Unknown error')
      return
    }
    this.deps.onDatabaseDropped(profileId, database)
  }
}
