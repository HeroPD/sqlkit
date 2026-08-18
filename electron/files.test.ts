import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createWorkspaceFile,
  externalOpenAction,
  listWorkspaceFiles,
  readWorkspaceFile,
  resolveWorkspaceItem,
  saveWorkspaceFile,
  saveWorkspaceFileAsync,
} from './files'

// Each test gets a fresh workspace plus a sibling "outside" dir that a symlink
// inside the workspace can try to escape into.
const roots: string[] = []
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlkit-files-'))
  const ws = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(ws)
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.sql'), 'SELECT secrets;')
  roots.push(base)
  return { ws, outside }
}

afterEach(() => {
  for (const base of roots.splice(0)) fs.rmSync(base, { recursive: true, force: true })
})

describe('workspace file containment', () => {
  it('reads a real .sql file inside the workspace', () => {
    const { ws } = setup()
    fs.writeFileSync(path.join(ws, 'query.sql'), 'SELECT 1;')
    const result = readWorkspaceFile(ws, path.join(ws, 'query.sql'))
    expect(result).toEqual({ success: true, content: 'SELECT 1;' })
  })

  it('refuses to read through a symlinked directory that escapes the workspace', () => {
    const { ws, outside } = setup()
    fs.symlinkSync(outside, path.join(ws, 'escape'))
    const result = readWorkspaceFile(ws, path.join(ws, 'escape', 'secret.sql'))
    expect(result.success).toBe(false)
  })

  it('refuses to read through a symlinked file that escapes the workspace', () => {
    const { ws, outside } = setup()
    fs.symlinkSync(path.join(outside, 'secret.sql'), path.join(ws, 'link.sql'))
    const result = readWorkspaceFile(ws, path.join(ws, 'link.sql'))
    expect(result.success).toBe(false)
  })

  it('refuses to read a lexically escaping path', () => {
    const { ws } = setup()
    const result = readWorkspaceFile(ws, path.join(ws, '..', 'outside', 'secret.sql'))
    expect(result.success).toBe(false)
  })

  it('saves inside the workspace but refuses to write through an escaping symlink', () => {
    const { ws, outside } = setup()
    expect(saveWorkspaceFile(ws, path.join(ws, 'ok.sql'), 'x').success).toBe(true)

    fs.symlinkSync(outside, path.join(ws, 'escape'))
    const result = saveWorkspaceFile(ws, path.join(ws, 'escape', 'evil.sql'), 'pwned')
    expect(result.success).toBe(false)
    expect(fs.existsSync(path.join(outside, 'evil.sql'))).toBe(false)
  })

  it('refuses to write through a broken symlink whose target would be outside', () => {
    const { ws, outside } = setup()
    const outsideTarget = path.join(outside, 'new.sql')
    fs.symlinkSync(outsideTarget, path.join(ws, 'link.sql'))

    const result = saveWorkspaceFile(ws, path.join(ws, 'link.sql'), 'pwned')

    expect(result.success).toBe(false)
    expect(fs.existsSync(outsideTarget)).toBe(false)
  })

  it('refuses to create a file in a context folder that symlinks outside', () => {
    const { ws, outside } = setup()
    fs.symlinkSync(outside, path.join(ws, 'conn'))
    const result = createWorkspaceFile(ws, 'conn', 'new')
    expect(result.success).toBe(false)
    expect(fs.existsSync(path.join(outside, 'new.sql'))).toBe(false)
  })

  it('refuses to create through a broken symlinked context folder', () => {
    const { ws, outside } = setup()
    fs.symlinkSync(path.join(outside, 'missing-folder'), path.join(ws, 'conn'))

    const result = createWorkspaceFile(ws, 'conn', 'new')

    expect(result.success).toBe(false)
    expect(fs.existsSync(path.join(outside, 'missing-folder', 'new.sql'))).toBe(false)
  })

  it('refuses to list a context folder symlinked outside the workspace', () => {
    const { ws, outside } = setup()
    fs.symlinkSync(outside, path.join(ws, 'conn'))

    const result = listWorkspaceFiles(ws, 'conn')

    expect(result.success).toBe(false)
  })

  it('refuses to list or resolve a context folder symlinked into .sqlkit', () => {
    const { ws } = setup()
    fs.mkdirSync(path.join(ws, '.sqlkit'))
    fs.writeFileSync(path.join(ws, '.sqlkit', 'config.json'), '{}')
    fs.symlinkSync(path.join(ws, '.sqlkit'), path.join(ws, 'conn'))

    expect(listWorkspaceFiles(ws, 'conn')).toEqual({ success: false, error: 'The .sqlkit folder is internal' })
    expect(resolveWorkspaceItem(ws, path.join(ws, 'conn', 'config.json'))).toHaveProperty('error', 'The .sqlkit folder is internal')
  })

  it('resolves a real workspace item but rejects an escaping symlink', () => {
    const { ws, outside } = setup()
    fs.writeFileSync(path.join(ws, 'real.sql'), 'x')
    expect(resolveWorkspaceItem(ws, path.join(ws, 'real.sql'))).toHaveProperty('path')

    fs.symlinkSync(path.join(outside, 'secret.sql'), path.join(ws, 'link.sql'))
    expect(resolveWorkspaceItem(ws, path.join(ws, 'link.sql'))).toHaveProperty('error')
  })

  it('can reject the workspace root for destructive operations', () => {
    const { ws } = setup()

    expect(resolveWorkspaceItem(ws, ws)).toHaveProperty('path')
    expect(resolveWorkspaceItem(ws, ws, { allowRoot: false })).toHaveProperty('error')
  })
})

