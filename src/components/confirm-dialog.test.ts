// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import './confirm-dialog'

describe('confirm-dialog presentation', () => {
  it('renders an icon-free destructive decision with shortcuts inside its buttons', async () => {
    const dialog = document.createElement('confirm-dialog')
    dialog.message = 'Drop table "users"?'
    dialog.detail = 'The table and its data will be removed.'
    dialog.confirmLabel = 'Drop table'
    dialog.danger = true
    document.body.append(dialog)
    await dialog.updateComplete

    const root = dialog.shadowRoot!
    expect(root.querySelector('.icon')).toBeNull()
    expect(root.querySelector('.panel')?.getAttribute('role')).toBe('alertdialog')
    expect(root.querySelector('button.primary')?.classList.contains('danger')).toBe(true)
    expect(root.querySelector('button.secondary')?.textContent?.replace(/\s/g, '')).toBe('Cancelesc')
    expect(root.querySelector('button.primary')?.textContent?.replace(/\s/g, '')).toBe('Droptable↵')

    dialog.remove()
  })

  it('renders a notice as a neutral acknowledge-only dialog', async () => {
    const dialog = document.createElement('confirm-dialog')
    dialog.message = 'Could not connect'
    dialog.detail = 'Authentication failed.'
    dialog.confirmLabel = 'OK'
    dialog.cancelLabel = null
    document.body.append(dialog)
    await dialog.updateComplete

    const root = dialog.shadowRoot!
    expect(root.querySelector('.panel')?.getAttribute('role')).toBe('dialog')
    expect(root.querySelector('button.secondary')).toBeNull()
    expect(root.querySelector('button.primary')?.classList.contains('danger')).toBe(false)
    expect(root.querySelector('button.primary')?.textContent?.replace(/\s/g, '')).toBe('OK↵')

    dialog.remove()
  })
})

describe('confirm-dialog keys', () => {
  it('ignores its opening Enter, then accepts a later bare Enter', async () => {
    const dialog = document.createElement('confirm-dialog')
    const confirmed = vi.fn()
    dialog.addEventListener('dialog-confirm', confirmed)
    document.body.append(dialog)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(confirmed).not.toHaveBeenCalled()

    await new Promise((resolve) => setTimeout(resolve, 0))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(confirmed).toHaveBeenCalledOnce()

    dialog.remove()
  })

  it('cancels on Escape and returns focus when removed', async () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    const dialog = document.createElement('confirm-dialog')
    const cancelled = vi.fn()
    dialog.addEventListener('dialog-cancel', () => {
      cancelled()
      dialog.remove()
    })
    document.body.append(dialog)
    await dialog.updateComplete

    expect(dialog.shadowRoot!.activeElement).toBe(dialog.shadowRoot!.querySelector('.panel'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(cancelled).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(outside)

    outside.remove()
  })
})
