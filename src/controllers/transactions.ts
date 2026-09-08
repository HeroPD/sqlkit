import type { ReactiveController, ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, QueryResponse } from '../electron'

/** One statement run inside a manual transaction, as the session panel shows it. */
export type TransactionRun = {
  sql: string
  tabName: string
  success: boolean
  durationMs: number
  rowCount: number | null
  error: string
  createdAt: string
}

export type TransactionSession = {
  childDb: string
  startedAt: string
  runs: TransactionRun[]
}

/** An open manual transaction as the live connection reports it. */
export type OpenTransaction = { childDb: string; failed?: boolean }

export type TransactionOwner = { profile: ConnectionProfile; transaction: OpenTransaction }

const MAX_RUNS = 100

type Deps = {
  connections: () => ConnectionProfile[]
  activeProfile: () => ConnectionProfile | null
  profileById: (profileId: string) => ConnectionProfile | null
  /** The open manual transaction on a connection, from its live status. */
  openOn: (profileId: string) => OpenTransaction | undefined
  endTransaction: (profileId: string, mode: 'commit' | 'rollback') => Promise<{ success: boolean; transaction?: unknown; error?: string }>
  /** Where a transaction-guard failure is shown — the same place run errors are. */
  notice: (message: string) => void
  setActiveDb: (profileId: string, childDb: string) => void
}

/** Manual transactions as the workbench presents them: which connections hold
 * one, what has run inside it, and the popovers that show it. The live
 * open/closed truth stays with the connection status this reads through
 * `openOn`; what is held here is the session history and disclosure state that
 * only the UI has.
 *
 * Every mutation requests a host update by hand — a controller has no @state().
 */