describe('open-external safety', () => {
  it('opens safe document, data and image files', () => {
    const { ws } = setup()
    for (const name of ['export.csv', 'notes.txt', 'data.json', 'sheet.xlsx', 'chart.png', 'report.pdf']) {
      fs.writeFileSync(path.join(ws, name), '')
      expect(externalOpenAction(path.join(ws, name))).toBe('open')
    }
  })

  it('rejects executables, scripts and HTML', () => {
    const { ws } = setup()
    for (const name of ['run.command', 'install.sh', 'macro.scpt', 'page.html', 'tool.exe', 'app.desktop', 'x.js']) {
      fs.writeFileSync(path.join(ws, name), '')
      expect(externalOpenAction(path.join(ws, name))).toBe('reject')
    }
  })

  it('reveals directories rather than opening them, so a .app bundle is never launched', () => {
    const { ws } = setup()
    fs.mkdirSync(path.join(ws, 'plain'))
    fs.mkdirSync(path.join(ws, 'malicious.app'))
    expect(externalOpenAction(path.join(ws, 'plain'))).toBe('reveal')
    expect(externalOpenAction(path.join(ws, 'malicious.app'))).toBe('reveal')
  })

  it('rejects a path that does not exist', () => {
    const { ws } = setup()
    expect(externalOpenAction(path.join(ws, 'gone.csv'))).toBe('reject')
  })
})

// Saves land through a temp file and a rename. Two of them racing on the same
// path (⌘S held down, or ⌘S then the menu item) must not collide on it.
describe('concurrent saves of one file', () => {
  it('lets both finish, with the file holding one of the two versions', async () => {
    const { ws } = setup()
    const target = path.join(ws, 'q.sql')
    fs.writeFileSync(target, 'original')

    const results = await Promise.all([
      saveWorkspaceFileAsync(ws, target, 'select 1'),
      saveWorkspaceFileAsync(ws, target, 'select 2'),
    ])

    expect(results.map((result) => result.success)).toEqual([true, true])
    expect(['select 1', 'select 2']).toContain(fs.readFileSync(target, 'utf8'))
  })

  it('leaves no temp file behind, however many saves raced', async () => {
    const { ws } = setup()
    const target = path.join(ws, 'q.sql')
    await Promise.all(Array.from({ length: 8 }, (_, index) => saveWorkspaceFileAsync(ws, target, `select ${index}`)))

    const leftovers = fs.readdirSync(ws).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })
})
