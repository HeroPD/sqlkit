import type { FileInfo } from '../electron'
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

// Owns workspace-file actions: opening a file into an editor tab, saving the
// active tab, and create/rename/delete — keeping the open tabs, their query
// results, and the file listing in step. Pure file I/O is in the main process.
export class FileOpsController {
  private deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  async openFile(file: FileInfo) {
    const id = fileTabId(file.path)
    if (this.deps.ctx.tabs.some((tab) => tab.id === id)) {
      this.deps.ctx.activeTabId = id
      return
    }
    const result = await window.sqlkit.readFile(file.path)
    if (!result.success) {
      console.error('Failed to read file:', result.error)
      return
    }
    this.deps.ctx.addTab({ id, kind: 'sql', name: file.name, path: file.path, content: result.content, savedContent: result.content })
  }

  // Only .sql opens in the editor; spreadsheets, exports etc. go to the
  // system default app.
  openFileOrExternal(file: FileInfo) {
    if (file.name.toLowerCase().endsWith('.sql')) {
      void this.openFile(file)
      return
    }
    void window.sqlkit.openExternal(file.path).then((result) => {
      if (!result.success) console.error('Open failed:', result.error)
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
    this.deps.ctx.applySaveResult(tab, result)
  }

  // File > Save As…: always the dialog, even for files that have a path.
  async saveActiveAs() {
    const tab = this.deps.ctx.activeSqlTab()
    if (!tab) return
    const result = await window.sqlkit.saveFileAs(this.deps.contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    this.deps.ctx.applySaveResult(tab, result)
  }

  async create(parent: string, name: string) {
    const folder = this.deps.contextFolder()
    if (!folder) return
    const result = await window.sqlkit.createFile(folder, parent ? `${parent}/${name}` : name)
    if (!result.success) {
      console.error('Create failed:', result.error)
      return
    }
    await this.deps.files.reload()
    const created = this.deps.files.files.find((file) => file.path === result.path)
    if (created) void this.openFile(created)
  }

  async rename(file: FileInfo, newName: string) {
    const result = await window.sqlkit.renameFile(file.path, newName)
    if (!result.success) {
      console.error('Rename failed:', result.error)
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
      console.error('Delete failed:', result.error)
      return
    }
    this.deps.ctx.closeFilesUnder(targetPath)
    this.deps.queries.sweepOrphans()
    void this.deps.files.reload()
  }
}
