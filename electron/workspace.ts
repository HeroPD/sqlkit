import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type {
  ConnectionProfile,
  HistoryItem,
  RecentWorkspace,
  SaveResult,
  WorkspaceConfig,
  WorkspaceConfigPatch,
  WorkspaceHistoryPatch,
  WorkspaceConfigResult,
  WorkspaceResult,
} from '../src/electron'
import type { ThemeId } from '../src/electron'
import {
  APP_SETTINGS_VERSION,
  DEFAULT_WORKSPACE_PREFERENCES,
  migrateAppSettings,
  normalizeAppSettings,
  normalizeWorkspacePreferences,
  type AppSettings,
} from '../src/settings'
import { DEFAULT_THEME, themeOrDefault } from '../src/themes'
import { workspaceConfig as validateWorkspaceConfig } from './ipc-validation'
import { limitHistory } from '../src/history-retention'
import type { HistoryLimits } from '../src/electron'
import { t } from '../src/i18n'

// temp+rename so a crash mid-write can't leave a half-written (and for the
// workspace config, connection-wiping) file behind. The temp name is random and
// created exclusively: a fixed one could be a symlink shipped in a cloned repo,
// and the write would land wherever it points. Synced before the rename, or a
// power cut can leave the new name pointing at a file whose data never landed.
export const writeFileAtomic = (file: string, data: string) => {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Never created, or already renamed into place.
    }
    throw error
  }
}

/** A filesystem-safe moment, for naming what is set aside rather than deleted. */
export const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/** `.sqlkit`, or a folder under it, refusing any that is a symlink: a cloned repo
 * could point one elsewhere, and writing or pruning backups through it would
 * reach outside the workspace. */
export function internalDir(workspacePath: string, ...segments: string[]): string {
  let dir = workspacePath
  for (const segment of ['.sqlkit', ...segments]) {
    dir = path.join(dir, segment)
    let linked = false
    try {
      linked = fs.lstatSync(dir).isSymbolicLink()
    } catch {
      // Not created yet.
    }
    if (linked) throw new Error(t('workspace.internalLinked', { path: dir }))
  }
  return dir
}

/** An internal file's text, never read through a symlink: a cloned repo could
 * point `backups/<hash>.sql` at ~/.ssh/id_rsa and restore it into a tab. Null when
 * it is over `maxBytes`; a missing file throws ENOENT as usual. */
