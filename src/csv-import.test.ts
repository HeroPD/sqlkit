import { describe, expect, it } from 'vitest'
import { csvShapeError, decodeCsvBytes, parseCsv } from './csv-import'

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

  it('drops trailing blank lines but keeps blank lines inside and quoted empty rows', () => {
    expect(parseCsv('a,b\n1,2\n\n').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(parseCsv('a,b\r\n1,2\r\n\r\n\r\n').rows).toEqual([['a', 'b'], ['1', '2']])
    expect(csvShapeError(parseCsv('a,b\n1,2\n\n').rows)).toBeNull()
    expect(parseCsv('a\n\n1\n').rows).toEqual([['a'], [''], ['1']])
    expect(parseCsv('a\n1\n""\n').rows).toEqual([['a'], ['1'], ['']])
    expect(parseCsv('a\n1\n \n').rows).toEqual([['a'], ['1'], [' ']])
  })
})

describe('decodeCsvBytes', () => {
  const utf16 = (text: string, bigEndian: boolean) => {
    const bytes = new Uint8Array(2 + text.length * 2)
    bytes.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe])
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      bytes[2 + index * 2] = bigEndian ? code >> 8 : code & 0xff
      bytes[3 + index * 2] = bigEndian ? code & 0xff : code >> 8
    }
    return bytes
  }

  it('decodes UTF-8 with or without a byte order mark', () => {
    const text = 'id,name\n1,Zoë\n'
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toBe(text)
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]))).toBe(text)
  })

  it('decodes UTF-16LE (Excel Unicode Text) and UTF-16BE by their byte order mark', () => {
    const text = 'id\tname\r\n1\tZoë — 東京\r\n'
    expect(decodeCsvBytes(utf16(text, false))).toBe(text)
    expect(decodeCsvBytes(utf16(text, true))).toBe(text)
    expect(parseCsv(decodeCsvBytes(utf16(text, false)), '\t').rows).toEqual([['id', 'name'], ['1', 'Zoë — 東京']])
  })

  it('refuses bytes that are not valid UTF-8 instead of importing replacement characters', () => {
    // "café" in Windows-1252.
    expect(() => decodeCsvBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toThrow(/isn’t UTF-8 or UTF-16/)
  })
})

describe('csvShapeError', () => {
  it('reports inconsistent row widths', () => {
    expect(csvShapeError([['a', 'b'], ['1']])).toContain('row 2')
    expect(csvShapeError([['a'], ['1']])).toBeNull()
  })
})

