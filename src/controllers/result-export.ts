import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { QueryResult } from '../electron'
import { bufferedExport, type ExportFormat, type SqlExportTarget } from '../result-export'
import { MAX_FETCH_ROWS } from '../result-limits'
import { formatInteger, t } from '../i18n'

type Deps = {
  /** The result on screen, whose buffer the rows are drained from. */
  result: () => QueryResult | null
  /** Where the SQL format's INSERTs are aimed. */
  sqlTarget: () => SqlExportTarget
  /** Result columns holding JSON documents, spliced into a JSON export raw. */
  jsonColumns: () => ReadonlySet<number>
  /** A full streamed export re-runs the query in the main process, which needs
   * the query context (profile / child database / sort) the grid does not have. */
  streamExport: (format: ExportFormat) => void
  notice: (title: string, detail: string) => void
}

/** What a drain came back with. `complete` is false when the result buffer
 * expired part-way — evicted, or its connection dropped — and `rows` then holds
 * only what survived, short of the `expected` rows that were promised. */
export type DrainedRows = { rows: unknown[][]; complete: boolean; expected: number }

type ExportSnapshot = {
  result: QueryResult
  columns: string[]
  sqlTarget: SqlExportTarget
  jsonColumns: ReadonlySet<number>
}

/** Getting a result out of the grid: the export dialog's open state, draining
 * the buffered rows behind it, and writing the file. Held apart from the grid
 * because none of it is about showing rows — the panel only renders the dialog
 * and the draining progress this reports.
 *
 * Like every controller here, state changes request a host update by hand:
 * there is no @state() reactivity outside the component. */
export class ResultExportController implements ReactiveController {
  private readonly host: ReactiveControllerHost
  private readonly deps: Deps
  private _dialogOpen = false
  private _draining: { done: number; total: number } | null = null

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
    host.addController(this)
  }

  hostDisconnected() {
    this._draining = null
  }

  get dialogOpen(): boolean {
    return this._dialogOpen
  }

  set dialogOpen(open: boolean) {
    if (this._dialogOpen === open) return
    this._dialogOpen = open
    this.host.requestUpdate()
  }

  /** How far a drain has got, for the status line; null when none is running. */
  get draining(): { done: number; total: number } | null {
    return this._draining
  }

  /** Buffered rows up to `limit` (default: all) — the loaded prefix plus
   * whatever pages haven't been scrolled into yet — so export / copy-all aren't
   * limited to what's on screen. Exporting N rows only pulls N, not the whole
   * buffer, which is what keeps the cap on memory. */
  async rows(limit?: number): Promise<DrainedRows> {
    return this.drain(this.deps.result(), limit)
  }

  private async drain(result: QueryResult | null, limit?: number): Promise<DrainedRows> {
    if (!result) return { rows: [], complete: true, expected: 0 }
    const total = result.bufferedRowCount ?? result.rows.length
    const need = Math.min(limit ?? total, total)
    if (result.sessionId === undefined || result.rows.length >= need) {
      return { rows: result.rows, complete: true, expected: need }
    }
    const rows: unknown[][] = []
    this.setDraining({ done: 0, total: need })
    try {
      while (rows.length < need) {
        // Pages stay byte-capped main-side, so a short return just loops again.
        const response = await window.sqlkit.fetchRows(result.sessionId, rows.length, Math.min(MAX_FETCH_ROWS, need - rows.length))
        // The buffer is gone (evicted, or its connection dropped): hand back what
        // survived, marked short, not a prefix that reads as the whole result.
        if (!response.success) return { rows, complete: false, expected: need }
        // A buffer holding fewer rows than it claimed comes up short by the same rule.
        if (response.rows.length === 0) break
        rows.push(...response.rows)
        this.setDraining({ done: rows.length, total: need })
      }
      return { rows, complete: rows.length >= need, expected: need }
    } finally {
      this.setDraining(null)
    }
  }

  /** Every buffered row in one clipboard payload, or null when the buffer could
   * not give them all — a short copy is reported, never quietly pasted. */
  async copyAll(format: ExportFormat): Promise<string | null> {
    const snapshot = this.snapshot()
    if (!snapshot) return null
    const drained = await this.drain(snapshot.result)
    if (!drained.complete) {
      this.reportShort(t('results.copyExpiredDetail', this.counts(drained)))
      return null
    }
    return this.content(format, drained.rows, snapshot)
  }

  /** The export dialog's confirmation: stream the whole query, or write the
   * buffered rows to a file. */
  async confirm(detail: { format: ExportFormat; rows: number; stream: boolean }): Promise<void> {
    this.dialogOpen = false
    const { format, rows, stream } = detail
    if (stream) return this.deps.streamExport(format)
    const snapshot = this.snapshot()
    if (!snapshot) return
    const drained = await this.drain(snapshot.result, rows)
    // A file outlives the message about it: a short CSV named for the query would
    // read as the whole result long after the truncation is forgotten.
    if (!drained.complete) return this.reportShort(t('results.exportExpiredDetail', this.counts(drained)))
    const content = this.content(format, drained.rows.slice(0, rows), snapshot)
    // Main reports a refused write (a read-only folder, a full disk) and the
    // call itself can reject; either way the file the user asked for is not on
    // disk, so neither may pass silently. A cancelled dialog is not a failure —
    // the streamed path draws the same line.
    const outcome: { success: boolean; canceled?: boolean; error?: string } = await window.sqlkit
      .exportFile(`results.${format}`, content)
      .catch((error: unknown) => ({ success: false, error: (error as Error).message }))
    if (outcome.success || outcome.canceled) return
    this.deps.notice(t('workbench.exportFailed'), outcome.error ?? t('results.exportFailedUnknown'))
  }

  private counts(drained: DrainedRows) {
    return { loaded: formatInteger(drained.rows.length), total: formatInteger(drained.expected) }
  }

  private reportShort(detail: string) {
    this.deps.notice(t('results.bufferExpired'), detail)
  }

  private snapshot(): ExportSnapshot | null {
    const result = this.deps.result()
    if (!result) return null
    const target = this.deps.sqlTarget()
    return {
      result,
      columns: [...result.columns],
      sqlTarget: { engine: target.engine, table: target.table ? { ...target.table } : null },
      jsonColumns: new Set(this.deps.jsonColumns()),
    }
  }

  private content(format: ExportFormat, rows: unknown[][], snapshot: ExportSnapshot): string {
    return bufferedExport({
      format,
      columns: snapshot.columns,
      rows,
      sqlTarget: snapshot.sqlTarget,
      jsonColumns: snapshot.jsonColumns,
    })
  }

  private setDraining(progress: { done: number; total: number } | null) {
    this._draining = progress
    this.host.requestUpdate()
  }
}
