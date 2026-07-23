import { describe, expect, it } from 'vitest'
import { queryErrorLine } from './error-line'

describe('queryErrorLine', () => {
  it('maps a postgres character position to its line', () => {
    const sql = 'SELECT 1;\nSELECT oops\nFROM t;'
    expect(queryErrorLine({ position: '1' }, sql)).toBe(1)
    expect(queryErrorLine({ position: String(sql.indexOf('oops') + 1) }, sql)).toBe(2)
    expect(queryErrorLine({ position: String(sql.indexOf('FROM') + 1) }, sql)).toBe(3)
  })

  it('rejects positions outside the submitted SQL', () => {
    expect(queryErrorLine({ position: '999' }, 'SELECT 1;')).toBeUndefined()
    expect(queryErrorLine({ position: '0' }, 'SELECT 1;')).toBeUndefined()
    expect(queryErrorLine({ position: 'abc' }, 'SELECT 1;')).toBeUndefined()
  })

  it('uses SQL Server lineNumber, capped to the script length', () => {
    expect(queryErrorLine({ lineNumber: 2 }, 'SELECT 1\nFROM x\nWHERE y')).toBe(2)
    expect(queryErrorLine({ lineNumber: 50 }, 'SELECT 1\nFROM x')).toBe(2)
  })

  it('skips lineNumber when GO batches shift the numbering', () => {
    expect(queryErrorLine({ lineNumber: 1 }, 'SELECT 1\nGO\nSELECT oops')).toBeUndefined()
  })

  it('parses the trailing "at line N" of a MySQL message', () => {
    const message = "You have an error in your SQL syntax; check the manual near 'oops' at line 3"
    expect(queryErrorLine({ message }, 'SELECT 1,\n2,\noops')).toBe(3)
  })

  it('returns undefined when nothing is reported', () => {
    expect(queryErrorLine(new Error('near "x": syntax error'), 'SELECT x')).toBeUndefined()
    expect(queryErrorLine(undefined, 'SELECT x')).toBeUndefined()
  })
})
