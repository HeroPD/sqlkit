import { describe, expect, it } from 'vitest'
import { WorkspaceWindows } from './workspace-windows'

const WS = '/tmp/sqlkit-ws'
const OTHER = '/tmp/sqlkit-other'

describe('WorkspaceWindows slots', () => {
  it('gives the first window on a workspace slot 0, so its file is the one it always was', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, OTHER)

    expect(windows.slotFor(1)).toBe(0)
    expect(windows.slotFor(2)).toBe(0)
  })

  it('hands a second window on the same workspace its own slot', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, WS)
    windows.open(3, WS)

    expect([windows.slotFor(1), windows.slotFor(2), windows.slotFor(3)]).toEqual([0, 1, 2])
  })

  it('reuses the slot a closed window leaves, rather than counting ever upward', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, WS)
    windows.close(1)
    windows.open(3, WS)

    // Slot 0 is free again, so the new window restores the tabs the closed one
    // left behind instead of opening on an empty session.
    expect(windows.slotFor(3)).toBe(0)
    expect(windows.slotFor(2)).toBe(1)
  })

  it('reads a symlinked or trailing-slash path as the same workspace', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, `${WS}/`)

    expect(windows.slotFor(2)).toBe(1)
    expect(windows.owners(WS)).toEqual([1, 2])
  })

  it('moving a window to another workspace frees its slot on the old one', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, WS)
    windows.open(1, OTHER)

    expect(windows.owners(WS)).toEqual([2])
    expect(windows.slotFor(1)).toBe(0)
  })

  it('lists the windows sharing a workspace, and every open one for the quit sweep', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, WS)
    windows.open(3, OTHER)

    expect(windows.owners(WS, 1)).toEqual([2])
    expect(windows.all()).toEqual([
      { path: WS, slot: 0 },
      { path: WS, slot: 1 },
      { path: OTHER, slot: 0 },
    ])
  })
})

describe('WorkspaceWindows.raiseInstead', () => {
  it('lets a window with no workspace open a second view of one already open', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)

    // Window 2 is the blank one a New Window gave; opening WS there is the
    // side-by-side ask, not a request to be sent back to window 1.
    expect(windows.raiseInstead(WS, 2)).toEqual([])
  })

  it('raises the window that has it when the asker is already in a workspace', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, OTHER)

    expect(windows.raiseInstead(WS, 2)).toEqual([1])
  })

  it('leaves a window re-opening its own workspace where it is', () => {
    const windows = new WorkspaceWindows()
    windows.open(1, WS)
    windows.open(2, WS)

    expect(windows.raiseInstead(WS, 1)).toEqual([])
    expect(windows.raiseInstead(WS, 2)).toEqual([])
  })
})
