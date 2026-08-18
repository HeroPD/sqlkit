import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SaveResult, WorkspaceSession } from '../src/electron'
import { t } from '../src/i18n'
import { workspaceSession as validateWorkspaceSession } from './ipc-validation'
import { ensureInternalGitignore, writeFileAtomic } from './workspace'

// Hot exit: the workbench's open tabs and their unsaved buffers, so quitting or
// crashing never costs work in progress. Layout goes in one small JSON file;
// each dirty buffer is its own file so a 2MB query isn't re-serialized on every
// keystroke and one unreadable buffer can't take the whole session down.
//
// ---------------------------------------------------------------------------
// ON-DISK CONTRACT (shipped — read this before changing any of it)
//
//   .sqlkit/session.json          { version: 1, contexts: [...], unclean? }
//   .sqlkit/backups/<32 hex>.sql  one unsaved buffer, named sha256(tab id)
//
// Both are written 0600 and .gitignore'd; query text can carry credentials.
//
// * A context is stored as its parts — profileId + childDb — never as the
//   workbench's composite context key, which is a renderer detail free to
//   change. Tabs carry identity only; text lives in the backups.
// * A backup's filename derives from the tab id, so the two move together: a
//   change to how tab ids are formed has to migrate the files as well, or every
//   buffer is orphaned and swept on the next write.
// * `dirty` means the buffer differs from the file. An untitled tab is backed up
//   whether or not it is set — it has no file to fall back on.
// * Forward compatibility, by design: an unknown tab kind or field is dropped,
//   never fatal, so a file from a later build still restores what this one
//   understands. An unrecognized `version` restores nothing and leaves the file
//   untouched on read — so a future format that cannot be read this way belongs
//   in a filename of its own rather than a bump here.
// * Invariants the writers keep: buffers are written before the session that
//   prunes unclaimed ones; the session never describes text no backup holds; a
//   refused write unclaims a tab only when nothing of it is left on disk.
// * Deliberate limits: paths are absolute, so moving or copying a workspace
//   drops clean file tabs (their files are untouched) and brings dirty ones back
//   as untitled with their work intact — reads are workspace-scoped, so a stale
//   path can never resolve outside the workspace now open. A context whose
//   profile was removed by hand-editing config.json keeps its bucket; there is
//   deliberately no pruning path that could delete tabs because a config read
//   failed.
// ---------------------------------------------------------------------------
const sessionPathFor = (wsPath: string) => path.join(wsPath, '.sqlkit', 'session.json')
const backupsDirFor = (wsPath: string) => path.join(wsPath, '.sqlkit', 'backups')

// Tab ids for workspace files are `file:<absolute path>`, which is no filename —
// so backups are named by a hash of the id, derived identically on every call.
const backupNameFor = (tabId: string) => `${createHash('sha256').update(tabId).digest('hex').slice(0, 32)}.sql`
const backupPathFor = (wsPath: string, tabId: string) => path.join(backupsDirFor(wsPath), backupNameFor(tabId))

const MAX_SESSION_BYTES = 5 * 1024 * 1024
const MAX_BACKUP_BYTES = 10 * 1024 * 1024

/** The workspace's last session, or null when there is none to restore. A
 * missing, oversized, or hand-broken file reads as null and is left in place —
 * re-seeding it would throw away buffers the user may still want. */
export function readSession(workspacePath: string | null): WorkspaceSession | null {
  if (!workspacePath) return null
  try {
    const file = sessionPathFor(workspacePath)
    if (fs.statSync(file).size > MAX_SESSION_BYTES) return null
    return validateWorkspaceSession(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function writeSession(workspacePath: string | null, session: WorkspaceSession): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  try {
    // Validated on the way out as well as in, so what reaches disk is bounded
    // and secret-free no matter which caller assembled it.
    const sanitized = validateWorkspaceSession(session)
    ensureInternalGitignore(workspacePath)
    // `unclean` is set on every save and cleared only by a clean quit, so the
    // next open can tell a crash from an orderly shutdown.
    writeFileAtomic(sessionPathFor(workspacePath), JSON.stringify({ ...sanitized, unclean: true }, null, 2))
    pruneBackups(workspacePath, sanitized)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// Backups outlive their tab when it is closed in bulk (a removed connection, a
// deleted folder), so every session write sweeps the ones no tab claims.
function pruneBackups(workspacePath: string, session: WorkspaceSession) {
  const dir = backupsDirFor(workspacePath)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  const live = new Set<string>()
  for (const context of session.contexts) {
    // Untitled tabs claim a backup unconditionally: it is the only copy of
    // their text. A tab that turned out to have none simply matches nothing.
    for (const tab of context.tabs) {
      if (tab.kind === 'sql' && (tab.dirty || tab.path === null)) live.add(backupNameFor(tab.id))
    }
  }
  for (const entry of entries) {
    if (!entry.endsWith('.sql') || live.has(entry)) continue
    try {
      fs.unlinkSync(path.join(dir, entry))
    } catch {
      // A locked or already-removed file just stays; the next write retries.
    }
  }
}

export function readBackup(workspacePath: string | null, tabId: string): string | null {
  if (!workspacePath) return null
  try {
    const file = backupPathFor(workspacePath, tabId)
    if (fs.statSync(file).size > MAX_BACKUP_BYTES) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function writeBackup(workspacePath: string | null, tabId: string, content: string): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  if (Buffer.byteLength(content, 'utf8') > MAX_BACKUP_BYTES) return { success: false, error: t('file.tooLargeToSave') }
  try {
    ensureInternalGitignore(workspacePath)
    fs.mkdirSync(backupsDirFor(workspacePath), { recursive: true })
    writeFileAtomic(backupPathFor(workspacePath, tabId), content)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

/** Whether a tab has any backup on disk. A refused write leaves the previous one
 * untouched — temp+rename never destroys what it fails to replace — so an older
 * version of the text can still be sitting there. */
export function hasBackup(workspacePath: string | null, tabId: string): boolean {
  if (!workspacePath) return false
  try {
    return fs.statSync(backupPathFor(workspacePath, tabId)).isFile()
  } catch {
    return false
  }
}

/** A shutdown-time buffer write. Reports the tab as unbacked only when nothing
 * of it is left on disk, which is the one case where the session has to stop
 * describing it: a tab whose older backup survived still has work to come back
 * to, and dropping its claim would let the session write prune that very copy. */
export function writeShutdownBackup(workspacePath: string | null, tabId: string, content: string): { unbacked: boolean } {
  if (writeBackup(workspacePath, tabId, content).success) return { unbacked: false }
  return { unbacked: !hasBackup(workspacePath, tabId) }
}

/** The tab was saved, reverted, or closed — its buffer is no longer unsaved. */
export function dropBackup(workspacePath: string | null, tabId: string) {
  if (!workspacePath) return
  try {
    fs.unlinkSync(backupPathFor(workspacePath, tabId))
  } catch {
    // Nothing there to drop is the common case, not an error.
  }
}

/** Clears the crash marker. Called once the app is shutting down in an orderly
 * way, after the renderers have flushed. */
export function markSessionClean(workspacePath: string | null) {
  if (!workspacePath) return
  const session = readSession(workspacePath)
  if (!session?.unclean) return
  try {
    writeFileAtomic(sessionPathFor(workspacePath), JSON.stringify({ ...session, unclean: false }, null, 2))
  } catch {
    // Failing to clear the marker only costs a spurious "restored" notice.
  }
}
