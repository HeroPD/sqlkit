import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** Symlinks and trailing slashes must not read as two different workspaces. */
export function normalizeWorkspacePath(wsPath: string): string {
  try {
    return resolve(realpathSync(wsPath))
  } catch {
    return resolve(wsPath)
  }
}

// Which workspace each window has open, and which session slot it owns there.
//
// A workspace can hold several databases, so more than one window may be open
// on it — the second view of the same folder. Everything under .sqlkit/ is then
// shared, and the slot is what keeps those windows apart: slot 0 owns
// session.json, the next window session.1.json. The first window on a workspace
// always takes slot 0, so a workspace only ever opened once is the single file
// it has always been.
/** Slots held across processes (see claimSessionSlot in session.ts). */
export type SlotLocks = {
  claim(wsPath: string, slot: number): boolean
  release(wsPath: string, slot: number): void
}

const NO_LOCKS: SlotLocks = { claim: () => true, release: () => {} }

export class WorkspaceWindows {
  private paths = new Map<number, string>()
  private slots = new Map<number, number>()

  private locks: SlotLocks

  constructor(locks: SlotLocks = NO_LOCKS) {
    this.locks = locks
  }

  /** Points a window at a workspace, claiming the lowest slot free on it — free
   * in this process and not held by another one. `preferred` is the slot of a
   * window being reopened after a crash, taken when it is still free. */
  open(contentsId: number, wsPath: string, preferred?: number) {
    this.close(contentsId)
    const target = normalizeWorkspacePath(wsPath)
    const taken = new Set(this.owners(target, contentsId).map((id) => this.slots.get(id) ?? 0))
    const free = (candidate: number) => !taken.has(candidate) && this.locks.claim(wsPath, candidate)
    let slot = 0
    if (preferred !== undefined && free(preferred)) slot = preferred
    else while (slot === preferred || !free(slot)) slot += 1
    this.paths.set(contentsId, wsPath)
    this.slots.set(contentsId, slot)
  }

  /** The window left its workspace (closed, or moved to another one). */
  close(contentsId: number) {
    const wsPath = this.paths.get(contentsId)
    if (wsPath !== undefined) this.locks.release(wsPath, this.slots.get(contentsId) ?? 0)
    this.paths.delete(contentsId)
    this.slots.delete(contentsId)
  }

  pathFor(contentsId: number): string | null {
    return this.paths.get(contentsId) ?? null
  }

  slotFor(contentsId: number): number {
    return this.slots.get(contentsId) ?? 0
  }

  has(contentsId: number): boolean {
    return this.paths.has(contentsId)
  }

  /** Every window with this workspace open, except the one asking. */
  owners(wsPath: string, exceptId?: number): number[] {
    const target = normalizeWorkspacePath(wsPath)
    const found: number[] = []
    for (const [id, openedPath] of this.paths) {
      if (id !== exceptId && normalizeWorkspacePath(openedPath) === target) found.push(id)
    }
    return found
  }

  /** The windows to raise instead of opening `wsPath` again. A window with no
   * workspace opens its own view of it — that is how two databases of one
   * workspace sit side by side; a window already in a workspace does not
   * repoint itself onto one open elsewhere, and re-opening its own stays put. */
  raiseInstead(wsPath: string, requesterId: number): number[] {
    if (!this.has(requesterId)) return []
    if (this.owners(wsPath).includes(requesterId)) return []
    return this.owners(wsPath, requesterId)
  }

  /** Every open workspace with the slot its window owns, for the quit sweep. */
  all(): Array<{ path: string; slot: number }> {
    return [...this.paths].map(([id, path]) => ({ path, slot: this.slotFor(id) }))
  }
}
