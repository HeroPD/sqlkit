import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ConnectionProfile,
  RecentWorkspace,
  SaveResult,
  WorkspaceConfig,
  WorkspaceConfigResult,
  WorkspaceResult,
} from '../src/electron'
import { workspaceConfig as validateWorkspaceConfig } from './ipc-validation'

// temp+rename so a crash mid-write can't leave a half-written (and for the
// workspace config, connection-wiping) file behind.
const writeFileAtomic = (file: string, data: string) => {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

type GlobalConfig = {
  recentWorkspaces: RecentWorkspace[]
  lastWorkspace: string | null
}

const defaultWorkspaceConfig = (): WorkspaceConfig => ({ version: 1, connections: [] })

const workspaceConfigPathFor = (wsPath: string) => path.join(wsPath, '.sqlkit', 'config.json')

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
// Appends any missing rule to a hand-edited .gitignore rather than skipping, so
// a pre-existing file can't defeat the guard. Best-effort and idempotent.
const GITIGNORE_RULES = ['config.json', 'config.json.tmp']
const ensureInternalGitignore = (workspacePath: string) => {
  try {
    const dir = path.join(workspacePath, '.sqlkit')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, '.gitignore')
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()))
    const missing = GITIGNORE_RULES.filter((rule) => !present.has(rule))
    if (!missing.length) return
    const lead = existing ? (existing.endsWith('\n') ? '' : '\n') : '# SqlKit: connection credentials — never commit.\n'
    fs.writeFileSync(file, existing + lead + missing.join('\n') + '\n')
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

const sameDatabaseCredentialTarget = (incoming: ConnectionProfile, saved: ConnectionProfile | undefined) =>
  !!saved && incoming.engine === saved.engine && incoming.host === saved.host && incoming.port === saved.port
  && incoming.username === saved.username

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
  | { status: 'ok'; config: WorkspaceConfig; decryptFailed: boolean }
  | { status: 'missing' }
  | { status: 'error'; error: string }

// Reads and decrypts the on-disk config, separating "no config yet" (safe to
// seed) from "config exists but is unreadable/corrupt" (must be preserved, not
// silently replaced with defaults).
function loadWorkspaceConfig(workspacePath: string): ConfigOutcome {
  let raw: string
  try {
    const file = workspaceConfigPathFor(workspacePath)
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return { status: 'error', error: `${file} exceeds the 5 MB configuration limit.` }
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', error: (error as Error).message }
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    return { status: 'error', error: `${workspaceConfigPathFor(workspacePath)} is not valid JSON: ${(error as Error).message}` }
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
    let decryptFailed = false
    const decryptTracked = (value: string): string => {
      if (!value.startsWith(SECRET_PREFIX)) return value
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'))
      } catch {
        decryptFailed = true
        return ''
      }
    }
    const connections = normalizeConnections(parsed.connections).map((connection) => mapSecrets(connection, decryptTracked))
    return {
      status: 'ok',
      decryptFailed,
      config: {
        ...parsed,
        connections,
      },
    }
  } catch (error) {
    return { status: 'error', error: `${workspaceConfigPathFor(workspacePath)} has an invalid configuration: ${(error as Error).message}` }
  }
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
  return stripSecretMarkers(restoreSavedSecrets(incoming, saved))
}

export function writeWorkspaceConfig(workspacePath: string | null, config: WorkspaceConfig): SaveResult {
  if (!workspacePath) return { success: false, error: 'No workspace open' }
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

const globalConfigPath = () => path.join(app.getPath('userData'), 'config.json')

export function readGlobalConfig(): GlobalConfig {
  try {
    const file = globalConfigPath()
    if (fs.statSync(file).size > MAX_CONFIG_BYTES) return { recentWorkspaces: [], lastWorkspace: null }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GlobalConfig
  } catch {
    return { recentWorkspaces: [], lastWorkspace: null }
  }
}

function writeGlobalConfig(config: GlobalConfig) {
  writeFileAtomic(globalConfigPath(), JSON.stringify(config, null, 2))
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
    return { success: false, error: 'Directory not found' }
  }

  const workspacePath = path.resolve(wsPath)
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
    if (outcome.status === 'ok' && !outcome.decryptFailed) writeWorkspaceConfig(workspacePath, outcome.config)
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
