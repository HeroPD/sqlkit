import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile, DbObject, DbObjectKind, FileSaveResult, TableRef } from '../electron'

// An editor tab: a connection-config form (the tab owns the unsaved draft, so
// edits survive switching tabs) or a SQL editor over a workspace file —
// path is null for untitled queries until the first save.
export type SqlTabState = {
  id: string
  kind: 'sql'
  name: string
  path: string | null
  content: string
  savedContent: string
  // VS Code-style preview tab: single-click opens recycle it instead of
  // stacking tabs. Editing or double-clicking promotes it to permanent.
  preview?: boolean
}

export type EditorTabState =
  | { id: string; kind: 'config'; profile: ConnectionProfile }
  | { id: string; kind: 'inspect'; profileId: string; table: TableRef }
  | { id: string; kind: 'inspect-object'; profileId: string; object: DbObject; objectKind: DbObjectKind }
  | SqlTabState

// A context's working instance: open tabs, the active tab, and the Explorer's
// table selection.
type ContextInstance = {
  tabs: EditorTabState[]
  activeTabId: string | null
  selectedTable: string | null
}

type Deps = {
  contextKey: (profileId: string | null, childDb: string | null) => string
  dropQuery: (tabId: string) => void
}

// Owns the workbench's per-context working state: the open tabs, the active
// tab, the Explorer's selected table, and the in-use context (⌘K) — a profile
// *and* its child database. Each context (x1/analytics vs x1/billing) is its
// own instance; switching stashes the live fields and restores the target's.
// Fields use get/set so assigning re-renders the host, exactly like the @state
// they replaced. Query results live in the QueriesController, keyed by tab id,
// so they follow their tab through any switch.
export class ContextsController {
  private _tabs: EditorTabState[] = []
  private _activeTabId: string | null = null
  private _activeDbId: string | null = null
  private _activeChildDb: string | null = null
  private _selectedTable: string | null = null
  private _instances = new Map<string, ContextInstance>()

