import { describe, expect, it } from 'vitest'
import { rowToTsv, toDelimited, toJson } from './result-export'

describe('toDelimited', () => {
  it('renders csv with a header row', () => {
    expect(toDelimited(['id', 'name'], [[1, 'a'], [2, 'b']], ',')).toBe('id,name\n1,a\n2,b')
  })

  it('quotes fields containing the delimiter, quotes, or newlines', () => {
    expect(toDelimited(['v'], [['a,b']], ',')).toBe('v\n"a,b"')
    expect(toDelimited(['v'], [['say "hi"']], ',')).toBe('v\n"say ""hi"""')
    expect(toDelimited(['v'], [['line1\nline2']], ',')).toBe('v\n"line1\nline2"')
  })

  it('renders nulls as empty and objects as JSON', () => {
    expect(toDelimited(['a', 'b'], [[null, { x: 1 }]], ',')).toBe('a,b\n,"{""x"":1}"')
  })

  it('supports tabs as the delimiter', () => {
    expect(toDelimited(['a', 'b'], [[1, 'x\ty']], '\t')).toBe('a\tb\n1\t"x\ty"')
  })
})

describe('rowToTsv', () => {
  it('joins one row with tabs', () => {
    expect(rowToTsv([1, 'two', null])).toBe('1\ttwo\t')
  })
})

describe('toJson', () => {
  it('builds objects keyed by column names', () => {
    expect(JSON.parse(toJson(['id', 'name'], [[1, 'a']]))).toEqual([{ id: 1, name: 'a' }])
  })

  it('suffixes duplicate column names instead of dropping values', () => {
    expect(JSON.parse(toJson(['id', 'id'], [[1, 2]]))).toEqual([{ id: 1, id_2: 2 }])
  })

  it('maps missing and undefined cells to null', () => {
    expect(JSON.parse(toJson(['a', 'b'], [[1]]))).toEqual([{ a: 1, b: null }])
  })
})
