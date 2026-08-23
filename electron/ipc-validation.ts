import type { BatchStatement, ConnectionProfile, DbObject, DbObjectKind, HistoryItem, ObjectDdlRef, QuerySort, SessionContext, SessionInspectDraft, SessionTab, TableRef, WorkspaceConfig, WorkspaceSession } from '../src/electron'
import type { ExportFormat } from '../src/result-export'
import { isConnectionLabelColor } from '../src/connection-label-colors'
import { SettingsError, validateAppSettings, validateWorkspacePreferences } from '../src/settings'

const MAX_ID = 200
const MAX_TEXT = 10 * 1024 * 1024
const MAX_PARAMS = 10_000
const MAX_BATCH = 1_000

export class IpcValidationError extends Error {}

export function stringValue(value: unknown, label: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new IpcValidationError(`${label} must be a string`)
  if (value.length > max) throw new IpcValidationError(`${label} exceeds the ${max.toLocaleString()} character limit`)
  return value
}

export function nullableStringValue(value: unknown, label: string, max = MAX_TEXT): string | null {
  return value === null ? null : stringValue(value, label, max)
}

export function tableReference(value: unknown): TableRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Table reference is invalid')
  const table = value as Record<string, unknown>
  if (table.kind !== 'table' && table.kind !== 'view' && table.kind !== 'matview' && table.kind !== 'foreign') {
    throw new IpcValidationError('Table kind is invalid')
  }
  return {
    schema: nullableStringValue(table.schema, 'Table schema', 2_000),
    name: stringValue(table.name, 'Table name', 2_000),
    kind: table.kind,
  }
}

export function databaseObject(value: unknown): DbObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Database object is invalid')
  const object = value as Record<string, unknown>
  return {
    schema: nullableStringValue(object.schema, 'Object schema', 2_000),
    name: stringValue(object.name, 'Object name', 2_000),
    detail: stringValue(object.detail, 'Object detail', 20_000),
  }
}

export function databaseObjectKind(value: unknown): DbObjectKind {
  if (value !== 'function' && value !== 'type') throw new IpcValidationError('Database object kind is invalid')
  return value
}

export function transactionEndMode(value: unknown): 'commit' | 'rollback' {
  if (value !== 'commit' && value !== 'rollback') throw new IpcValidationError('Transaction end mode is invalid')
  return value
}

export function objectDdlReference(value: unknown): ObjectDdlRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Object DDL reference is invalid')
  const ref = value as Record<string, unknown>
  if (ref.kind !== 'function' && ref.kind !== 'view' && ref.kind !== 'matview') {
    throw new IpcValidationError('Object DDL kind is invalid')
  }
  return {
    schema: nullableStringValue(ref.schema, 'Object schema', 2_000),
    name: stringValue(ref.name, 'Object name', 2_000),
    kind: ref.kind,
    detail: nullableStringValue(ref.detail, 'Object detail', 20_000),
  }
}

const optionalString = (value: unknown, label: string, max = MAX_TEXT) =>
  value === undefined ? undefined : stringValue(value, label, max)

const booleanValue = (value: unknown, label: string) => {
  if (typeof value !== 'boolean') throw new IpcValidationError(`${label} must be a boolean`)
  return value
}

// Settings validation lives with the schema in src/settings.ts so the renderer
// normalizer and this boundary can never disagree about a field's range.
const settingsBoundary = <T>(parse: (value: unknown) => T) => (value: unknown): T => {
  try {
    return parse(value)
  } catch (error) {
    throw new IpcValidationError(error instanceof SettingsError ? error.message : 'Settings are invalid')
  }
}

export const appSettings = settingsBoundary(validateAppSettings)
export const workspacePreferences = settingsBoundary(validateWorkspacePreferences)

