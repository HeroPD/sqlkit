import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { SaveResult, WorkspaceSession } from '../src/electron'
import { t } from '../src/i18n'
import { stringValue, workspaceSession as validateWorkspaceSession } from './ipc-validation'
import { recoverableContexts } from '../src/session-recovery'
import { ensureInternalGitignore, fileStamp, internalDir, writeFileAtomic } from './workspace'

// Hot exit: the workbench's open tabs and their unsaved buffers, so quitting or
// crashing never costs work in progress. Layout goes in one small JSON file;
// each dirty buffer is its own file so a 2MB query isn't re-serialized on every
// keystroke and one unreadable buffer can't take the whole session down.
//
// ---------------------------------------------------------------------------
// ON-DISK CONTRACT (shipped — read this before changing any of it)
//
//   .sqlkit/session.json          { version: 1, contexts: [...], unclean? }
//   .sqlkit/session.<n>.json      the same, for the nth extra window open on the
//                                 workspace; the first window keeps session.json
//   .sqlkit/backups/<32 hex>.sql  one unsaved buffer, named sha256(tab id)
//   .sqlkit/backups/<n>/…         the same, for the nth extra window's buffers
//   …/unrestored-<time>/<hex>.sql buffers set aside, never swept (see below)
//   .sqlkit/session[.<n>].lock    which process holds that slot (see claimSessionSlot)
//
// All are written 0600 and .gitignore'd; query text can carry credentials.
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
//   in a filename of its own rather than a bump here. The next write still
//   replaces it, but nothing was restored from it, so the backups beside it are
//   moved into an unrestored-<time>/ subfolder rather than swept as unclaimed.
// * Invariants the writers keep: buffers are written before the session that
//   prunes unclaimed ones; the session never describes text no backup holds; a
//   refused write unclaims a tab only when nothing of it is left on disk.
// * Each slot owns its own backups directory, because a tab id is not unique
//   across windows: the same file open in two of them is the same id, and one
//   window saving it would otherwise drop the other's unsaved copy. So a window
//   only ever reads, writes, and sweeps its own.
// * Deliberate limits: paths are absolute, so moving or copying a workspace
//   drops clean file tabs (their files are untouched) and brings dirty ones back
//   as untitled with their work intact — reads are workspace-scoped, so a stale
//   path can never resolve outside the workspace now open. A context whose
//   profile was removed by hand-editing config.json keeps its bucket; there is
//   deliberately no pruning path that could delete tabs because a config read
//   failed.
// ---------------------------------------------------------------------------
// Windows sharing a workspace each own a numbered slot: the first keeps
// session.json, so a single-window workspace is the file it has always been.
const sessionPathFor = (wsPath: string, slot: number) =>
  path.join(internalDir(wsPath), slot === 0 ? 'session.json' : `session.${slot}.json`)
// A window's buffers live under its own slot, because a tab id is not unique
// across windows: the same file open in two of them is the same id, and one
// window saving it would otherwise delete the other's unsaved copy.
const backupsDirFor = (wsPath: string, slot: number) =>
  slot === 0 ? internalDir(wsPath, 'backups') : internalDir(wsPath, 'backups', String(slot))

// Tab ids for workspace files are `file:<absolute path>`, which is no filename —
// so backups are named by a hash of the id, derived identically on every call.
const backupNameFor = (tabId: string) => `${createHash('sha256').update(tabId).digest('hex').slice(0, 32)}.sql`
const backupPathFor = (wsPath: string, tabId: string, slot: number) =>
  path.join(backupsDirFor(wsPath, slot), backupNameFor(tabId))

const MAX_SESSION_BYTES = 5 * 1024 * 1024
const MAX_BACKUP_BYTES = 10 * 1024 * 1024

/** The workspace's last session, or null when there is none to restore. A
 * missing, oversized, or hand-broken file reads as null and is left in place —
 * re-seeding it would throw away buffers the user may still want. */
export function readSession(workspacePath: string | null, slot = 0): WorkspaceSession | null {
  if (!workspacePath) return null
  try {
    return readSessionFile(sessionPathFor(workspacePath, slot))
  } catch {
    // A symlinked .sqlkit: nothing is read through it, or written.
    return null
  }
}

