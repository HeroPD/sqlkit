import type { ReactiveControllerHost } from 'lit'
import type { ConnectionProfile } from '../electron'
import type { ConnectionsController } from './connections'
import type { DialogsController } from './dialogs'
import { t } from '../i18n'

type Deps = {
  // Live connection statuses, read to resolve which child a profile targets.
  live: ConnectionsController
  dialogs: DialogsController
  activeDbId: () => string | null
}

// Owns the workspace's saved connection profiles (.sqlkit/config.json): the
// list, its load/persist/save round trips, profile lookups, and resolving the
// child database a profile should target. Distinct from ConnectionsController,
// which owns the *live* connections. Setting `connections` re-renders the host.
export class ConfigController {
  private _connections: ConnectionProfile[] = []
  private host: ReactiveControllerHost
  private deps: Deps
  /** Warn about unencrypted-at-rest secrets at most once per workspace open. */
  private _warnedUnencrypted = false

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
  }

  get connections() {
    return this._connections
  }
  set connections(value: ConnectionProfile[]) {
    this._connections = value
    this.host.requestUpdate()
  }

  // Workspace close: forget the loaded profiles.
  reset() {
    this.connections = []
    this._warnedUnencrypted = false
  }

  byId(id: string | null): ConnectionProfile | null {
    return id ? (this._connections.find((connection) => connection.id === id) ?? null) : null
  }

  /** The profile of the in-use database context (⌘K). */
  activeProfile(): ConnectionProfile | null {
    return this.byId(this.deps.activeDbId())
  }

  /** A blank profile for the "Add Database" form. */
  newProfile(): ConnectionProfile {
    return {
      id: crypto.randomUUID(),
      name: '',
      labelColor: 'accent-04',
      engine: 'postgresql',
      host: 'localhost',
      port: '5432',
      username: '',
      password: '',
      database: '',
      file: '',
      folder: '',
    }
  }

  /** The child the connection currently targets, when it has several. */
  inUseChild(profileId: string): string | null {
    const children = this.deps.live.statuses[profileId]?.children ?? []
    if (children.length < 2) return null
    return children.find((child) => child.inUse)?.name ?? null
  }

  // An all-databases context always resolves to a child — the parent folder
  // never holds files. Preference order: the connection's live child, the
  // last child the user worked in, then the discovery database.
  defaultChild(profile: ConnectionProfile): string | null {
    if ((profile.databaseMode ?? 'single') !== 'all') return null
    const discoveryDefault = profile.engine === 'sqlserver' ? 'master' : profile.engine === 'mysql' ? null : 'postgres'
    return this.inUseChild(profile.id) ?? profile.lastChildDb ?? (profile.database.trim() || discoveryDefault)
  }

  // Reads the workspace config from disk, sets the profile list, and returns
  // the context to restore: the saved active profile (or the first one) and its
  // default child. A read error is surfaced; the on-disk file is left untouched.
  async load(): Promise<{ profileId: string | null; child: string | null }> {
    const { config, error, unencryptedSecrets, weakCredentialStorage } = await window.sqlkit.getWorkspaceConfig()
    if (error) this.deps.dialogs.notice(t('config.readFailed'), `${error}\n\n${t('config.readRecovery')}`)
    // Fires on open and after every save (via _loadConfig), so this one spot
    // covers the open-migration and persist() re-saves too; shown once a session.
    if (unencryptedSecrets && !this._warnedUnencrypted) {
      this._warnedUnencrypted = true
      this.deps.dialogs.notice(t('config.unencryptedTitle'), t('config.unencryptedDetail'))
    } else if (weakCredentialStorage && !this._warnedUnencrypted) {
      this._warnedUnencrypted = true
      this.deps.dialogs.notice(t('config.weakStorageTitle'), t('config.weakStorageDetail'))
    }
    this.connections = config.connections
    const restored =
      config.activeDbId && config.connections.some((connection) => connection.id === config.activeDbId)
        ? config.activeDbId
        : (config.connections[0]?.id ?? null)
    const profile = this.byId(restored)
    return { profileId: restored, child: profile ? this.defaultChild(profile) : null }
  }

  persist() {
    void window.sqlkit.saveWorkspaceConfig({
      version: 1,
      connections: this._connections,
      activeDbId: this.deps.activeDbId(),
    }).then((result) => {
      if (!result.success) this.deps.dialogs.notice(t('config.saveFailed'), result.error)
    }).catch((error: unknown) => this.deps.dialogs.notice(t('config.saveFailed'), (error as Error).message))
  }

  // Upserts a profile and writes the config; the caller re-reads via load() to
  // pick up the files folder the save assigned. Returns whether the write stuck.
  async save(profile: ConnectionProfile): Promise<boolean> {
    const existing = this._connections.findIndex((connection) => connection.id === profile.id)
    const connections =
      existing >= 0
        ? this._connections.map((connection) => (connection.id === profile.id ? profile : connection))
        : [...this._connections, profile]
    const result = await window.sqlkit.saveWorkspaceConfig({ version: 1, connections, activeDbId: this.deps.activeDbId() })
    if (!result.success) {
      console.error('Failed to save workspace config:', result.error)
      return false
    }
    // The caller re-reads via _loadConfig, so the unencrypted-secrets warning is
    // raised there (load) — one source for it, covering open and persist too.
    return true
  }

  remove(id: string) {
    this.connections = this._connections.filter((connection) => connection.id !== id)
  }

  // Remembers the child a context switched to, so reopening lands on it.
  setLastChildDb(profileId: string, child: string) {
    if (this.byId(profileId)?.lastChildDb === child) return
    this.connections = this._connections.map((connection) =>
      connection.id === profileId ? { ...connection, lastChildDb: child } : connection,
    )
  }

  // Forgets a remembered child after it's dropped on the server. Returns
  // whether anything changed, so the caller can persist only when needed.
  clearLastChildDb(profileId: string, database: string): boolean {
    if (!this._connections.some((connection) => connection.id === profileId && connection.lastChildDb === database)) {
      return false
    }
    this.connections = this._connections.map((connection) =>
      connection.id === profileId && connection.lastChildDb === database
        ? { ...connection, lastChildDb: undefined }
        : connection,
    )
    return true
  }
}