export function connectionProfile(value: unknown): ConnectionProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Connection profile is invalid')
  const profile = value as Record<string, unknown>
  const engine = profile.engine
  if (engine !== 'postgresql' && engine !== 'mysql' && engine !== 'sqlserver' && engine !== 'sqlite') {
    throw new IpcValidationError('Connection engine is invalid')
  }
  const parsed: ConnectionProfile = {
    id: stringValue(profile.id, 'Profile id', MAX_ID),
    name: stringValue(profile.name, 'Profile name', 500),
    engine,
    host: stringValue(profile.host, 'Database host', 2_000),
    port: stringValue(profile.port, 'Database port', 20),
    username: stringValue(profile.username, 'Database username', 2_000),
    password: stringValue(profile.password, 'Database password', 100_000),
    database: stringValue(profile.database, 'Database name', 2_000),
    file: stringValue(profile.file, 'SQLite file', 20_000),
    folder: stringValue(profile.folder, 'Workspace folder', 2_000),
  }
  if (profile.passwordSaved !== undefined) parsed.passwordSaved = booleanValue(profile.passwordSaved, 'passwordSaved')
  if (profile.readOnly !== undefined) parsed.readOnly = booleanValue(profile.readOnly, 'readOnly')
  if (profile.labelColor !== undefined) {
    if (!isConnectionLabelColor(profile.labelColor)) throw new IpcValidationError('Connection label color is invalid')
    parsed.labelColor = profile.labelColor
  }
  if (profile.databaseMode === 'single' || profile.databaseMode === 'all') parsed.databaseMode = profile.databaseMode
  else if (profile.databaseMode !== undefined) throw new IpcValidationError('Database mode is invalid')
  if (profile.lastChildDb !== undefined) parsed.lastChildDb = stringValue(profile.lastChildDb, 'Last database', 2_000)
  if (profile.flavor === 'supabase' || profile.flavor === 'mariadb') parsed.flavor = profile.flavor
  else if (profile.flavor !== undefined) throw new IpcValidationError('Engine flavor is invalid')
  if (profile.ssl !== undefined) {
    if (!profile.ssl || typeof profile.ssl !== 'object' || Array.isArray(profile.ssl)) throw new IpcValidationError('SSL config is invalid')
    const ssl = profile.ssl as Record<string, unknown>
    if (ssl.mode !== 'disable' && ssl.mode !== 'require' && ssl.mode !== 'verify-ca' && ssl.mode !== 'verify-full') {
      throw new IpcValidationError('SSL mode is invalid')
    }
    parsed.ssl = { mode: ssl.mode, ca: stringValue(ssl.ca, 'CA path', 20_000) }
  }
  if (profile.ssh !== undefined) {
    if (!profile.ssh || typeof profile.ssh !== 'object' || Array.isArray(profile.ssh)) throw new IpcValidationError('SSH config is invalid')
    const ssh = profile.ssh as Record<string, unknown>
    if (ssh.authType !== 'password' && ssh.authType !== 'key') throw new IpcValidationError('SSH auth type is invalid')
    parsed.ssh = {
      enabled: booleanValue(ssh.enabled, 'SSH enabled'),
      host: stringValue(ssh.host, 'SSH host', 2_000),
      port: stringValue(ssh.port, 'SSH port', 20),
      username: stringValue(ssh.username, 'SSH username', 2_000),
      authType: ssh.authType,
      password: stringValue(ssh.password, 'SSH password', 100_000),
      keyPath: stringValue(ssh.keyPath, 'SSH key path', 20_000),
      passphrase: stringValue(ssh.passphrase, 'SSH passphrase', 100_000),
      ...(ssh.passwordSaved === undefined ? {} : { passwordSaved: booleanValue(ssh.passwordSaved, 'SSH passwordSaved') }),
      ...(ssh.passphraseSaved === undefined ? {} : { passphraseSaved: booleanValue(ssh.passphraseSaved, 'SSH passphraseSaved') }),
    }
  }
  return parsed
}

