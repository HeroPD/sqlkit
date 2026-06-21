import type { FileInfo, FileSaveResult } from '../electron'
import type { ContextsController } from './contexts'
import type { FilesController } from './files'
import type { QueriesController } from './queries'
import type { DialogsController } from './dialogs'

type Deps = {
  ctx: ContextsController
  files: FilesController
  queries: QueriesController
  dialogs: DialogsController
  contextFolder: () => string | null
}

// Tabs for workspace files are keyed by absolute path, so same-named files in
// different database folders stay distinct.
const fileTabId = (path: string) => `file:${path}`

// Browse/history tab names already end in .sql; don't double it.
const suggestedSqlName = (tabName: string) => `${tabName.replace(/\.sql$/i, '')}.sql`

type ContextRef = { profileId: string | null; childDb: string | null }

// Owns workspace-file actions: opening a file into an editor tab, saving the
// active tab, and create/rename/delete — keeping the open tabs, their query
// results, and the file listing in step. Pure file I/O is in the main process.
export class FileOpsController {
  private deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  private currentContext(): ContextRef {
    return { profileId: this.deps.ctx.activeDbId, childDb: this.deps.ctx.activeChildDb }
  }

  async openFile(file: FileInfo, context = this.currentContext()) {
    const id = fileTabId(file.path)
    if (this.deps.ctx.tabExistsInContext(context.profileId, context.childDb, id)) {
      this.deps.ctx.activateTabInContext(context.profileId, context.childDb, id)
      return
    }
    const result = await window.sqlkit.readFile(file.path)
    if (!result.success) {
      this.deps.dialogs.notice('Could not open file', result.error ?? 'Unknown error')
      return
    }
    this.deps.ctx.addTabToContext(context.profileId, context.childDb, {
      id,
      kind: 'sql',
      name: file.name,
      path: file.path,
      content: result.content,
      savedContent: result.content,
    })
  }

  // Only .sql opens in the editor; spreadsheets, exports etc. go to the
  // system default app.
  openFileOrExternal(file: FileInfo) {
    if (file.name.toLowerCase().endsWith('.sql')) {
      void this.openFile(file)
      return
    }
    void window.sqlkit.openExternal(file.path).then((result) => {
      if (!result.success) this.deps.dialogs.notice('Could not open file', result.error ?? 'Unknown error')
    })
  }

  // Untitled queries go through the native dialog, defaulting into the active
  // context's folder; saved files write in place.
  async saveActive() {
    const tab = this.deps.ctx.activeSqlTab()
    if (!tab) return
    const result = tab.path
      ? await window.sqlkit.saveFile(tab.path, tab.content)
      : await window.sqlkit.saveFileAs(this.deps.contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    if (!this.reportSaveError(result)) return
    this.deps.ctx.applySaveResult(tab, result)
  }

  // File > Save As…: always the dialog, even for files that have a path.
  async saveActiveAs() {
    const tab = this.deps.ctx.activeSqlTab()
    if (!tab) return
    const result = await window.sqlkit.saveFileAs(this.deps.contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    if (!this.reportSaveError(result)) return
    this.deps.ctx.applySaveResult(tab, result)
  }

  // A failed save must never look like it succeeded — the tab keeps its dirty
  // marker and the user is told why. A canceled dialog is not an error. Returns
  // true when the save went through and the caller should apply it.
  private reportSaveError(result: FileSaveResult): boolean {
    if (result.success) return true
    if (!result.canceled) this.deps.dialogs.notice('Could not save file', result.error ?? 'Unknown error')
    return false
  }

  async create(parent: string, name: string) {
    const folder = this.deps.contextFolder()
    if (!folder) return
    const context = this.currentContext()
    const result = await window.sqlkit.createFile(folder, parent ? `${parent}/${name}` : name)
    if (!result.success) {
      this.deps.dialogs.notice('Could not create file', result.error ?? 'Unknown error')
      return
    }
    await this.deps.files.reload()
    const created = this.deps.files.files.find((file) => file.path === result.path) ?? {
      type: 'file' as const,
      name: result.name,
      path: result.path,
      relativePath: result.name,
    }
    void this.openFile(created, context)
  }

  async rename(file: FileInfo, newName: string) {
    const result = await window.sqlkit.renameFile(file.path, newName)
    if (!result.success) {
      this.deps.dialogs.notice('Could not rename file', result.error ?? 'Unknown error')
      return
    }
    const oldId = fileTabId(file.path)
    const newId = fileTabId(result.path)
    this.deps.ctx.retargetFileTab(oldId, newId, result.name, result.path)
    this.deps.queries.renameTab(oldId, newId)
    void this.deps.files.reload()
  }

  requestDelete(path: string, name: string) {
    this.deps.dialogs.confirm = {
      message: `Delete "${name}"?`,
      detail: 'It will be moved to the Trash.',
      confirmLabel: 'Move to Trash',
      action: () => void this.performDelete(path),
    }
  }

  private async performDelete(targetPath: string) {
    const result = await window.sqlkit.deleteFile(targetPath)
    if (!result.success) {
      this.deps.dialogs.notice('Could not delete file', result.error ?? 'Unknown error')
      return
    }
    this.deps.ctx.closeFilesUnder(targetPath)
    this.deps.queries.sweepOrphans()
    void this.deps.files.reload()
  }
}
