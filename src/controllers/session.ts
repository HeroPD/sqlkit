import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { SessionContext, WorkspaceSession } from '../electron'
import { recoverableContexts } from '../session-recovery'

// A tab's buffer as it should come back: what the editor shows, what the file
// held, and where it lives now (null once its file has gone missing).
export type RestoredBuffer = { content: string; savedContent: string; path: string | null }

export type RestoredSession = {
  contexts: SessionContext[]
  buffers: Map<string, RestoredBuffer>
  /** The last session never got a clean shutdown. Nothing surfaces this today —
   * the restore is silent — but it is what the session file records about how
   * the app last went down. */
  unclean: boolean
}

type Deps = {
  /** Every context's tabs, ready to persist. Built only when a write is due. */
  snapshot: () => SessionContext[]
  /** The text of every tab a backup has to hold, keyed by tab id. Read at write
   * time so a tab whose content never went through an editor event — a browse or
   * History pick, a restored tab — still reaches disk. */
  buffers: () => Map<string, string>
  /** False on the welcome screen — there is no workspace to write into. */
  enabled: () => boolean
  /** A tab's buffer could not be mirrored, and retrying is done. Crash
   * protection has quietly stopped for it, which is worth saying out loud. */
  onBackupFailed?: (tabId: string) => void
}

// Layout changes (open, close, reorder, switch) are cheap and infrequent.
const LAYOUT_DEBOUNCE_MS = 300
// A refused buffer write is worth a couple of retries — a full disk clears, a
// buffer past the size cap never will, and retrying it forever is just noise.
const BACKUP_RETRY_MS = 2_000
const BACKUP_ATTEMPTS = 3
// Buffers wait for a pause in typing, but never longer than the max — otherwise
// a long uninterrupted burst of edits would sit unwritten the whole time.
const BUFFER_IDLE_MS = 750
const BUFFER_MAX_WAIT_MS = 5_000

// Hot exit, renderer side: mirrors the open tabs and their unsaved buffers to
// the workspace so a crash costs at most the last few keystrokes. The writes are
// continuous by design — a save-on-quit design does nothing when the process is
// killed outright, which is the case this exists for.
export class SessionController implements ReactiveController {
  private deps: Deps

  // Bumped on every workspace switch: a write that was already in flight must
  // not land in the workspace the user just moved to.
  private generation = 0
  private layoutTimer: ReturnType<typeof setTimeout> | null = null
  // The last session JSON written, so an unchanged layout costs no IPC.
  private lastWritten: string | null = null

