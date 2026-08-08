import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { join } from 'node:path'
import type { ConnectionProfile } from '../src/electron'
import { t } from '../src/i18n'
import { testConnection, type ConnectionManager } from './db/manager'
import { MAX_FETCH_ROWS } from './db/result-sessions'
import { testSshTunnel } from './db/transport'
import {
  batchStatements,
  connectionProfile,
  IpcValidationError,
  databaseCreateOptions,
  databaseObject,
  databaseObjectKind,
  ddlStatements,
  exportFormat,
  nullableStringValue,
  nonNegativeInteger,
  objectDdlReference,
  optionalTableReference,
  queryPayload,
  stringValue,
  tableReference,
  transactionEndMode,
} from './ipc-validation'
import { hydrateConnectionProfile } from './workspace'

export type DbIpcContext = {
  workspaceFor(contents: WebContents): string | null
  managerFor(contents: WebContents): ConnectionManager
  existingManagerFor(contentsId: number): ConnectionManager | undefined
}

export function registerDbIpc(context: DbIpcContext) {
  const manager = (event: IpcMainInvokeEvent) => context.managerFor(event.sender)
  const existingManager = (event: IpcMainInvokeEvent) => context.existingManagerFor(event.sender.id)
  const hydratedProfile = (event: IpcMainInvokeEvent, profile: ConnectionProfile) =>
    hydrateConnectionProfile(context.workspaceFor(event.sender), profile)

  ipcMain.handle('db:test', (event, profile: unknown) => {
    try {
      return testConnection(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message, tookMs: 0 }
    }
  })
  ipcMain.handle('db:test-ssh', (event, profile: unknown) => {
    try {
      return testSshTunnel(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message, tookMs: 0 }
    }
  })
  ipcMain.handle('db:connect', (event, profile: unknown) => {
    try {
      return manager(event).connect(hydratedProfile(event, connectionProfile(profile)))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:disconnect', (event, profileId: unknown) =>
    existingManager(event)?.disconnect(stringValue(profileId, 'Profile id', 200)))
  ipcMain.handle('db:disconnect-all', (event) => existingManager(event)?.disconnectAll())
  ipcMain.handle('db:clear-error', (event, profileId: unknown) =>
    existingManager(event)?.clearError(stringValue(profileId, 'Profile id', 200)))
  ipcMain.handle('db:set-active-child', (event, profileId: unknown, database: unknown) => {
    try {
      return manager(event).setActiveChild(
        stringValue(profileId, 'Profile id', 200),
        stringValue(database, 'Database name', 2_000),
      )
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:statuses', (event) => existingManager(event)?.statuses() ?? [])
  ipcMain.handle('db:end-transaction', (event, profileId: unknown, mode: unknown) => {
    try {
      return manager(event).endTransaction(stringValue(profileId, 'Profile id', 200), transactionEndMode(mode))
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle(
    'db:query',
    (event, profileId: unknown, childDb: unknown, sql: unknown, params?: unknown, sort?: unknown, filter?: unknown, executionId?: unknown) => {
      try {
        const payload = queryPayload(sql, params, sort, filter, executionId)
        return manager(event).query(
          stringValue(profileId, 'Profile id', 200),
          childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
          payload.sql,
          payload.params,
          payload.sort,
          payload.filter,
          payload.executionId,
        )
      } catch (error) {
        return { success: false as const, error: (error as Error).message }
      }
    },
  )
  ipcMain.handle('db:run-batch', (event, profileId: unknown, childDb: unknown, statements: unknown) => {
    try {
      return manager(event).runBatch(
        stringValue(profileId, 'Profile id', 200),
        childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
        batchStatements(statements),
      )
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:run-ddl', (event, profileId: unknown, childDb: unknown, statements: unknown) => {
    try {
      return manager(event).runDdl(
        stringValue(profileId, 'Profile id', 200),
        childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
        ddlStatements(statements),
      )
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
  })
  ipcMain.handle('db:fetch-rows', (event, sessionId: unknown, offset: unknown, limit: unknown) =>
    existingManager(event)?.fetchRows(
      stringValue(sessionId, 'Session id', 200),
      nonNegativeInteger(offset, 'Row offset', Number.MAX_SAFE_INTEGER),
      nonNegativeInteger(limit, 'Row limit', MAX_FETCH_ROWS),
    ) ?? { success: false as const, error: t('connection.noActiveSession') })
  ipcMain.handle('db:close-session', (event, sessionId: unknown) =>
    existingManager(event)?.closeSession(stringValue(sessionId, 'Session id', 200)))
  ipcMain.handle('db:export-query', async (event, profileId: unknown, childDb: unknown, sql: unknown, params: unknown, sort: unknown, filter: unknown, format: unknown, suggestedName: unknown, executionId?: unknown, sqlTable?: unknown) => {
    let parsed
    try {
      const payload = queryPayload(sql, params, sort, filter, executionId)
      parsed = {
        profileId: stringValue(profileId, 'Profile id', 200),
        childDb: childDb === null ? null : stringValue(childDb, 'Database name', 2_000),
        ...payload,
        format: exportFormat(format),
        name: stringValue(suggestedName, 'Suggested file name', 1_000),
        executionId: executionId === undefined ? undefined : stringValue(executionId, 'Execution id', 200),
        sqlTable: optionalTableReference(sqlTable),
      }
    } catch (error) {
      return { success: false as const, error: (error as Error).message }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return { success: false as const, error: t('workspace.windowNotReady') }
    const activeManager = existingManager(event)
    if (!activeManager) return { success: false as const, error: t('connection.notConnected') }
    const result = await dialog.showSaveDialog(window, {
      title: t('workspace.exportResults'),
      defaultPath: join(app.getPath('downloads'), parsed.name || `results.${parsed.format}`),
      filters: [{ name: parsed.format.toUpperCase(), extensions: [parsed.format] }],
    })
    if (result.canceled || !result.filePath) return { success: false as const, canceled: true }
    return activeManager.exportQuery(parsed.profileId, parsed.childDb, parsed.sql, parsed.params, parsed.sort ?? null, parsed.filter ?? null, result.filePath, parsed.format, parsed.sqlTable, parsed.executionId)
  })
  ipcMain.handle('db:cancel', (event, profileId: unknown, executionId?: unknown) =>
    manager(event).cancelQuery(
      stringValue(profileId, 'Profile id', 200),
      executionId === undefined ? undefined : stringValue(executionId, 'Execution id', 200),
    ))
  ipcMain.handle('db:database-create-meta', (event, profileId: unknown) =>
    manager(event).databaseCreateMeta(stringValue(profileId, 'Profile id', 200)))
  ipcMain.handle('db:create-database', (event, profileId: unknown, name: unknown, options: unknown) =>
    manager(event).createDatabase(
      stringValue(profileId, 'Profile id', 200),
      stringValue(name, 'Database name', 2_000),
      databaseCreateOptions(options),
    ))
  ipcMain.handle('db:drop-database', (event, profileId: unknown, name: unknown) =>
    manager(event).dropDatabase(stringValue(profileId, 'Profile id', 200), stringValue(name, 'Database name', 2_000)))
  ipcMain.handle('db:list-tables', (event, profileId: unknown, childDb: unknown) =>
    manager(event).listTables(stringValue(profileId, 'Profile id', 200), nullableStringValue(childDb, 'Database name', 2_000)))
  ipcMain.handle('db:list-columns', (event, profileId: unknown, childDb: unknown) =>
    manager(event).listColumns(stringValue(profileId, 'Profile id', 200), nullableStringValue(childDb, 'Database name', 2_000)))
  ipcMain.handle('db:inspect-table', (event, profileId: unknown, childDb: unknown, table: unknown) =>
    manager(event).inspectTable(
      stringValue(profileId, 'Profile id', 200),
      tableReference(table),
      nullableStringValue(childDb, 'Database name', 2_000),
    ))
  ipcMain.handle('db:list-objects', (event, profileId: unknown, childDb: unknown) =>
    manager(event).listObjects(stringValue(profileId, 'Profile id', 200), nullableStringValue(childDb, 'Database name', 2_000)))
  ipcMain.handle('db:inspect-object', (event, profileId: unknown, childDb: unknown, object: unknown, objectKind: unknown) =>
    manager(event).inspectObject(
      stringValue(profileId, 'Profile id', 200),
      databaseObject(object),
      databaseObjectKind(objectKind),
      nullableStringValue(childDb, 'Database name', 2_000),
    ))
  ipcMain.handle('db:object-ddl', (event, profileId: unknown, childDb: unknown, ref: unknown) =>
    manager(event).objectDdl(
      stringValue(profileId, 'Profile id', 200),
      objectDdlReference(ref),
      nullableStringValue(childDb, 'Database name', 2_000),
    ))
  ipcMain.handle('db:inspect-server', (event, profileId: unknown, childDb: unknown) =>
    manager(event).inspectServer(stringValue(profileId, 'Profile id', 200), nullableStringValue(childDb, 'Database name', 2_000)))

  ipcMain.handle('db:server-activity', (event, profileId: unknown, childDb: unknown) =>
    manager(event).serverActivity(stringValue(profileId, 'Profile id', 200), nullableStringValue(childDb, 'Database name', 2_000)))

  ipcMain.handle('db:end-session', (event, profileId: unknown, sessionId: unknown, mode: unknown) => {
    if (mode !== 'cancel' && mode !== 'terminate') throw new IpcValidationError('Session end mode is invalid')
    return manager(event).endSession(
      stringValue(profileId, 'Profile id', 200),
      stringValue(sessionId, 'Session id', 200),
      mode,
    )
  })

  ipcMain.handle('db:pick-sqlite-file', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return null
    const result = await dialog.showOpenDialog(window, {
      title: t('workspace.chooseSqlite'),
      buttonLabel: t('workspace.choose'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: t('workspace.sqliteDatabase'), extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
        { name: t('workspace.allFiles'), extensions: ['*'] },
      ],
    })
    return result.canceled ? null : result.filePaths[0]
  })
}
