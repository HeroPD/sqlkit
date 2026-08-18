import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Channel names are string literals on both ends, so tsc can't catch a handler
// added in a main-process IPC module without the matching invoke in preload.ts (or vice versa) —
// the very drift CLAUDE.md warns about. This pins the two ends together.
const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8')

const channels = (source: string, pattern: RegExp) => {
  const found = new Set<string>()
  for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1])
  return [...found].sort()
}

const main = [read('main.ts'), read('ipc-workspace.ts'), read('ipc-db.ts')].join('\n')
const preload = read('preload.ts')

describe('IPC contract: main ⇄ preload', () => {
  it('matches every preload invoke channel to a main handler', () => {
    const handled = channels(main, /ipcMain\.handle\(\s*'([^']+)'/g)
    const invoked = channels(preload, /ipcRenderer\.invoke\(\s*'([^']+)'/g)
    expect(invoked).toEqual(handled)
  })

  it('matches every preload sendSync channel to a main listener', () => {
    const listened = channels(main, /ipcMain\.on\(\s*'([^']+)'/g)
    const sent = channels(preload, /ipcRenderer\.sendSync\(\s*'([^']+)'/g)
    expect(sent).toEqual(listened)
  })

  it('matches every main broadcast channel to a preload listener', () => {
    const sent = channels(main, /\.send\(\s*'([^']+)'/g)
    const listened = channels(preload, /ipcRenderer\.on\(\s*'([^']+)'/g)
    expect(listened).toEqual(sent)
  })
})