  private pending = new Map<string, string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private waitingSince = new Map<string, number>()
  // What each tab's backup file is believed to hold, so an unchanged buffer
  // costs no write and a never-typed-in tab is written exactly once.
  private written = new Map<string, string>()
  // Consecutive failed attempts at one tab's current text.
  private attempts = new Map<string, { content: string; count: number }>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  private unsubscribeFlush: (() => void) | null = null
  private onPageHide = () => this.flushSync()

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.deps = deps
    host.addController(this)
  }

  hostConnected() {
    // Main asks for this right before quitting; `pagehide` covers a window
    // closing on its own. Both go through the synchronous path — an async write
    // started during teardown never lands.
    this.unsubscribeFlush = window.sqlkit.onFlushSession(() => this.flushSync())
    window.addEventListener('pagehide', this.onPageHide)
  }

  hostDisconnected() {
    this.unsubscribeFlush?.()
    this.unsubscribeFlush = null
    window.removeEventListener('pagehide', this.onPageHide)
    this.clearTimers()
  }

  /** A workspace is closing or switching: abandon pending writes for it. */
  reset() {
    this.generation += 1
    this.clearTimers()
    this.written.clear()
    this.lastWritten = null
  }

  /** Something about the tab layout may have changed. Cheap to over-call: the
   * snapshot is built once per debounce window and skipped when identical. */
  scheduleLayoutWrite() {
    if (this.layoutTimer || !this.deps.enabled()) return
    this.layoutTimer = setTimeout(() => void this.writeLayout(), LAYOUT_DEBOUNCE_MS)
  }

  /** An editor buffer changed. `needsBackup` is false once the tab's content is
   * fully represented by its file, which is when the backup is dropped. */
  noteBufferChange(tabId: string, content: string, needsBackup: boolean) {
    if (!this.deps.enabled()) return
    if (!needsBackup) {
      this.cancelBuffer(tabId)
      this.written.delete(tabId)
      void window.sqlkit.dropSessionBackup(tabId).catch(() => {})
      return
    }
    this.pending.set(tabId, content)
    const existing = this.timers.get(tabId)
    if (existing) clearTimeout(existing)
    const since = this.waitingSince.get(tabId) ?? Date.now()
    this.waitingSince.set(tabId, since)
    const wait = Math.max(0, Math.min(BUFFER_IDLE_MS, since + BUFFER_MAX_WAIT_MS - Date.now()))
    this.timers.set(tabId, setTimeout(() => void this.writeBuffer(tabId), wait))
  }

  /** The tab was closed or its file deleted — nothing left to restore. */
  dropBuffer(tabId: string) {
    this.cancelBuffer(tabId)
    this.written.delete(tabId)
    if (!this.deps.enabled()) return
    void window.sqlkit.dropSessionBackup(tabId).catch(() => {})
  }

  /** The workspace is being closed. Main still points at it — it clears the
   * path only once this write returns — so the tabs about to be wiped can go to
   * disk from here, synchronously, before they are gone. A *switch* is flushed
   * by main before the swap instead: by the time the renderer hears about it,
   * main points at the new workspace and this write would file the old
   * workspace's tabs under it. */
  flushOutgoing() {
    this.writeSync()
  }

  /** Reads back the last session and every buffer it claims. */
  async hydrate(): Promise<RestoredSession | null> {
    const gen = this.generation
    const session = await window.sqlkit.readSession().catch(() => null)
    // The workspace changed under us, or there is nothing to restore.
    if (!session || this.generation !== gen || !session.contexts.length) return null

    const buffers = new Map<string, RestoredBuffer>()
    const sqlTabs = session.contexts.flatMap((context) => context.tabs.filter((tab) => tab.kind === 'sql'))

    // Each entry carries whether its text came off a backup file, so `written`
    // can be seeded with what is already on disk.
    const resolved = await Promise.all(sqlTabs.map(async (tab) => {
      // Untitled tabs are only ever held by their backup, dirty or not: a
      // browse or History tab has no file to fall back to.
      const claimsBackup = tab.path === null || tab.dirty === true
      const [backup, saved] = await Promise.all([
        claimsBackup ? window.sqlkit.readSessionBackup(tab.id).catch(() => null) : Promise.resolve(null),
        tab.path ? window.sqlkit.readFile(tab.path).catch(() => null) : Promise.resolve(null),
      ])
      if (tab.path) {
        // The file is still there: it is the baseline, and the backup (when one
        // exists) is the work that had not reached it yet.
        if (saved?.success) {
          return [tab.id, { content: backup ?? saved.content, savedContent: saved.content, path: tab.path }, backup !== null] as const
        }
        // Deleted or unreadable since. Unsaved work still comes back, as an
        // untitled tab; with nothing buffered there is nothing left to show.
        return backup === null ? null : [tab.id, { content: backup, savedContent: '', path: null }, true] as const
      }
      const content = backup ?? ''
      // A clean untitled tab (a browse or History pick) restores unmarked; one
      // that was edited keeps its marker, with an empty baseline behind it.
      return [tab.id, { content, savedContent: tab.dirty ? '' : content, path: null }, backup !== null] as const
    }))

    if (this.generation !== gen) return null
    for (const entry of resolved) {
      if (!entry) continue
      const [tabId, buffer, fromBackup] = entry
      buffers.set(tabId, buffer)
      // That backup is on disk right now. Without recording it, the first write
      // after a restore treats the text as unbacked — and if that write fails,
      // drops the tab and prunes away the only copy of it.
      if (fromBackup) this.written.set(tabId, buffer.content)
    }

    return {
      contexts: session.contexts,
      buffers,
      unclean: session.unclean === true,
    }
  }

  private async writeLayout() {
    this.layoutTimer = null
    if (!this.deps.enabled()) return
    const gen = this.generation
    // Buffers first: writing the session prunes every backup no tab claims, so
    // one this snapshot is about to claim has to be on disk by then.
    const unbacked = await this.reconcileBuffers()
    if (this.generation !== gen) return
    const session: WorkspaceSession = { version: 1, contexts: recoverableContexts(this.deps.snapshot(), unbacked) }
    const serialized = JSON.stringify(session)
    if (serialized === this.lastWritten) return
    this.lastWritten = serialized
    const result = await window.sqlkit.writeSession(session).catch(() => null)
    if (this.generation !== gen) return
    // A failed write must not be remembered as written, or the next identical
    // snapshot would skip the retry.
    if (!result?.success) this.lastWritten = null
  }

  // Writes the buffers the session is about to claim but that aren't known to be
  // on disk. A tab mid-typing is left to its own debounce, which holds newer
  // text than the snapshot does. Returns the tabs whose text is nowhere on disk
  // afterwards, so the session about to be written can leave them out.
  private async reconcileBuffers(): Promise<Set<string>> {
    const buffers = this.deps.buffers()
    const due = [...buffers].filter(([tabId, content]) =>
      !this.pending.has(tabId) && this.written.get(tabId) !== content && this.worthRetrying(tabId, content))
    await Promise.all(due.map(([tabId, content]) => this.writeBuffer(tabId, content)))
    const unbacked = new Set<string>()
    // A queued write counts as covered: it lands within the second, and the
    // shutdown paths flush it. Only a tab with nothing written and nothing
    // queued has no copy of its text anywhere.
    for (const tabId of buffers.keys()) {
      if (!this.written.has(tabId) && !this.pending.has(tabId)) unbacked.add(tabId)
    }
    return unbacked
  }

  private worthRetrying(tabId: string, content: string) {
    const attempt = this.attempts.get(tabId)
    return !attempt || attempt.content !== content || attempt.count < BACKUP_ATTEMPTS
  }

  private scheduleRetry() {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.scheduleLayoutWrite()
    }, BACKUP_RETRY_MS)
  }

  private async writeBuffer(tabId: string, text?: string) {
    const content = text ?? this.pending.get(tabId)
    if (text === undefined) this.cancelBuffer(tabId)
    if (content === undefined || !this.deps.enabled()) return
    const gen = this.generation
    const result = await window.sqlkit.writeSessionBackup(tabId, content).catch(() => null)
    if (this.generation !== gen) return
    if (result?.success) {
      this.written.set(tabId, content)
      this.attempts.delete(tabId)
      return
    }
    // Refused. Whatever older text is already on disk for this tab stays — it is
    // still the user's work, just behind — but this attempt is not recorded as
    // written, so the session cannot describe text that isn't there.
    const attempt = this.attempts.get(tabId)
    const count = attempt?.content === content ? attempt.count + 1 : 1
    this.attempts.set(tabId, { content, count })
    this.lastWritten = null
    if (count < BACKUP_ATTEMPTS) this.scheduleRetry()
    else this.deps.onBackupFailed?.(tabId)
  }

  // The synchronous last gasp. Everything here is already covered by the
  // debounced writes; this only catches keystrokes newer than the last one.
  private flushSync() {
    this.writeSync(this.deps.enabled())
  }

  // `hasWorkspace` is false only when there is nothing to write — on the
  // welcome screen. The call still goes out: main waits on this reply before it
  // lets the app quit.
  private writeSync(hasWorkspace = true) {
    const backups = hasWorkspace ? this.dueBackups() : []
    // Sent unfiltered: only main learns whether these backups land, so it is
    // main that drops the claims of the ones that don't.
    const session = hasWorkspace ? { version: 1 as const, contexts: this.deps.snapshot() } : undefined
    this.clearTimers()
    window.sqlkit.flushSession({ session, backups })
  }

  // Everything the session file is about to claim that isn't known to be on
  // disk: the debounce queue, plus any buffer no editor event ever reported.
  private dueBackups() {
    const due = new Map(
      [...this.deps.buffers()].filter(([tabId, content]) => this.written.get(tabId) !== content),
    )
    for (const [tabId, content] of this.pending) due.set(tabId, content)
    // Not recorded as written: nothing here reports back, and claiming a write
    // landed when it may not have is the one thing `written` must never do.
    return [...due].map(([tabId, content]) => ({ tabId, content }))
  }

  private cancelBuffer(tabId: string) {
    const timer = this.timers.get(tabId)
    if (timer) clearTimeout(timer)
    this.timers.delete(tabId)
    this.pending.delete(tabId)
    this.waitingSince.delete(tabId)
  }

  private clearTimers() {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.pending.clear()
    this.waitingSince.clear()
    this.attempts.clear()
    if (this.layoutTimer) clearTimeout(this.layoutTimer)
    this.layoutTimer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