export class TransactionsController implements ReactiveController {
  private readonly host: ReactiveControllerHost
  private readonly deps: Deps
  private _sessions = new Map<string, TransactionSession>()
  private _popoverProfileId: string | null = null
  private _managerOpen = false
  private _expandedProfileIds = new Set<string>()

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
    host.addController(this)
  }

  // Transient disclosure only: a host that goes away takes its popovers with it,
  // while the sessions stay for when it comes back.
  hostDisconnected() {
    this.closePopovers()
  }

  /** Connections holding an open manual transaction right now. */
  owners(): TransactionOwner[] {
    return this.deps.connections().flatMap((profile) => {
      const transaction = this.deps.openOn(profile.id)
      return transaction ? [{ profile, transaction }] : []
    })
  }

  /** The connection a keyboard commit/rollback means: the active one when it
   * holds a transaction, else the only one that does. */
  openProfile(): ConnectionProfile | null {
    const active = this.deps.activeProfile()
    if (active && this._sessions.has(active.id)) return active
    const open = [...this._sessions.keys()]
    const only = open.length === 1 ? open[0] : undefined
    return only ? this.deps.profileById(only) : null
  }

  sessionFor(profileId: string): TransactionSession | undefined {
    return this._sessions.get(profileId)
  }

  runsFor(profileId: string): TransactionRun[] {
    return this._sessions.get(profileId)?.runs ?? []
  }

  get popoverProfileId(): string | null {
    return this._popoverProfileId
  }

  get managerOpen(): boolean {
    return this._managerOpen
  }

  isExpanded(profileId: string): boolean {
    return this._expandedProfileIds.has(profileId)
  }

  /** Opens one connection's session popover, closing the manager behind it. */
  togglePopover(profileId: string) {
    const open = this._popoverProfileId === profileId
    this._popoverProfileId = open ? null : profileId
    if (!open) this._managerOpen = false
    this.host.requestUpdate()
  }

  toggleManager(open = !this._managerOpen) {
    this._managerOpen = open
    if (open) this._popoverProfileId = null
    this.host.requestUpdate()
  }

  toggleExpanded(profileId: string) {
    const next = new Set(this._expandedProfileIds)
    if (next.has(profileId)) next.delete(profileId)
    else next.add(profileId)
    this._expandedProfileIds = next
    this.host.requestUpdate()
  }

  switchTo(profileId: string, childDb: string) {
    this.toggleManager(false)
    this.deps.setActiveDb(profileId, childDb)
  }

  /** Whether anything is open to dismiss — what a host's Escape handler asks. */
  get anyPopoverOpen(): boolean {
    return this._popoverProfileId !== null || this._managerOpen
  }

  closePopovers() {
    if (!this.anyPopoverOpen) return
    this._popoverProfileId = null
    this._managerOpen = false
    this.host.requestUpdate()
  }

  /** Dismisses the popovers on a click outside them. */
  dismissOnPointerDown(event: PointerEvent) {
    if (!this.anyPopoverOpen) return
    const inside = event.composedPath().some(
      (node) => node instanceof HTMLElement && (node.classList.contains('txn-control') || node.classList.contains('txn-overflow')),
    )
    if (!inside) this.closePopovers()
  }

  /** Closes a popover whose transaction or connection is no longer on screen —
   * an open disclosure over nothing would keep claiming a session exists. */
  reconcile() {
    if (this._popoverProfileId
      && (this._popoverProfileId !== this.deps.activeProfile()?.id || !this.deps.openOn(this._popoverProfileId))) {
      this._popoverProfileId = null
      this.host.requestUpdate()
    }
    if (!this._managerOpen) return
    const activeProfileId = this.deps.activeProfile()?.id
    if (this.owners().every((owner) => owner.profile.id === activeProfileId)) this.toggleManager(false)
  }

  reset() {
    this._sessions = new Map()
    this._popoverProfileId = null
    this._managerOpen = false
    this._expandedProfileIds = new Set()
    this.host.requestUpdate()
  }

  /** Records what a run did to a connection's manual transaction: opens a
   * session, appends to it, or drops it when the transaction ended. */
  recordRun(args: {
    profileId: string
    childDb: string
    sourceTabName: string
    sql: string
    response: QueryResponse
    runStartedAt: number
    wasOpen: boolean
    isOpen: boolean
    /** The run closed the previous transaction (even if a new one is open). */
    restarted: boolean
  }) {
    if (!args.isOpen) {
      if (args.wasOpen && this._sessions.has(args.profileId)) {
        const next = new Map(this._sessions)
        next.delete(args.profileId)
        this._sessions = next
        if (this._popoverProfileId === args.profileId) this._popoverProfileId = null
        this.host.requestUpdate()
      }
      return
    }

    const existing = args.wasOpen && !args.restarted ? this._sessions.get(args.profileId) : undefined
    const session = existing?.childDb === args.childDb
      ? existing
      : { childDb: args.childDb, startedAt: new Date(args.runStartedAt).toISOString(), runs: [] }
    const run: TransactionRun = {
      sql: args.sql.slice(0, 10_000),
      tabName: args.sourceTabName,
      success: args.response.success,
      durationMs: args.response.success ? args.response.result.durationMs : Math.max(1, Date.now() - args.runStartedAt),
      rowCount: args.response.success ? args.response.result.rowCount : null,
      error: args.response.success ? '' : args.response.error,
      createdAt: new Date().toISOString(),
    }
    const next = new Map(this._sessions)
    next.set(args.profileId, { ...session, runs: [...session.runs, run].slice(-MAX_RUNS) })
    this._sessions = next
    this.host.requestUpdate()
  }

  /** Commits or rolls back, dropping the session only once nothing is left open
   * (a nested SQL Server commit leaves the outer transaction running). */
  async end(profileId: string, mode: 'commit' | 'rollback') {
    const result = await this.deps.endTransaction(profileId, mode)
    if (result.success && !result.transaction) {
      const next = new Map(this._sessions)
      next.delete(profileId)
      this._sessions = next
      this._popoverProfileId = null
      if (this._expandedProfileIds.has(profileId)) {
        const expanded = new Set(this._expandedProfileIds)
        expanded.delete(profileId)
        this._expandedProfileIds = expanded
      }
      this.host.requestUpdate()
    }
    // Surface a failure where run errors already show; the control itself stays
    // truthful through the status rebroadcast.
    if (!result.success && result.error) this.deps.notice(result.error)
  }
}

/** One run's SQL, flattened to a single line for the session list. */
export const summarizeTransactionSql = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 180)