  private host: ReactiveControllerHost
  private deps: Deps

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
  }

  get tabs() {
    return this._tabs
  }
  set tabs(value: EditorTabState[]) {
    this._tabs = value
    this.host.requestUpdate()
  }

  get activeTabId() {
    return this._activeTabId
  }
  set activeTabId(value: string | null) {
    this._activeTabId = value
    this.host.requestUpdate()
  }

  get activeDbId() {
    return this._activeDbId
  }
  set activeDbId(value: string | null) {
    this._activeDbId = value
    this.host.requestUpdate()
  }

  get activeChildDb() {
    return this._activeChildDb
  }
  set activeChildDb(value: string | null) {
    this._activeChildDb = value
    this.host.requestUpdate()
  }

  get selectedTable() {
    return this._selectedTable
  }
  set selectedTable(value: string | null) {
    this._selectedTable = value
    this.host.requestUpdate()
  }

  // Workspace close: drop every context's state.
  reset() {
    this._tabs = []
    this._activeTabId = null
    this._activeDbId = null
    this._activeChildDb = null
    this._selectedTable = null
    this._instances.clear()
    this.host.requestUpdate()
  }

  // Swaps the working instance: stashes the live tabs/selection under the
  // outgoing context and restores (or initializes) the incoming one.
  switchInstance(profileId: string | null, childDb: string | null) {
    const fromKey = this.deps.contextKey(this._activeDbId, this._activeChildDb)
    const toKey = this.deps.contextKey(profileId, childDb)
    if (fromKey === toKey) return

    this._instances.set(fromKey, {
      tabs: this._tabs,
      activeTabId: this._activeTabId,
      selectedTable: this._selectedTable,
    })

    this._activeDbId = profileId
    this._activeChildDb = childDb
    const incoming = this._instances.get(toKey)
    this._tabs = incoming?.tabs ?? []
    this._activeTabId = incoming?.activeTabId ?? null
    this._selectedTable = incoming?.selectedTable ?? null
    this.host.requestUpdate()
  }

  // Includes stashed instances: a run that finished for a tab the user has
  // since switched away from still belongs to a live tab.
  tabExists(id: string): boolean {
    if (this._tabs.some((tab) => tab.id === id)) return true
    for (const instance of this._instances.values()) {
      if (instance.tabs.some((tab) => tab.id === id)) return true
    }
    return false
  }

  activeSqlTab(): SqlTabState | null {
    const tab = this._tabs.find((entry) => entry.id === this._activeTabId)
    return tab?.kind === 'sql' ? tab : null
  }

  // Appends a tab (if not already open) and makes it active.
  addTab(tab: EditorTabState) {
    if (!this._tabs.some((entry) => entry.id === tab.id)) this.tabs = [...this._tabs, tab]
    this.activeTabId = tab.id
  }

  openConfigTab(profile: ConnectionProfile) {
    this.addTab({ id: profile.id, kind: 'config', profile: { ...profile } })
  }

  newQuery() {
    const untitled = this._tabs.filter((tab) => tab.kind === 'sql' && tab.path === null).length
    this.addTab({
      id: crypto.randomUUID(),
      kind: 'sql',
      name: `Untitled-${untitled + 1}`,
      path: null,
      content: '',
      savedContent: '',
    })
  }

  closeTab(id: string) {
    const index = this._tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return

    this.tabs = this._tabs.filter((tab) => tab.id !== id)
    this.deps.dropQuery(id)
    if (this._activeTabId === id) {
      this.activeTabId = this._tabs[Math.min(index, this._tabs.length - 1)]?.id ?? null
    }
  }

  applySaveResult(tab: SqlTabState, result: FileSaveResult) {
    if (!result.success) {
      if (!result.canceled) console.error('Save failed:', result.error)
      return
    }
    this.tabs = this._tabs.map((entry) =>
      entry.id === tab.id && entry.kind === 'sql'
        ? { ...entry, path: result.path, name: result.name, savedContent: tab.content }
        : entry,
    )
  }

  // Editing promotes a preview tab to permanent (VS Code behavior) — a later
  // history pick must not recycle away someone's edits.
  setActiveContent(value: string) {
    this.tabs = this._tabs.map((tab) =>
      tab.id === this._activeTabId && tab.kind === 'sql' ? { ...tab, content: value, preview: false } : tab,
    )
  }

  // A dropped child database takes its stashed working context with it.
  dropInstance(key: string) {
    this._instances.delete(key)
  }

  // Removing a connection: drop its stashed contexts and scrub its config tab
  // (id === profileId) from the live strip and every other context's stash.
  removeProfile(profileId: string) {
    for (const key of [...this._instances.keys()]) {
      if (key.startsWith(`${profileId}:`)) this._instances.delete(key)
    }
    this.tabs = this._tabs.filter((tab) => tab.id !== profileId)
    if (this._activeTabId === profileId) this.activeTabId = this._tabs[this._tabs.length - 1]?.id ?? null
    for (const [key, instance] of this._instances) {
      if (!instance.tabs.some((tab) => tab.id === profileId)) continue
      this._instances.set(key, {
        ...instance,
        tabs: instance.tabs.filter((tab) => tab.id !== profileId),
        activeTabId: instance.activeTabId === profileId ? null : instance.activeTabId,
      })
    }
  }

  // History single-click: recycle the open preview tab to this SQL, else open
  // a fresh preview tab.
  openPreview(sql: string) {
    const preview = this._tabs.find((tab) => tab.kind === 'sql' && tab.preview)
    if (preview) {
      this.tabs = this._tabs.map((tab) =>
        tab.id === preview.id && tab.kind === 'sql' ? { ...tab, content: sql, savedContent: sql } : tab,
      )
      this.activeTabId = preview.id
      return
    }
    this.addTab({ id: crypto.randomUUID(), kind: 'sql', name: 'History.sql', path: null, content: sql, savedContent: sql, preview: true })
  }
}