function readSessionFile(file: string): WorkspaceSession | null {
  try {
    if (fs.statSync(file).size > MAX_SESSION_BYTES) return null
    return validateWorkspaceSession(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

// Session files this process has written, which it therefore knows it can read.
const writtenSessions = new Set<string>()

export function writeSession(workspacePath: string | null, session: WorkspaceSession, slot = 0): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  try {
    // Validated on the way out as well as in, so what reaches disk is bounded
    // and secret-free no matter which caller assembled it.
    const sanitized = validateWorkspaceSession(session)
    ensureInternalGitignore(workspacePath)
    const file = sessionPathFor(workspacePath, slot)
    // Replacing a session this build couldn't read (corrupt, or a later format): nothing was
    // restored from it, so the backups it claims are set aside rather than swept as unclaimed.
    const setAside = !writtenSessions.has(file) && fs.existsSync(file) && readSessionFile(file) === null
    // `unclean` is set on every save and cleared only by a clean quit, so the
    // next open can tell a crash from an orderly shutdown.
    writeFileAtomic(file, JSON.stringify({ ...sanitized, unclean: true }, null, 2))
    writtenSessions.add(file)
    pruneBackups(workspacePath, sanitized, slot, setAside)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

// Backups outlive their tab when it is closed in bulk (a removed connection, a
// deleted folder), so every session write sweeps the ones no tab claims. One
// slot's session claims one slot's directory: no window can sweep another's.
function pruneBackups(workspacePath: string, session: WorkspaceSession, slot: number, setAside = false) {
  const dir = backupsDirFor(workspacePath, slot)
  // A subfolder is never swept, so what goes here stays until the user looks.
  const aside = path.join(dir, `unrestored-${fileStamp()}`)
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
  // Slot 0's directory holds the other slots' as subdirectories; only files
  // named like a backup are ever swept.
  for (const entry of entries) {
    if (!entry.endsWith('.sql') || live.has(entry)) continue
    try {
      if (setAside) {
        fs.mkdirSync(aside, { recursive: true, mode: 0o700 })
        fs.renameSync(path.join(dir, entry), path.join(aside, entry))
      } else {
        fs.unlinkSync(path.join(dir, entry))
      }
    } catch {
      // A locked or already-removed file just stays; the next write retries.
    }
  }
}

export function readBackup(workspacePath: string | null, tabId: string, slot = 0): string | null {
  if (!workspacePath) return null
  try {
    const file = backupPathFor(workspacePath, tabId, slot)
    if (fs.statSync(file).size > MAX_BACKUP_BYTES) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function writeBackup(workspacePath: string | null, tabId: string, content: string, slot = 0): SaveResult {
  if (!workspacePath) return { success: false, error: t('file.noWorkspace') }
  if (Buffer.byteLength(content, 'utf8') > MAX_BACKUP_BYTES) return { success: false, error: t('file.tooLargeToSave') }
  try {
    ensureInternalGitignore(workspacePath)
    fs.mkdirSync(backupsDirFor(workspacePath, slot), { recursive: true })
    writeFileAtomic(backupPathFor(workspacePath, tabId, slot), content)
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

/** Whether a tab has any backup on disk. A refused write leaves the previous one
 * untouched — temp+rename never destroys what it fails to replace — so an older
 * version of the text can still be sitting there. */
export function hasBackup(workspacePath: string | null, tabId: string, slot = 0): boolean {
  if (!workspacePath) return false
  try {
    return fs.statSync(backupPathFor(workspacePath, tabId, slot)).isFile()
  } catch {
    return false
  }
}

/** A shutdown-time buffer write. Reports the tab as unbacked only when nothing
 * of it is left on disk, which is the one case where the session has to stop
 * describing it: a tab whose older backup survived still has work to come back
 * to, and dropping its claim would let the session write prune that very copy. */
export function writeShutdownBackup(workspacePath: string | null, tabId: string, content: string, slot = 0): { unbacked: boolean } {
  if (writeBackup(workspacePath, tabId, content, slot).success) return { unbacked: false }
  return { unbacked: !hasBackup(workspacePath, tabId, slot) }
}

// --- slot locks ---------------------------------------------------------------
// A slot's session file and backups belong to one window at a time. Windows in
// one process keep apart through WorkspaceWindows; these locks keep processes on
// one machine apart too — `npm run dev` beside the installed app would otherwise
// both write slot 0 and prune each other's buffers. A lock names its process by
// pid and boot time only: macOS reports the hostname as the current network
// address, so a lock keyed on it would outlive a crash forever after a network
// change. Two machines sharing a folder over a network drive are not kept apart.

type SlotLock = { pid: number; boot: number }

const lockPathFor = (wsPath: string, slot: number) =>
  path.join(internalDir(wsPath), slot === 0 ? 'session.lock' : `session.${slot}.lock`)

// Seconds since the epoch the machine booted: a pid from before a reboot names some other process now.
const bootTime = () => Math.round(Date.now() / 1000 - os.uptime())

const readLock = (file: string): SlotLock | null => {
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SlotLock>
    return typeof lock.pid === 'number' && typeof lock.boot === 'number' ? lock as SlotLock : null
  } catch {
    return null
  }
}

// Whether the process named by a lock may still be running. This process's own
// locks are never live here: WorkspaceWindows already knows which of its windows hold what.
function lockIsLive(lock: SlotLock): boolean {
  if (Math.abs(lock.boot - bootTime()) > 60) return false
  if (lock.pid === process.pid) return false
  try {
    process.kill(lock.pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Takes a slot's lock for this process. False when a running process holds it;
 * a lock left by a crash is taken over. With no lock possible (a read-only or
 * refused .sqlkit) the slot is granted: nothing can be written there anyway. */
export function claimSessionSlot(wsPath: string, slot: number): boolean {
  let file: string
  try {
    file = lockPathFor(wsPath, slot)
    ensureInternalGitignore(wsPath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    return true
  }
  const mine = JSON.stringify({ pid: process.pid, boot: bootTime() })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx', mode: 0o600 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return true
    }
    const held = readLock(file)
    if (held && lockIsLive(held)) return false
    // Stale: removed and re-created exclusively, so of two processes taking it over at once only one wins.
    try {
      fs.unlinkSync(file)
    } catch {
      // Already gone; the retry decides.
    }
  }
  return false
}

/** Slots a crash left behind: a session still marked unclean, holding tabs, and
 * held by no running process. Each was a window open on this workspace when the
 * app went down, and reopening one restores it. Slots this process's own windows
 * hold read as abandoned here; the caller leaves those out. */
export function abandonedSessionSlots(wsPath: string): number[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(internalDir(wsPath))
  } catch {
    return []
  }
  const slots: number[] = []
  for (const entry of entries) {
    const match = /^session(?:\.(\d+))?\.json$/.exec(entry)
    if (!match) continue
    const slot = match[1] === undefined ? 0 : Number(match[1])
    const session = readSession(wsPath, slot)
    if (!session?.unclean || !session.contexts.some((context) => context.tabs.length)) continue
    const held = readLock(lockPathFor(wsPath, slot))
    if (held && lockIsLive(held)) continue
    slots.push(slot)
  }
  return slots.sort((a, b) => a - b)
}

/** Gives a slot's lock back, if this process is the one holding it. */
export function releaseSessionSlot(wsPath: string, slot: number) {
  try {
    const file = lockPathFor(wsPath, slot)
    const held = readLock(file)
    if (held?.pid === process.pid) fs.unlinkSync(file)
  } catch {
    // Nothing to give back.
  }
}

/** The synchronous shutdown flush: every buffer it can write, then the session,
 * claiming only tabs whose text is on disk — only this side learns which writes
 * landed. Each buffer stands alone: one too large or malformed costs that tab,
 * never the rest of the flush. */
export function applyShutdownFlush(
  workspacePath: string | null,
  payload: unknown,
  limits: { tabId: number; content: number },
  slot = 0,
) {
  const flush = payload as { session?: unknown; backups?: unknown } | null
  const unbacked = new Set<string>()
  if (Array.isArray(flush?.backups)) {
    for (const entry of flush.backups.slice(0, 500)) {
      const backup = entry as { tabId?: unknown; content?: unknown }
      let tabId: string
      try {
        tabId = stringValue(backup.tabId, 'Tab id', limits.tabId)
      } catch {
        continue
      }
      try {
        if (writeShutdownBackup(workspacePath, tabId, stringValue(backup.content, 'Buffer', limits.content), slot).unbacked) unbacked.add(tabId)
      } catch {
        if (!hasBackup(workspacePath, tabId, slot)) unbacked.add(tabId)
      }
    }
  }
  if (flush?.session === undefined) return
  const session = validateWorkspaceSession(flush.session)
  writeSession(workspacePath, { ...session, contexts: recoverableContexts(session.contexts, unbacked) }, slot)
}

/** The tab was saved, reverted, or closed — its buffer is no longer unsaved. */
export function dropBackup(workspacePath: string | null, tabId: string, slot = 0) {
  if (!workspacePath) return
  try {
    fs.unlinkSync(backupPathFor(workspacePath, tabId, slot))
  } catch {
    // Nothing there to drop is the common case, not an error.
  }
}

/** Clears the crash marker. Called once the app is shutting down in an orderly
 * way, after the renderers have flushed. */
export function markSessionClean(workspacePath: string | null, slot = 0) {
  if (!workspacePath) return
  const session = readSession(workspacePath, slot)
  if (!session?.unclean) return
  try {
    writeFileAtomic(sessionPathFor(workspacePath, slot), JSON.stringify({ ...session, unclean: false }, null, 2))
  } catch {
    // Failing to clear the marker only costs a spurious "restored" notice.
  }
}
