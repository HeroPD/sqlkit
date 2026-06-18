// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ReactiveControllerHost } from 'lit'
import { DialogsController } from './dialogs'

const host = (): ReactiveControllerHost =>
  ({ addController() {}, removeController() {}, requestUpdate() {}, updateComplete: Promise.resolve(true) })

describe('DialogsController confirm', () => {
  it('runs the action and clears on accept', () => {
    const d = new DialogsController(host())
    const action = vi.fn()
    d.confirm = { message: 'Drop?', detail: '', confirmLabel: 'Drop', action }
    expect(d.confirm).not.toBeNull()

    d.acceptConfirm()
    expect(action).toHaveBeenCalledOnce()
    expect(d.confirm).toBeNull()
  })

  it('keeps a follow-up dialog that the action itself opens', () => {
    const d = new DialogsController(host())
    d.confirm = {
      message: 'First',
      detail: '',
      confirmLabel: 'OK',
      action: () => {
        d.confirm = { message: 'Second', detail: '', confirmLabel: 'OK', action: () => {} }
      },
    }
    d.acceptConfirm()
    expect(d.confirm?.message).toBe('Second')
  })
})

describe('DialogsController notice', () => {
  it('opens a confirm with an acknowledge-only action', () => {
    const d = new DialogsController(host())
    d.notice('Failed', 'reason')
    expect(d.confirm).toMatchObject({ message: 'Failed', detail: 'reason', confirmLabel: 'OK' })
    d.acceptConfirm()
    expect(d.confirm).toBeNull()
  })
})

describe('DialogsController prompt', () => {
  it('passes the entered value to the action and clears', () => {
    const d = new DialogsController(host())
    const action = vi.fn()
    d.prompt = { message: 'Name', detail: '', confirmLabel: 'Create', placeholder: '', action }

    d.acceptPrompt(new CustomEvent('dialog-confirm', { detail: { value: 'analytics' } }))
    expect(action).toHaveBeenCalledWith('analytics')
    expect(d.prompt).toBeNull()
  })
})

describe('DialogsController hostDisconnected', () => {
  it('clears any open dialog', () => {
    const d = new DialogsController(host())
    d.confirm = { message: 'x', detail: '', confirmLabel: 'OK', action: () => {} }
    d.prompt = { message: 'y', detail: '', confirmLabel: 'OK', placeholder: '', action: () => {} }
    d.hostDisconnected()
    expect(d.confirm).toBeNull()
    expect(d.prompt).toBeNull()
  })
})
