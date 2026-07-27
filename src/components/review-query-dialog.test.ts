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
