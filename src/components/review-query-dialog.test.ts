import { describe, expect, it } from 'vitest'
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