// CREATE DATABASE options: all optional, short strings. Drivers additionally
// guard each value against a strict token regex before it reaches the SQL.
export function databaseCreateOptions(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Database options are invalid')
  const options = value as Record<string, unknown>
  return {
    charset: optionalString(options.charset, 'Charset', 256),
    collation: optionalString(options.collation, 'Collation', 256),
    encoding: optionalString(options.encoding, 'Encoding', 256),
    ctype: optionalString(options.ctype, 'Ctype', 256),
    owner: optionalString(options.owner, 'Owner', 256),
    template: optionalString(options.template, 'Template', 256),
  }
}

export function workspaceConfig(value: unknown): WorkspaceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Workspace config is invalid')
  const config = value as Record<string, unknown>
  if (!Array.isArray(config.connections) || config.connections.length > 1_000) {
    throw new IpcValidationError('Workspace connections are invalid')
  }
  const version = Number(config.version)
  if (!Number.isSafeInteger(version) || version < 1) throw new IpcValidationError('Workspace config version is invalid')
  const active = config.activeDbId
  const activeDbId = active === undefined || active === null ? active : stringValue(active, 'Active database id', MAX_ID)
  return {
    version,
    connections: config.connections.map(connectionProfile),
    ...(activeDbId === undefined ? {} : { activeDbId }),
    ...(config.preferences === undefined ? {} : { preferences: workspacePreferences(config.preferences) }),
  }
}

const MAX_SESSION_CONTEXTS = 200
const MAX_SESSION_TABS = 500
const MAX_DRAFT_ITEMS = 1_000

// Staged schema edits ride through verbatim: their shape belongs to the inspect
// component, and re-declaring it here would mean editing two files for every
// field it grows. Bound the size, confirm it is plain data, leave the meaning
// to the renderer — which re-checks it anyway, the file being user-editable.
function sessionInspectDraft(value: unknown): SessionInspectDraft | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Inspect draft is invalid')
  const draft = value as Record<string, unknown>
  if (!Array.isArray(draft.edits) || draft.edits.length > MAX_DRAFT_ITEMS) throw new IpcValidationError('Inspect draft edits are invalid')
  if (!Array.isArray(draft.operations) || draft.operations.length > MAX_DRAFT_ITEMS) {
    throw new IpcValidationError('Inspect draft operations are invalid')
  }
  const edits = draft.edits.map((entry): [string, Record<string, unknown>] => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new IpcValidationError('Inspect draft edit is invalid')
    const [key, diff] = entry as [unknown, unknown]
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) throw new IpcValidationError('Inspect draft edit is invalid')
    return [stringValue(key, 'Inspect draft column', MAX_ID), diff as Record<string, unknown>]
  })
  const operations = draft.operations.map((entry): Record<string, unknown> => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new IpcValidationError('Inspect draft operation is invalid')
    return entry as Record<string, unknown>
  })
  return {
    edits,
    operations,
    tableName: nullableStringValue(draft.tableName, 'Inspect draft table', 2_000),
    addSeq: nonNegativeInteger(draft.addSeq, 'Inspect draft counter', 100_000),
  }
}

// A config tab's unsaved form edits can hold a password the user just typed and
// has not saved. Blanking here — on the way to disk *and* on the way back —
// makes it impossible for any caller to put one in session.json by mistake.
const withoutSecrets = (profile: ConnectionProfile): ConnectionProfile => ({
  ...profile,
  password: '',
  ...(profile.ssh ? { ssh: { ...profile.ssh, password: '', passphrase: '' } } : {}),
})

