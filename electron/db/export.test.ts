import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openExportWriter } from './export'

const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'sqlkit-export-')), name)

describe('openExportWriter', () => {
  it('writes a CSV file with a header and every row across multiple chunks', async () => {
    const file = tmpFile('out.csv')
    const writer = openExportWriter(file, 'csv')
    writer.columns(['a', 'b'])
    await writer.rows([[1, 2], [3, 4]])
    await writer.rows([[5, 6]])
    const { rowCount } = await writer.close()
    expect(rowCount).toBe(3)
    expect(readFileSync(file, 'utf8')).toBe('a,b\n1,2\n3,4\n5,6\n')
  })

  it('escapes delimiters and neutralizes spreadsheet formulas like the buffered path', async () => {
    const file = tmpFile('escaped.csv')
    const writer = openExportWriter(file, 'csv')
    writer.columns(['v'])
    await writer.rows([['a,b'], ['=CMD']])
    await writer.close()
    expect(readFileSync(file, 'utf8')).toBe('v\n"a,b"\n\'=CMD\n')
  })

  it('writes a valid JSON array', async () => {
    const file = tmpFile('out.json')
    const writer = openExportWriter(file, 'json')
    writer.columns(['n'])
    await writer.rows([['x'], ['y']])
    const { rowCount } = await writer.close()
    expect(rowCount).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([{ n: 'x' }, { n: 'y' }])
  })

  it('still writes a valid, openable file when no rows are produced', async () => {
    const csvFile = tmpFile('empty.csv')
    const csv = openExportWriter(csvFile, 'csv')
    csv.columns(['a', 'b'])
    expect((await csv.close()).rowCount).toBe(0)
    expect(readFileSync(csvFile, 'utf8')).toBe('a,b\n')

    const jsonFile = tmpFile('empty.json')
    const json = openExportWriter(jsonFile, 'json')
    json.columns(['a'])
    await json.close()
    expect(JSON.parse(readFileSync(jsonFile, 'utf8'))).toEqual([])
  })

  it('rejects rows() when columns were never provided', async () => {
    const writer = openExportWriter(tmpFile('bad.csv'), 'csv')
    await expect(writer.rows([[1]])).rejects.toThrow(/columns/i)
  })
})
