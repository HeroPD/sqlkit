import { describe, expect, it } from 'vitest'
import { csvShapeError, parseCsv } from './csv-import'

describe('parseCsv', () => {
  it('parses headers, CRLF rows, escaped quotes, delimiters, and embedded newlines', () => {
    expect(parseCsv('\uFEFFid,name,note\r\n1,"Ada, L.","said ""hi"""\r\n2,Bob,"two\nlines"\r\n').rows).toEqual([
      ['id', 'name', 'note'],
      ['1', 'Ada, L.', 'said "hi"'],
      ['2', 'Bob', 'two\nlines'],
    ])
  })

  it('supports tab-separated input and preserves empty fields', () => {
    expect(parseCsv('a\tb\n\t2', '\t').rows).toEqual([['a', 'b'], ['', '2']])
  })

  it('rejects unterminated quoted fields', () => {
    expect(() => parseCsv('a,"open')).toThrow(/unterminated/i)
  })
})

describe('csvShapeError', () => {
  it('reports inconsistent row widths', () => {
    expect(csvShapeError([['a', 'b'], ['1']])).toContain('row 2')
    expect(csvShapeError([['a'], ['1']])).toBeNull()
  })
})