export function readInternalFile(file: string, maxBytes: number): string | null {
  const noFollow = fs.constants.O_NOFOLLOW as number | undefined
  // Where the flag is missing (Windows), a check before the open is the best on offer.
  if (noFollow === undefined && fs.lstatSync(file).isSymbolicLink()) throw new Error(t('workspace.internalLinked', { path: file }))
  let fd: number
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (noFollow ?? 0))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error(t('workspace.internalLinked', { path: file }), { cause: error })
    throw error
  }
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${file} is not a file.`)
    return stat.size > maxBytes ? null : fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// A crash between creating a temp file and renaming it leaves the temp behind for good.
const STALE_TEMP_MS = 10 * 60 * 1000

/** Removes atomic-write temp files older than a few minutes from .sqlkit and the
 * folders under it, never following a symlink. Best-effort. */
export function sweepInternalTempFiles(workspacePath: string, now = Date.now()) {
  const sweep = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      // Dirent reports a symlink as neither a file nor a directory, so neither branch goes through one.
      if (entry.isDirectory() && depth < 3) sweep(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.tmp')) {
        try {
          if (now - fs.lstatSync(full).mtimeMs > STALE_TEMP_MS) fs.unlinkSync(full)
        } catch {
          // Already gone, or not ours to remove.
        }
      }
    }
  }
  try {
    sweep(internalDir(workspacePath), 0)
  } catch {
    // A symlinked .sqlkit is never swept.
  }
}

type GlobalConfig = {
  recentWorkspaces: RecentWorkspace[]
  lastWorkspace: string | null
  theme: ThemeId
  settings: AppSettings
  /** How many settings migrations the stored blob has been through. */
  settingsVersion: number
}

const themeValue = themeOrDefault

const defaultWorkspaceConfig = (): WorkspaceConfig => ({ version: 1, connections: [], preferences: DEFAULT_WORKSPACE_PREFERENCES })

const workspaceConfigPathFor = (wsPath: string) => path.join(internalDir(wsPath), 'config.json')

const slugify = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 _.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 60) || 'database'

// A folder must stay a single path segment inside the workspace; anything
// else (separators, dot-segments) came from a hand-edited config and is
// re-derived from the name instead.
const isSafeFolder = (folder: string) => /^[\w][\w .-]*$/.test(folder) && folder !== '.sqlkit'

// Fills in missing per-profile fields from before they existed: `file`
// (sqlite) and `folder` — each connection owns a workspace subfolder for its
// .sql files, slugged from its name and deduped, then never re-derived so
// later renames don't move files.
function normalizeConnections(connections: ConnectionProfile[]): ConnectionProfile[] {
  const taken = new Set(connections.map((connection) => connection.folder).filter(Boolean))
  return connections.map((connection) => {
    if (connection.folder && isSafeFolder(connection.folder)) return { ...connection, file: connection.file ?? '' }
    const base = slugify(connection.name)
    let folder = base
    for (let suffix = 2; taken.has(folder); suffix += 1) folder = `${base}-${suffix}`
    taken.add(folder)
    return { ...connection, file: connection.file ?? '', folder }
  })
}

// Secrets at rest: encrypted through the OS keychain (Electron safeStorage) and
// marked with a prefix so legacy plaintext configs still read — they migrate to
// encrypted on the next save (openWorkspace re-saves, so on first open).
// Keychain-bound by design: a config copied to another machine decrypts to ''
// and must be re-entered there. Where the OS offers no key store, the secret is
// written in plaintext (the .gitignore keeps it out of git) and the save warns —
// dropping it instead would silently wipe saved passwords on every config
// rewrite (e.g. a context switch) and break the current session.
const SECRET_PREFIX = 'enc:v1:'
const MAX_CONFIG_BYTES = 5 * 1024 * 1024

const encryptSecret = (value: string): string => {
  if (!value || value.startsWith(SECRET_PREFIX) || !safeStorage.isEncryptionAvailable()) return value
  return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
}

// Reading the config never needs plaintext, so stored values stay sealed until
// something is about to dial a connection. Touching safeStorage is what makes
// macOS ask for keychain access, and asking the moment a workspace opens — for
// credentials the user may not even use this session — is a poor trade.
const decryptSecret = (value: string): string => {
  if (!value.startsWith(SECRET_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
  } catch {
    // Unreadable (different machine, rotated OS key): behave as "no password
    // saved" so the connection prompts instead of failing obscurely.
    return ''
  }
}

const isPlaintextSecret = (value: string | undefined) => !!value && !value.startsWith(SECRET_PREFIX)

const connectionHasPlaintextSecret = (connection: ConnectionProfile) =>
  isPlaintextSecret(connection.password) ||
  isPlaintextSecret(connection.ssh?.password) ||
  isPlaintextSecret(connection.ssh?.passphrase)

// True when the loaded config carries secrets that are unencrypted at rest:
// there's no key store, so anything non-empty was written (and read back) as
// plaintext. The renderer warns the user once per workspace open.
const hasUnencryptedSecrets = (connections: ConnectionProfile[]) =>
  !safeStorage.isEncryptionAvailable() && connections.some(connectionHasPlaintextSecret)

export const isWeakStorageBackend = (platform: NodeJS.Platform, backend: string) =>
  platform === 'linux' && backend === 'basic_text'

const hasWeaklyProtectedSecrets = (connections: ConnectionProfile[]) => {
  if (!connections.some((connection) => connection.password || connection.ssh?.password || connection.ssh?.passphrase)) return false
  try {
    return isWeakStorageBackend(process.platform, safeStorage.getSelectedStorageBackend())
  } catch {
    return false
  }
}

// Keeps config.json — and the temp file the atomic write leaves on a crash —
// out of version control; both hold credentials, plaintext on a keyless system.
// History and the session's unsaved buffers hold query text, which can embed
// secrets, so they stay out too.
// Appends any missing rule to a hand-edited .gitignore rather than skipping, so
// a pre-existing file can't defeat the guard. Best-effort and idempotent.
const GITIGNORE_RULES = [
  // Temp files carry a random suffix; the fixed names cover ones older versions left behind.
  '*.tmp',
  'config.json',
  'config.json.tmp',
  'history.json',
  'history.json.tmp',
  // A history file that could not be read, set aside rather than overwritten.
  'history.*.json',
  'session.json',
  'session.json.tmp',
  // A workspace open in more than one window has a session file per window.
  'session.*.json',
  // Which process holds each window's slot.
  'session.lock',
  'session.*.lock',
  'session.*.json.tmp',
  'backups/',
]
export const ensureInternalGitignore = (workspacePath: string) => {
  try {
    const dir = internalDir(workspacePath)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '.gitignore')
    // A symlinked .gitignore reads as none: its target's text must not be copied into the workspace.
    let existing = ''
    try {
      existing = readInternalFile(file, MAX_CONFIG_BYTES) ?? ''
    } catch {
      // Missing, or refused.
    }
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
    const missing = GITIGNORE_RULES.filter((rule) => !present.has(rule))
    if (!missing.length) return
    const lead = existing ? (existing.endsWith('\n') ? '' : '\n') : '# SqlKit Studio: connection credentials — never commit.\n'
    // Replaced rather than appended to, so a symlinked .gitignore is never written through.
    writeFileAtomic(file, existing + lead + missing.join('\n') + '\n')
  } catch {
    // A read-only workspace simply doesn't get the guard.
  }
}

const mapSecrets = (connection: ConnectionProfile, map: (value: string) => string): ConnectionProfile => ({
  ...connection,
  password: map(connection.password ?? ''),
  ...(connection.ssh
    ? { ssh: { ...connection.ssh, password: map(connection.ssh.password ?? ''), passphrase: map(connection.ssh.passphrase ?? '') } }
    : {}),
})

const redactSecrets = (connection: ConnectionProfile): ConnectionProfile => ({
  ...connection,
  password: '',
  passwordSaved: !!connection.password,
  ...(connection.ssh
    ? {
        ssh: {
          ...connection.ssh,
          password: '',
          passphrase: '',
          passwordSaved: !!connection.ssh.password,
          passphraseSaved: !!connection.ssh.passphrase,
        },
      }
    : {}),
})

const stripSecretMarkers = (connection: ConnectionProfile): ConnectionProfile => {
  const { passwordSaved: _passwordSaved, ...profile } = connection
  if (!profile.ssh) return profile
  const { passwordSaved: _sshPasswordSaved, passphraseSaved: _passphraseSaved, ...ssh } = profile.ssh
  return { ...profile, ssh }
}

// Where the password travels, not just to whom: a tunnel moved or dropped, or TLS turned down, must not take it along.
const transportOf = (connection: ConnectionProfile) => JSON.stringify([
  connection.ssl?.mode ?? 'disable',
  connection.ssh?.enabled ? [connection.ssh.host, connection.ssh.port] : null,
])

const sameDatabaseCredentialTarget = (incoming: ConnectionProfile, saved: ConnectionProfile | undefined) =>
  !!saved && incoming.engine === saved.engine && incoming.host === saved.host && incoming.port === saved.port
  && incoming.username === saved.username && transportOf(incoming) === transportOf(saved)

const sameSshCredentialTarget = (incoming: ConnectionProfile, saved: ConnectionProfile | undefined) =>
  !!incoming.ssh && !!saved?.ssh && incoming.ssh.host === saved.ssh.host && incoming.ssh.port === saved.ssh.port
  && incoming.ssh.username === saved.ssh.username && incoming.ssh.authType === saved.ssh.authType
  && incoming.ssh.keyPath === saved.ssh.keyPath

const restoreSavedSecrets = (incoming: ConnectionProfile, saved: ConnectionProfile | undefined): ConnectionProfile => ({
  ...incoming,
  password:
    incoming.password || (incoming.passwordSaved && sameDatabaseCredentialTarget(incoming, saved) ? (saved?.password ?? '') : ''),
  ...(incoming.ssh
    ? {
        ssh: {
          ...incoming.ssh,
          password:
            incoming.ssh.password
            || (incoming.ssh.passwordSaved && sameSshCredentialTarget(incoming, saved) ? (saved?.ssh?.password ?? '') : ''),
          passphrase:
            incoming.ssh.passphrase
            || (incoming.ssh.passphraseSaved && sameSshCredentialTarget(incoming, saved) ? (saved?.ssh?.passphrase ?? '') : ''),
        },
      }
    : {}),
})

type ConfigOutcome =
  | { status: 'ok'; config: WorkspaceConfig }
  | { status: 'missing' }
  | { status: 'error'; error: string }

// Reads and decrypts the on-disk config, separating "no config yet" (safe to
// seed) from "config exists but is unreadable/corrupt" (must be preserved, not
// silently replaced with defaults).
function loadWorkspaceConfig(workspacePath: string): ConfigOutcome {
  let raw: string
  let file: string
  try {
    file = workspaceConfigPathFor(workspacePath)
    const text = readInternalFile(file, MAX_CONFIG_BYTES)
    if (text === null) return { status: 'error', error: `${file} exceeds the 5 MB configuration limit.` }
    raw = text
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: (error as Error).message }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    return { status: 'error', error: `${file} is not valid JSON: ${(error as Error).message}` }
  }
  try {
    // Version-1 profiles predate `file` and `folder`; migrate only those known
    // omissions before applying the same strict schema used at the IPC boundary.
    const candidate: Record<string, unknown> | null = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null
    const migrated = candidate && Array.isArray(candidate.connections)
      ? {
          ...candidate,
          connections: (candidate.connections as unknown[]).map((entry: unknown) =>
            entry && typeof entry === 'object' && !Array.isArray(entry)
              ? { file: '', folder: '', ...entry as Record<string, unknown> }
              : entry),
        }
      : decoded
    const parsed = validateWorkspaceConfig(migrated)
    // Secrets stay as stored. encryptSecret passes an already-sealed value
    // through untouched, so a later save round-trips them without a decrypt.
    return {
      status: 'ok',
      config: {
        ...parsed,
        preferences: normalizeWorkspacePreferences(parsed.preferences),
        connections: normalizeConnections(parsed.connections),
      },
    }
  } catch (error) {
    return { status: 'error', error: `${file} has an invalid configuration: ${(error as Error).message}` }
  }
}

/** Counts valid saved profiles without decrypting or exposing their contents. */
export function workspaceProfileCount(workspacePath: string): number {
  const outcome = loadWorkspaceConfig(workspacePath)
  return outcome.status === 'ok' ? outcome.config.connections.length : 0
}

export function readWorkspaceConfig(workspacePath: string | null): WorkspaceConfigResult {
  if (!workspacePath) return { config: defaultWorkspaceConfig() }
  const outcome = loadWorkspaceConfig(workspacePath)
  if (outcome.status === 'ok') {
    return {
      config: outcome.config,
      unencryptedSecrets: hasUnencryptedSecrets(outcome.config.connections),
      weakCredentialStorage: hasWeaklyProtectedSecrets(outcome.config.connections),
    }
  }
  if (outcome.status === 'missing') return { config: defaultWorkspaceConfig() }
  // Hand back empty connections so the UI still renders, but flag the error so
  // it can warn rather than pretend the workspace has no connections.
  return { config: defaultWorkspaceConfig(), error: outcome.error }
}

/** Renderer-safe workspace config: secret values never cross IPC. */
export function readWorkspaceConfigForRenderer(workspacePath: string | null): WorkspaceConfigResult {
  const result = readWorkspaceConfig(workspacePath)
  return {
    ...result,
    config: { ...result.config, connections: result.config.connections.map(redactSecrets) },
  }
}

/** Restores redacted saved credentials immediately before a privileged operation. */
export function hydrateConnectionProfile(workspacePath: string | null, incoming: ConnectionProfile): ConnectionProfile {
  if (!workspacePath) return stripSecretMarkers(incoming)
  const saved = readWorkspaceConfig(workspacePath).config.connections.find((connection) => connection.id === incoming.id)
  // Unsealed here, at the last moment before the driver dials.
  return stripSecretMarkers(mapSecrets(restoreSavedSecrets(incoming, saved), decryptSecret))
}

/** Applies one window's change to the config on disk. A workspace open in two
 * windows has one config, and a whole-file write from either would drop what
 * the other did between its load and its save — so a window sends what it
 * changed and the rest of the file stands. */
export function updateWorkspaceConfig(workspacePath: string | null, patch: WorkspaceConfigPatch): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const outcome = loadWorkspaceConfig(workspacePath)
  // Never patch onto defaults: a config that exists but cannot be read (corrupt,
  // or sealed on another machine) would be replaced by whatever this window has.
  if (outcome.status === 'error') return { success: false, error: outcome.error }
  const current = outcome.status === 'ok' ? outcome.config : defaultWorkspaceConfig()
  const removed = new Set(patch.removeConnections ?? [])
  const byId = new Map(current.connections.filter((connection) => !removed.has(connection.id)).map((c) => [c.id, c]))
  for (const connection of patch.upsertConnections ?? []) {
    if (!removed.has(connection.id)) byId.set(connection.id, connection)
  }
  for (const { id, database } of patch.lastChildDb ?? []) {
    const connection = byId.get(id)
    if (!connection) continue
    const { lastChildDb: _dropped, ...rest } = connection
    byId.set(id, database === null ? rest : { ...rest, lastChildDb: database })
  }
  return writeWorkspaceConfig(workspacePath, {
    ...current,
    connections: [...byId.values()],
    ...(patch.activeDbId === undefined ? {} : { activeDbId: patch.activeDbId }),
    ...(patch.preferences === undefined ? {} : { preferences: patch.preferences }),
  })
}

export function writeWorkspaceConfig(workspacePath: string | null, config: WorkspaceConfig): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  try {
    const savedById = new Map(
      readWorkspaceConfig(workspacePath).config.connections.map((connection) => [connection.id, connection]),
    )
    const restored = config.connections.map((connection) =>
      stripSecretMarkers(restoreSavedSecrets(connection, savedById.get(connection.id))),
    )
    const normalized = { ...config, connections: normalizeConnections(restored) }
    ensureInternalGitignore(workspacePath)
    // Every connection's files folder exists from the moment it's saved.
    for (const connection of normalized.connections) {
      fs.mkdirSync(path.join(workspacePath, connection.folder), { recursive: true })
    }
    const stored = {
      ...normalized,
      connections: normalized.connections.map((connection) => mapSecrets(connection, encryptSecret)),
    }
    writeFileAtomic(workspaceConfigPathFor(workspacePath), JSON.stringify(stored, null, 2))
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// --- Query history ----------------------------------------------------------

const historyPathFor = (wsPath: string) => path.join(internalDir(wsPath), 'history.json')
const MAX_HISTORY_BYTES = 64 * 1024 * 1024

/** The workspace's persisted query history, newest first. Missing or unreadable
 * files read as empty — history is a convenience, never worth blocking on. */
export function readWorkspaceHistory(workspacePath: string | null): HistoryItem[] {
  return workspacePath ? loadWorkspaceHistory(workspacePath).items : []
}

// `unreadable` is a file that exists but can't be used: the next write must not replace it with only the new runs.
function loadWorkspaceHistory(workspacePath: string): { items: HistoryItem[]; unreadable: boolean } {
  try {
    const text = readInternalFile(historyPathFor(workspacePath), MAX_HISTORY_BYTES)
    if (text === null) return { items: [], unreadable: true }
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return { items: [], unreadable: true }
    return {
      items: parsed.filter((entry): entry is HistoryItem =>
        !!entry && typeof entry === 'object'
        && typeof (entry as HistoryItem).id === 'string'
        && typeof (entry as HistoryItem).contextKey === 'string'
        && typeof (entry as HistoryItem).sql === 'string'
        && typeof (entry as HistoryItem).success === 'boolean'),
      unreadable: false,
    }
  } catch (error) {
    return { items: [], unreadable: (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
}

/** The workspace's retention rules, read straight from its config: a window may
 * be holding the ones from before another window changed them, and pruning to
 * those would delete entries the workspace is now meant to keep. Null when the
 * config exists but cannot be read — then nothing is pruned at all. */
function historyLimitsFor(workspacePath: string): HistoryLimits | null {
  let raw: string | null
  try {
    raw = readInternalFile(workspaceConfigPathFor(workspacePath), MAX_CONFIG_BYTES)
  } catch (error) {
    // No config yet is a new workspace, which has the defaults.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? DEFAULT_WORKSPACE_PREFERENCES : null
  }
  if (raw === null) return null
  try {
    return normalizeWorkspacePreferences((JSON.parse(raw) as { preferences?: unknown }).preferences)
  } catch {
    return null
  }
}

/** Applies one window's change to the history on disk. Two windows finishing a
 * query at once would each write a list missing the other's newest entry, so a
 * window sends the runs it recorded and the file keeps the rest. A patch with
 * nothing in it is a prune: retention alone, applied to what is there. */
export function updateWorkspaceHistory(workspacePath: string | null, patch: WorkspaceHistoryPatch): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  const loaded = patch.clearAll ? { items: [], unreadable: false } : loadWorkspaceHistory(workspacePath)
  if (loaded.unreadable) {
    // Kept beside the fresh file, not overwritten by it: it may be one bad byte away from every run.
    try {
      fs.renameSync(historyPathFor(workspacePath), path.join(internalDir(workspacePath), `history.unreadable-${fileStamp()}.json`))
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  }
  const current = loaded.items
  const kept = patch.clearContext === undefined
    ? current
    : current.filter((item) => item.contextKey !== patch.clearContext)
  const merged = [...(patch.append ?? []), ...kept]
  const limits = historyLimitsFor(workspacePath)
  return writeWorkspaceHistory(workspacePath, limits ? limitHistory(merged, limits) : merged)
}

export function writeWorkspaceHistory(workspacePath: string | null, items: HistoryItem[]): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  try {
    ensureInternalGitignore(workspacePath)
    writeFileAtomic(historyPathFor(workspacePath), JSON.stringify(items, null, 2))
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

const globalConfigPath = () => path.join(app.getPath('userData'), 'config.json')

export function readGlobalConfig(): GlobalConfig {
  try {
    const file = globalConfigPath()
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return defaultGlobalConfig()
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      recentWorkspaces?: unknown
      lastWorkspace?: unknown
      theme?: unknown
      settings?: unknown
      settingsVersion?: unknown
    }
    // Valid JSON with a missing/wrong-typed shape (a hand-edit, an old version)
    // must not crash callers that map over recentWorkspaces — normalize to the
    // known shape, dropping entries without a usable path.
    const entries: unknown[] = Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces : []
    const theme = themeValue(parsed.theme)
    return {
      recentWorkspaces: entries.filter((entry): entry is RecentWorkspace =>
        !!entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).path === 'string'),
      lastWorkspace: typeof parsed.lastWorkspace === 'string' ? parsed.lastWorkspace : null,
      theme,
      // Migrations run before coercion: a renamed key still holds its value,
      // and anything they leave malformed still falls back to its default.
      settings: normalizeAppSettings({
        ...record(migrateAppSettings(parsed.settings, typeof parsed.settingsVersion === 'number' ? parsed.settingsVersion : 0)),
        theme,
      }),
      settingsVersion: APP_SETTINGS_VERSION,
    }
  } catch {
    return defaultGlobalConfig()
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const defaultGlobalConfig = (): GlobalConfig => ({
  recentWorkspaces: [],
  lastWorkspace: null,
  theme: DEFAULT_THEME,
  settings: normalizeAppSettings(null),
  settingsVersion: APP_SETTINGS_VERSION,
})

function writeGlobalConfig(config: GlobalConfig) {
  writeFileAtomic(globalConfigPath(), JSON.stringify(config, null, 2))
}

export const readTheme = (): ThemeId => readGlobalConfig().theme

export const readAppSettings = (): AppSettings => readGlobalConfig().settings

export function writeAppSettings(settings: AppSettings) {
  const normalized = normalizeAppSettings(settings)
  writeGlobalConfig({
    ...readGlobalConfig(),
    theme: normalized.theme,
    settings: normalized,
    settingsVersion: APP_SETTINGS_VERSION,
  })
}

export function writeTheme(theme: ThemeId) {
  const config = readGlobalConfig()
  writeGlobalConfig({ ...config, theme, settings: { ...config.settings, theme } })
}

export function isDirectory(checkPath: string) {
  try {
    return fs.statSync(checkPath).isDirectory()
  } catch {
    return false
  }
}

// Opens (and initializes) a workspace folder: ensures the .sqlkit marker
// directory with a seeded config.json, and records the folder at the top of
// the global recent list.
export function openWorkspace(wsPath: string): WorkspaceResult {
  if (!isDirectory(wsPath)) {
    return { success: false, error: t('workspace.directoryNotFound') }
  }

  const workspacePath = path.resolve(wsPath)
  sweepInternalTempFiles(workspacePath)
  // Seed a config only when none exists, and bring a readable one up to date
  // (per-connection folders, re-encrypted secrets). A config that exists but
  // won't parse is left untouched — re-seeding it would wipe every saved
  // connection over a single hand-edit slip.
  const outcome = loadWorkspaceConfig(workspacePath)
  if (outcome.status === 'missing') {
    writeWorkspaceConfig(workspacePath, defaultWorkspaceConfig())
  } else {
    // Guard an existing config from version control even when it won't be
    // rewritten (corrupt JSON, or secrets sealed on another machine).
    ensureInternalGitignore(workspacePath)
    // Bring a readable config up to date (re-encrypt secrets where a key store
    // exists, create per-connection folders). An undecryptable one is left as-is
    // so a missing keychain can't wipe it.
    if (outcome.status === 'ok') writeWorkspaceConfig(workspacePath, outcome.config)
  }

  const name = path.basename(workspacePath)
  const config = readGlobalConfig()
  config.recentWorkspaces = (config.recentWorkspaces ?? []).filter(
    (workspace) => path.resolve(workspace.path) !== workspacePath,
  )
  config.recentWorkspaces.unshift({ path: workspacePath, name, lastOpened: new Date().toISOString() })
  config.recentWorkspaces = config.recentWorkspaces.slice(0, 10)
  config.lastWorkspace = workspacePath
  writeGlobalConfig(config)

  return { success: true, path: workspacePath, name }
}