// An unknown tab kind is dropped, not rejected: a session written by a later
// version must still restore the tabs this one understands.
function sessionTab(value: unknown): SessionTab | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Session tab is invalid')
  const tab = value as Record<string, unknown>
  const id = stringValue(tab.id, 'Session tab id', MAX_ID)
  if (tab.kind === 'sql') {
    return {
      kind: 'sql',
      id,
      name: stringValue(tab.name, 'Session tab name', 2_000),
      path: nullableStringValue(tab.path, 'Session tab path', 20_000),
      ...(tab.preview === undefined ? {} : { preview: booleanValue(tab.preview, 'Session tab preview') }),
      ...(tab.history === undefined ? {} : { history: booleanValue(tab.history, 'Session tab history') }),
      ...(tab.table === undefined ? {} : { table: tableReference(tab.table) }),
      ...(tab.dirty === undefined ? {} : { dirty: booleanValue(tab.dirty, 'Session tab dirty') }),
    }
  }
  if (tab.kind === 'config') {
    const draft = tab.draft === undefined ? undefined : withoutSecrets(connectionProfile(tab.draft))
    return {
      kind: 'config',
      id,
      profileId: stringValue(tab.profileId, 'Session tab profile', MAX_ID),
      ...(draft === undefined ? {} : { draft }),
    }
  }
  if (tab.kind === 'inspect') {
    const draft = sessionInspectDraft(tab.draft)
    return {
      kind: 'inspect',
      id,
      profileId: stringValue(tab.profileId, 'Session tab profile', MAX_ID),
      table: tableReference(tab.table),
      ...(tab.createTable === undefined ? {} : { createTable: booleanValue(tab.createTable, 'Session tab createTable') }),
      ...(draft === undefined ? {} : { draft }),
    }
  }
  if (tab.kind === 'inspect-object') {
    const draft = sessionInspectDraft(tab.draft)
    return {
      kind: 'inspect-object',
      id,
      profileId: stringValue(tab.profileId, 'Session tab profile', MAX_ID),
      object: databaseObject(tab.object),
      objectKind: databaseObjectKind(tab.objectKind),
      ...(draft === undefined ? {} : { draft }),
    }
  }
  return null
}

function sessionContext(value: unknown): SessionContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Session context is invalid')
  const context = value as Record<string, unknown>
  if (!Array.isArray(context.tabs) || context.tabs.length > MAX_SESSION_TABS) throw new IpcValidationError('Session tabs are invalid')
  const tabs = context.tabs.map(sessionTab).filter((tab): tab is SessionTab => tab !== null)
  const activeTabId = nullableStringValue(context.activeTabId, 'Session active tab', MAX_ID)
  return {
    profileId: nullableStringValue(context.profileId, 'Session context profile', MAX_ID),
    childDb: nullableStringValue(context.childDb, 'Session context database', 2_000),
    tabs,
    // A tab dropped as unknown must not leave the context pointing at it.
    activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null,
    selectedTable: nullableStringValue(context.selectedTable, 'Session selected table', 2_000),
  }
}

export function workspaceSession(value: unknown): WorkspaceSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Session is invalid')
  const session = value as Record<string, unknown>
  if (session.version !== 1) throw new IpcValidationError('Session version is invalid')
  if (!Array.isArray(session.contexts) || session.contexts.length > MAX_SESSION_CONTEXTS) {
    throw new IpcValidationError('Session contexts are invalid')
  }
  return {
    version: 1,
    contexts: session.contexts.map(sessionContext),
    ...(session.unclean === undefined ? {} : { unclean: booleanValue(session.unclean, 'Session unclean flag') }),
  }
}

export function queryPayload(sql: unknown, params: unknown, sort: unknown, filter: unknown, executionId: unknown) {
  const parsedSql = stringValue(sql, 'SQL')
  if (params !== undefined && (!Array.isArray(params) || params.length > MAX_PARAMS)) {
    throw new IpcValidationError(`Query params must contain at most ${MAX_PARAMS.toLocaleString()} values`)
  }
  let parsedSort: QuerySort | null | undefined
  if (sort === null || sort === undefined) parsedSort = sort
  else if (typeof sort === 'object' && !Array.isArray(sort)) {
    const candidate = sort as Record<string, unknown>
    if (candidate.direction !== 'asc' && candidate.direction !== 'desc') throw new IpcValidationError('Sort direction is invalid')
    parsedSort = { columnIndex: nonNegativeInteger(candidate.columnIndex, 'Sort column index', 100_000), direction: candidate.direction }
  } else throw new IpcValidationError('Sort is invalid')
  return {
    sql: parsedSql,
    params: params as unknown[] | undefined,
    sort: parsedSort,
    filter: filter === null || filter === undefined ? filter : stringValue(filter, 'Filter condition', 10_000),
    executionId: optionalString(executionId, 'Execution id', MAX_ID),
  }
}

