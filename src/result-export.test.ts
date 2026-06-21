import { describe, expect, it } from 'vitest'
import { cellToTsv, cellsToTsv, formulaSafeText, rowToTsv, toDelimited, toJson } from './result-export'

describe('cellToTsv', () => {
  it('returns plain values unchanged', () => {
    expect(cellToTsv('hello')).toBe('hello')
    expect(cellToTsv(42)).toBe('42')
  })

  it('does not quote a single value just because it contains quotes', () => {
    expect(cellToTsv('say "hi"')).toBe('say "hi"')
  })

  it('renders null and undefined as empty', () => {
    expect(cellToTsv(null)).toBe('')
    expect(cellToTsv(undefined)).toBe('')
  })

  it('quotes a value with an embedded tab so it cannot split into extra cells', () => {
    expect(cellToTsv('safe\t=HYPERLINK("x")')).toBe('"safe\t=HYPERLINK(""x"")"')
  })

  it('quotes a value with an embedded newline so it cannot split into a new row', () => {
    expect(cellToTsv('safe\n=evil')).toBe('"safe\n=evil"')
  })

  it('neutralizes a formula-leading value', () => {
    expect(cellToTsv('=evil')).toBe("'=evil")
  })

  it('does not mangle a negative number', () => {
    expect(cellToTsv(-5)).toBe('-5')
  })
})

describe('formulaSafeText', () => {
  it('prefixes string cells that start with a formula trigger', () => {
    expect(formulaSafeText('=1+2', '=1+2')).toBe("'=1+2")
    expect(formulaSafeText('@SUM(A1)', '@SUM(A1)')).toBe("'@SUM(A1)")
    expect(formulaSafeText('-cmd|calc', '-cmd|calc')).toBe("'-cmd|calc")
    expect(formulaSafeText('+1', '+1')).toBe("'+1")
    expect(formulaSafeText('\tx', '\tx')).toBe("'\tx")
  })

  it('leaves harmless string cells untouched', () => {
    expect(formulaSafeText('hello', 'hello')).toBe('hello')
    expect(formulaSafeText('', '')).toBe('')
  })

  it('does not neutralize non-string values even if the formatted text looks like a formula', () => {
    expect(formulaSafeText(-5, '-5')).toBe('-5')
    expect(formulaSafeText(5, '5')).toBe('5')
  })
})

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

  it('neutralizes spreadsheet formula triggers in string cells', () => {
    expect(toDelimited(['v'], [['=1+2']], ',')).toBe("v\n'=1+2")
    expect(toDelimited(['v'], [['@SUM(A1)']], ',')).toBe("v\n'@SUM(A1)")
    expect(toDelimited(['v'], [['-cmd|calc']], ',')).toBe("v\n'-cmd|calc")
    expect(toDelimited(['v'], [['+1']], ',')).toBe("v\n'+1")
  })

  it('neutralizes a formula trigger that also needs quoting', () => {
    expect(toDelimited(['v'], [['=1,2']], ',')).toBe('v\n"\'=1,2"')
  })

  it('neutralizes a hostile column name', () => {
    expect(toDelimited(['=evil'], [[1]], ',')).toBe("'=evil\n1")
  })

  it('does not mangle numeric cells with a leading minus or plus', () => {
    expect(toDelimited(['v'], [[-5]], ',')).toBe('v\n-5')
  })
})

describe('cellsToTsv', () => {
  it('joins a 2D block with tabs and newlines', () => {
    expect(cellsToTsv([[1, 'a'], [2, 'b']])).toBe('1\ta\n2\tb')
  })

  it('quotes a cell with an embedded tab so it cannot split into a new formula cell', () => {
    expect(cellsToTsv([['safe\t=HYPERLINK("x")']])).toBe('"safe\t=HYPERLINK(""x"")"')
  })

  it('quotes a cell with an embedded newline so it cannot split into a new row', () => {
    expect(cellsToTsv([['safe\n=evil']])).toBe('"safe\n=evil"')
  })

  it('neutralizes a formula-leading cell', () => {
    expect(cellsToTsv([['=evil']])).toBe("'=evil")
  })

  it('renders null and undefined cells as empty', () => {
    expect(cellsToTsv([[null, undefined]])).toBe('\t')
  })
})

describe('rowToTsv', () => {
  it('joins one row with tabs', () => {
    expect(rowToTsv([1, 'two', null])).toBe('1\ttwo\t')
  })

  it('neutralizes a formula trigger in a string cell', () => {
    expect(rowToTsv(['=cmd', 2])).toBe("'=cmd\t2")
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
