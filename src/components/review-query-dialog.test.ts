// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import './review-query-dialog'
import { previewSql, sqlPreviewParts } from './review-query-dialog'

describe('previewSql', () => {
  it('combines Postgres placeholders with formatted params', () => {
    expect(previewSql('update users set name = $1 where id = $2', ["O'Malley", 7])).toBe(
      "update users set name = 'O''Malley' where id = 7",
    )
  })

  it('combines SQLite placeholders in order', () => {
    expect(previewSql('update notes set body = ? where id = ?', [null, 3])).toBe(
      'update notes set body = NULL where id = 3',
    )
  })

  it('combines SQL Server named placeholders, including double-digit positions', () => {
    expect(
      previewSql('update t set a = @p1 where id = @p10 and b = @p2', ['x', 'y', 0, 0, 0, 0, 0, 0, 0, 42]),
    ).toBe("update t set a = 'x' where id = 42 and b = 'y'")
  })

  it('leaves missing placeholders untouched', () => {
    expect(previewSql('select $1, $2', ['x'])).toBe("select 'x', $2")
  })
})

describe('sqlPreviewParts', () => {
  it('marks SQL keywords and strings', () => {
    const parts = sqlPreviewParts("UPDATE users SET name = 'Ada' WHERE id = 7")

    expect(parts.filter((part) => part.kind === 'keyword').map((part) => part.text)).toEqual([
      'UPDATE',
      'SET',
      'WHERE',
    ])
    expect(parts.filter((part) => part.kind === 'string').map((part) => part.text)).toEqual(["'Ada'"])
  })

  it('does not highlight keywords inside escaped strings', () => {
    const parts = sqlPreviewParts("UPDATE users SET name = 'O''FROM' WHERE id = 7")

    expect(parts.filter((part) => part.kind === 'string').map((part) => part.text)).toEqual(["'O''FROM'"])
    expect(parts.filter((part) => part.kind === 'keyword').map((part) => part.text)).toEqual([
      'UPDATE',
      'SET',
      'WHERE',
    ])
  })
})

describe('review-query-dialog presentation', () => {
  it('shows destructive copy and action without a separate risk callout', async () => {
    const dialog = document.createElement('review-query-dialog')
    dialog.sql = 'delete from users'
    dialog.heading = 'Run destructive query?'
    dialog.description = 'This DELETE will remove every row and cannot be undone.'
    dialog.danger = true
    dialog.confirmLabel = 'Run anyway'
    document.body.append(dialog)
    await dialog.updateComplete

    const root = dialog.shadowRoot!
    expect(root.querySelector('h4')?.textContent).toBe('Run destructive query?')
    expect(root.querySelector('.heading p')?.textContent).toBe(dialog.description)
    expect(root.querySelector('.warning')).toBeNull()
    expect(root.querySelector('.icon-list-x')).not.toBeNull()
    expect(root.querySelector('button.primary')?.classList.contains('danger')).toBe(true)
    expect(root.querySelector('.shortcuts')).toBeNull()
    expect(root.querySelector('button.secondary')?.textContent?.replace(/\s/g, '')).toBe('Cancelesc')
    expect(root.querySelector('button.primary')?.textContent?.replace(/\s/g, '')).toBe('Runanyway↵')

    dialog.remove()
  })

  it('uses normal review defaults and the existing file-code icon', async () => {
    const dialog = document.createElement('review-query-dialog')
    dialog.sql = 'update t set a = 1 where id = 2'
    document.body.append(dialog)
    await dialog.updateComplete

    const root = dialog.shadowRoot!
    expect(root.querySelector('h4')?.textContent).toBe('Review changes')
    expect(root.querySelector('.heading p')?.textContent).toBe('Review the generated SQL before applying changes.')
    expect(root.querySelector('.icon-file-code')).not.toBeNull()
    expect(root.querySelector('button.primary')?.classList.contains('danger')).toBe(false)
    expect(root.querySelector('button.primary')?.textContent?.replace(/\s/g, '')).toBe('Applychanges↵')

    dialog.remove()
  })

  it('shows failures as inline text and restores the actions', async () => {
    const dialog = document.createElement('review-query-dialog')
    dialog.sql = 'update t set a = 1'
    dialog.run = () => Promise.resolve('permission denied')
    document.body.append(dialog)
    await dialog.updateComplete

    dialog.shadowRoot!.querySelector<HTMLButtonElement>('button.primary')!.click()
    await dialog.updateComplete
    await Promise.resolve()
    await dialog.updateComplete

    expect(dialog.shadowRoot!.querySelector('.error')?.textContent).toBe('permission denied')
    expect(dialog.shadowRoot!.querySelector('.error')?.getAttribute('role')).toBe('alert')
    expect(dialog.shadowRoot!.querySelector<HTMLButtonElement>('button.primary')?.disabled).toBe(false)

    dialog.remove()
  })
})

describe('review-query-dialog confirm keys', () => {
  // Regression: ⌘↵ in the editor opens this dialog while its own keydown is
  // still travelling to window, where the dialog — mounted in the microtask
  // between — read it as Enter and ran the statement before it was ever seen.
  it('ignores the keystroke that opened it', async () => {
    const dialog = document.createElement('review-query-dialog')
    let ran = 0
    dialog.run = () => {
      ran += 1
      return Promise.resolve(null)
    }
    document.body.append(dialog)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }))
    expect(ran).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 0))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(ran).toBe(1)

    dialog.remove()
  })

  // A second ⌘↵ out of habit must not stand in for reading the dialog.
  it('confirms on a bare Enter only', async () => {
    const dialog = document.createElement('review-query-dialog')
    let ran = 0
    dialog.run = () => {
      ran += 1
      return Promise.resolve(null)
    }
    document.body.append(dialog)
    await new Promise((resolve) => setTimeout(resolve, 0))

    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true }))
    }
    expect(ran).toBe(0)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(ran).toBe(1)

    dialog.remove()
  })
})

describe('review-query-dialog focus', () => {
  // Regression: the dialog listens for Escape on window without taking focus,
  // so one press landed twice — the JSON editor behind it closed itself and
  // returned to the grid, and the dialog cancelled.
  it('takes focus on open, so Escape cannot reach what was focused before', async () => {
    const outside = document.createElement('textarea')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    const dialog = document.createElement('review-query-dialog')
    dialog.sql = 'update t set a = 1'
    document.body.append(dialog)
    await dialog.updateComplete

    expect(document.activeElement).toBe(dialog)
    expect(dialog.shadowRoot!.activeElement).toBe(dialog.shadowRoot!.querySelector('.panel'))

    const cancelled: string[] = []
    dialog.addEventListener('dialog-cancel', () => cancelled.push('cancel'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(cancelled).toEqual(['cancel'])

    dialog.remove()
    // Closing hands focus back, so the next Escape reaches the editor the user
    // was in instead of falling on the body.
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
