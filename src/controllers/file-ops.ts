import type { FileInfo, FileSaveResult } from '../electron'
import type { ConflictedFileTab, ContextsController } from './contexts'
import type { FilesController } from './files'
import type { QueriesController } from './queries'
import type { DialogsController } from './dialogs'
import { t } from '../i18n'

type Deps = {
  ctx: ContextsController
  files: FilesController
  queries: QueriesController
  dialogs: DialogsController
  contextFolder: () => string | null
  // Deleting a file closes its tabs in bulk, which skips the per-tab close path.
  sweepOrphanTabState: () => void
  // A tab whose work is now on disk no longer needs its session backup, and any
  // write still queued for it has to be cancelled before it recreates one.
  onTabSaved?: (tabId: string) => void
}

// Tabs for workspace files take an id derived from the absolute path, so
// same-named files in different database folders stay distinct — and so a tab
// keeps the same session backup across a reload. It is a starting point, not an
// index: whether a file is already open is answered by the tabs' paths, since a
// tab can outlive the path its id spells (Save As, or a restore after the file
// went missing).
const fileTabId = (path: string) => `file:${path}`

// Browse/history tab names already end in .sql; don't double it.
const suggestedSqlName = (tabName: string) => `${tabName.replace(/\.sql$/i, '')}.sql`

type ContextRef = { profileId: string | null; childDb: string | null }

// Owns workspace-file actions: opening a file into an editor tab, saving the
// active tab, and create/rename/delete — keeping the open tabs, their query
// results, and the file listing in step. Pure file I/O is in the main process.
export class FileOpsController {
  private deps: Deps
  private refreshGeneration = 0
  /** The file text each tab was last asked about, so a watcher event for an
   * unrelated file does not re-open a question the user already answered. */
  private askedDiskText = new Map<string, string>()

  constructor(deps: Deps) {
    this.deps = deps
  }

  /** Invalidates reads that belong to the workspace being left. */
  reset() {
    this.refreshGeneration += 1
    this.askedDiskText.clear()
  }

  private currentContext(): ContextRef {
    return { profileId: this.deps.ctx.activeDbId, childDb: this.deps.ctx.activeChildDb }
  }

  // A path-derived id that nothing else holds. The id normally reads
  // `file:<path>`, but a tab restored after its file went missing keeps that id
  // while showing unsaved work of its own — so a tab for the file that came back
  // takes a fresh id instead of merging into it, and the two keep their own
  // session backups.
  private freeTabId(path: string) {
    const id = fileTabId(path)
    return this.deps.ctx.tabExists(id) ? crypto.randomUUID() : id
  }

  /** A workspace watcher event may have come from another window. Re-read the
   * open files so clean editor documents follow disk without risking unsaved
   * work in dirty tabs. A newer watcher pass supersedes an older slow one. */
  async refreshOpenFiles() {
    const generation = ++this.refreshGeneration
    const files = await Promise.all(this.deps.ctx.openFilePaths().map(async (path) => ({
      path,
      result: await window.sqlkit.readFile(path).catch(() => null),
    })))
    if (generation !== this.refreshGeneration) return
    const conflicting = new Set<string>()
    for (const { path, result } of files) {
      if (!result) continue
      // A file that is merely unreadable (locked, briefly mid-write) is left for
      // the next pass; one that is gone leaves its tab holding the only copy.
      if (!result.success) {
        if (result.missing) this.deps.ctx.orphanFileTabs(path)
        continue
      }
      const { cleaned, conflicted } = this.deps.ctx.adoptFileContent(path, result.content)
      for (const tabId of cleaned) this.deps.onTabSaved?.(tabId)
      for (const tab of conflicted) {
        conflicting.add(tab.id)
        this.askToReload(path, result.content, tab)
      }
    }
    // A tab that is no longer at odds with its file — saved, reloaded, closed —
    // forgets it was ever asked, so a later clash asks again.
    for (const tabId of this.askedDiskText.keys()) {
      if (!conflicting.has(tabId)) this.askedDiskText.delete(tabId)
    }
  }

  /** A tab with unsaved changes cannot silently follow the file, so it asks —
   * once per version of the file, or every watcher event would ask again. Each
   * tab is asked separately: the answer discards that tab's work alone, and one
   * under another database is not the one the user is looking at. */
  private askToReload(path: string, content: string, tab: ConflictedFileTab) {
    if (this.askedDiskText.get(tab.id) === content) return
    // Recorded before the answer, not after: declining is a dismissal, which
    // reports nothing back, and the same file must not ask twice.
    this.askedDiskText.set(tab.id, content)
    this.deps.dialogs.confirm = {
      message: t('file.changedOnDisk', { name: tab.name }),
      detail: tab.live ? t('file.changedOnDiskDetail') : t('file.changedOnDiskOtherDatabase'),
      confirmLabel: t('file.reloadFromDisk'),
      cancelLabel: t('file.keepMyChanges'),
      action: () => void this.reloadFromDisk(path, tab.id),
    }
  }

