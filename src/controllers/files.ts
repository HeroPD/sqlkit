import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { FileInfo } from '../electron'

// Owns the file listing of the in-use database context's folder, kept fresh
// by the main-process watcher. Files belong to one context: only the active
// folder is ever listed, so .sql files never mix between databases.
export class FilesController implements ReactiveController {
  files: FileInfo[] = []

  private folder: string | null = null

  private host: ReactiveControllerHost
  private onChanged: (() => void) | null
  private unsubscribe: (() => void) | null = null

  constructor(host: ReactiveControllerHost, onChanged?: () => void) {
    this.host = host
    this.onChanged = onChanged ?? null
    host.addController(this)
  }

  hostConnected() {
    this.unsubscribe = window.sqlkit.onFilesChanged(() => {
      void this.reload()
      this.onChanged?.()
    })
  }

  hostDisconnected() {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Points the listing at a context folder (null = no context, empty list). */
  setFolder(folder: string | null) {
    this.folder = folder
    if (!folder) {
      this.files = []
      this.host.requestUpdate()
      return
    }
    void this.reload()
  }

  async reload() {
    const folder = this.folder
    if (!folder) return
    const result = await window.sqlkit.listFiles(folder)
    // A slow response for a context the user already switched away from must
    // not clobber the current listing.
    if (result.success && this.folder === folder) {
      this.files = result.files
      this.host.requestUpdate()
    }
  }
}
