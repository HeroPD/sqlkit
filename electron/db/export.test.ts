import { describe, expect, it } from 'vitest'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openExportWriter, writeExportAtomically } from './export'

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

  it('writes a runnable INSERT per row for the sql format', async () => {
    const file = tmpFile('out.sql')
    const writer = openExportWriter(file, 'sql', { engine: 'mysql', table: { schema: null, name: 'users', kind: 'table' } })
    writer.columns(['id', 'note'])
    await writer.rows([[1, "it's"], [2, null]])
    const { rowCount } = await writer.close()
    expect(rowCount).toBe(2)
    expect(readFileSync(file, 'utf8')).toBe(
      'INSERT INTO `users` (`id`, `note`)\n' +
        "VALUES (1, 'it''s');\n" +
        'INSERT INTO `users` (`id`, `note`)\n' +
        'VALUES (2, NULL);\n',
    )
  })

  it('never truncates an existing file: it only fills a fresh one', async () => {
    const file = tmpFile('taken.csv')
    writeFileSync(file, 'keep me')
    const writer = openExportWriter(file, 'csv')
    writer.columns(['a'])
    await expect(writer.close()).rejects.toThrow(/EEXIST/)
    expect(readFileSync(file, 'utf8')).toBe('keep me')
  })

  it('rejects rows() when columns were never provided', async () => {
    const writer = openExportWriter(tmpFile('bad.csv'), 'csv')
    await expect(writer.rows([[1]])).rejects.toThrow(/columns/i)
  })
})

describe('writeExportAtomically', () => {
  it('keeps the original and leaves no temp file when the write fails partway', async () => {
    const file = tmpFile('results.csv')
    writeFileSync(file, 'keep me')
    await expect(writeExportAtomically(file, async (temp) => {
      await writeFile(temp, 'half a result', { flag: 'wx' })
      throw new Error('disk full')
    })).rejects.toThrow('disk full')
    expect(readFileSync(file, 'utf8')).toBe('keep me')
    expect(readdirSync(dirname(file))).toEqual(['results.csv'])
  })

  it('renames the finished temp file over the target', async () => {
    const file = tmpFile('results.json')
    writeFileSync(file, 'old')
    const result = await writeExportAtomically(file, async (temp) => {
      expect(dirname(temp)).toBe(realpathSync(dirname(file)))
      await writeFile(temp, '[]', { flag: 'wx' })
      return 7
    })
    expect(result).toBe(7)
    expect(readFileSync(file, 'utf8')).toBe('[]')
    expect(readdirSync(dirname(file))).toEqual(['results.json'])
  })

  it('writes a new file when none exists yet', async () => {
    const file = tmpFile('fresh.tsv')
    await writeExportAtomically(file, (temp) => writeFile(temp, 'a\n', { flag: 'wx' }))
    expect(readFileSync(file, 'utf8')).toBe('a\n')
  })

  it('replaces a symlinked target at its destination, keeping the link', async () => {
    const real = tmpFile('real.csv')
    writeFileSync(real, 'old')
    const link = join(dirname(real), 'link.csv')
    symlinkSync(real, link)
    await writeExportAtomically(link, (temp) => writeFile(temp, 'new', { flag: 'wx' }))
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toBe('new')
  })
})