export function batchStatements(value: unknown): BatchStatement[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH) throw new IpcValidationError(`Batch must contain at most ${MAX_BATCH} statements`)
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new IpcValidationError(`Batch statement ${index + 1} is invalid`)
    const statement = entry as Record<string, unknown>
    if (!Array.isArray(statement.params) || statement.params.length > MAX_PARAMS) throw new IpcValidationError(`Batch statement ${index + 1} params are invalid`)
    const expectedRows = statement.expectedRows
    if (expectedRows !== undefined && (!Number.isSafeInteger(expectedRows) || Number(expectedRows) < 0)) {
      throw new IpcValidationError(`Batch statement ${index + 1} expectedRows is invalid`)
    }
    return {
      sql: stringValue(statement.sql, `Batch statement ${index + 1} SQL`),
      params: statement.params,
      ...(expectedRows === undefined ? {} : { expectedRows: Number(expectedRows) }),
    }
  })
}

export function ddlStatements(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_BATCH) throw new IpcValidationError(`DDL batch must contain at most ${MAX_BATCH} statements`)
  return value.map((statement, index) => stringValue(statement, `DDL statement ${index + 1}`))
}

const MAX_HISTORY_ITEMS = 5_000
const MAX_HISTORY_SQL = 10_000
const MAX_HISTORY_ERROR = 2_000

// History entries persist to disk, so bound each field. Oversized SQL/error
// text is truncated rather than rejected — losing a tail beats losing the run.
export function historyItems(value: unknown): HistoryItem[] {
  if (!Array.isArray(value)) throw new IpcValidationError('History must be a list')
  return value.slice(0, MAX_HISTORY_ITEMS).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new IpcValidationError(`History entry ${index + 1} is invalid`)
    const item = entry as Record<string, unknown>
    const rowCount = item.rowCount
    if (rowCount !== null && (typeof rowCount !== 'number' || !Number.isFinite(rowCount))) {
      throw new IpcValidationError(`History entry ${index + 1} rowCount is invalid`)
    }
    const durationMs = item.durationMs
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) throw new IpcValidationError(`History entry ${index + 1} duration is invalid`)
    return {
      id: stringValue(item.id, `History entry ${index + 1} id`, MAX_ID),
      contextKey: stringValue(item.contextKey, `History entry ${index + 1} context`, 500),
      sql: stringValue(item.sql, `History entry ${index + 1} SQL`).slice(0, MAX_HISTORY_SQL),
      success: booleanValue(item.success, `History entry ${index + 1} success`),
      durationMs,
      rowCount,
      error: stringValue(item.error, `History entry ${index + 1} error`).slice(0, MAX_HISTORY_ERROR),
      createdAt: stringValue(item.createdAt, `History entry ${index + 1} createdAt`, 100),
    }
  })
}

export function exportFormat(value: unknown): ExportFormat {
  if (value !== 'csv' && value !== 'tsv' && value !== 'json' && value !== 'sql') throw new IpcValidationError('Export format is invalid')
  return value
}

// The INSERT target of a SQL export. Absent for every other format, and absent
// for a result with no single source table — the statements then name a
// placeholder. Validated as a table reference, not taken as a SQL fragment, so
// the name is quoted main-side by the connection's own dialect.
export function optionalTableReference(value: unknown): TableRef | null {
  return value === null || value === undefined ? null : tableReference(value)
}

export function querySort(value: unknown): QuerySort | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new IpcValidationError('Sort is invalid')
  const candidate = value as Record<string, unknown>
  if (candidate.direction !== 'asc' && candidate.direction !== 'desc') throw new IpcValidationError('Sort direction is invalid')
  return { columnIndex: nonNegativeInteger(candidate.columnIndex, 'Sort column index', 100_000), direction: candidate.direction }
}

export function nonNegativeInteger(value: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new IpcValidationError(`${label} is invalid`)
  return Number(value)
}