  /** Re-reads on the way in: the file may have moved again while the question
   * sat unanswered, and the answer is about the file, not that older copy. */
  private async reloadFromDisk(path: string, tabId: string) {
    const result = await window.sqlkit.readFile(path).catch(() => null)
    if (!result) return
    if (!result.success) {
      if (result.missing) this.deps.ctx.orphanFileTabs(path)
      return
    }
    if (this.deps.ctx.reloadFileTab(tabId, result.content)) this.deps.onTabSaved?.(tabId)
    this.askedDiskText.delete(tabId)
  }

  async openFile(file: FileInfo, context = this.currentContext()) {
    const open = this.deps.ctx.fileTabInContext(context.profileId, context.childDb, file.path)
    if (open) {
      this.deps.ctx.activateTabInContext(context.profileId, context.childDb, open)
      return
    }
    const result = await window.sqlkit.readFile(file.path)
    if (!result.success) {
      this.deps.dialogs.notice(t('file.openFailed'), result.error ?? t('common.unknownError'))
      return
    }
    this.deps.ctx.addTabToContext(context.profileId, context.childDb, {
      id: this.freeTabId(file.path),
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
      if (!result.success) this.deps.dialogs.notice(t('file.openFailed'), result.error ?? t('common.unknownError'))
    })
  }

  /** Selects a workspace file or folder in the OS file manager. */
  reveal(path: string) {
    void window.sqlkit.revealFile(path).then((result) => {
      if (!result.success) this.deps.dialogs.notice(t('file.revealFailed'), result.error ?? t('common.unknownError'))
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
    this.deps.onTabSaved?.(tab.id)
  }

  // File > Save As…: always the dialog, even for files that have a path.
  async saveActiveAs() {
    const tab = this.deps.ctx.activeSqlTab()
    if (!tab) return
    const result = await window.sqlkit.saveFileAs(this.deps.contextFolder() ?? '', suggestedSqlName(tab.name), tab.content)
    if (!this.reportSaveError(result)) return
    this.deps.ctx.applySaveResult(tab, result)
    this.deps.onTabSaved?.(tab.id)
  }

  // A failed save must never look like it succeeded — the tab keeps its dirty
  // marker and the user is told why. A canceled dialog is not an error. Returns
  // true when the save went through and the caller should apply it.
  private reportSaveError(result: FileSaveResult): boolean {
    if (result.success) return true
    if (!result.canceled) this.deps.dialogs.notice(t('file.saveFailed'), result.error ?? t('common.unknownError'))
    return false
  }

  async create(parent: string, name: string) {
    const folder = this.deps.contextFolder()
    if (!folder) return
    const context = this.currentContext()
    const result = await window.sqlkit.createFile(folder, parent ? `${parent}/${name}` : name)
    if (!result.success) {
      this.deps.dialogs.notice(t('file.createFailed'), result.error ?? t('common.unknownError'))
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
      this.deps.dialogs.notice(t('file.renameFailed'), result.error ?? t('common.unknownError'))
      return
    }
    // Retarget whatever is actually showing this file. An id spelled from the old
    // path may belong to no tab (one opened alongside a detached tab, or saved
    // through Save As), or worse to a detached tab that only looks like it —
    // pointing that one at the renamed file would let a later save overwrite it
    // with recovered text.
    for (const oldId of this.deps.ctx.fileTabIds(file.path)) {
      const newId = this.freeTabId(result.path)
      this.deps.ctx.retargetFileTab(oldId, newId, result.name, result.path)
      this.deps.queries.renameTab(oldId, newId)
    }
    void this.deps.files.reload()
  }

  requestDelete(path: string, name: string) {
    this.deps.dialogs.confirm = {
      message: t('file.deletePrompt', { name }),
      detail: t('file.deleteTrashDetail'),
      confirmLabel: t('file.moveToTrash'),
      danger: true,
      action: () => void this.performDelete(path),
    }
  }

  private async performDelete(targetPath: string) {
    const result = await window.sqlkit.deleteFile(targetPath)
    if (!result.success) {
      this.deps.dialogs.notice(t('file.deleteFailed'), result.error ?? t('common.unknownError'))
      return
    }
    this.deps.ctx.closeFilesUnder(targetPath)
    this.deps.sweepOrphanTabState()
    void this.deps.files.reload()
  }
}
