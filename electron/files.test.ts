import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createWorkspaceFile,
  externalOpenAction,
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceFileAsync,
  renameWorkspaceFile,
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

  it('reports a deleted file as missing, through the reader the app uses', async () => {
    const { ws } = setup()
    const file = path.join(ws, 'query.sql')

    // Deliberately the async reader: `file:read` goes through that one, and a
    // `missing` flag only the sync twin sets would never reach the renderer.
    const gone = await readWorkspaceFileAsync(ws, file)
    expect(gone).toMatchObject({ success: false, missing: true })

    fs.writeFileSync(file, 'SELECT 1;')
    expect(await readWorkspaceFileAsync(ws, file)).toEqual({ success: true, content: 'SELECT 1;' })
    expect(readWorkspaceFile(ws, file)).toEqual({ success: true, content: 'SELECT 1;' })
  })

  it('leaves an unreadable file unflagged, so a tab is not orphaned over a bad read', () => {
    const { ws } = setup()
    // A directory where a file is expected reads as EISDIR, not ENOENT.
    fs.mkdirSync(path.join(ws, 'query.sql'))

    const result = readWorkspaceFile(ws, path.join(ws, 'query.sql'))

    expect(result.success).toBe(false)
    expect(result).not.toHaveProperty('missing')
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

// The watcher is the only other thing that notices a file changing, and on a
// network share it may never fire; the save itself has to check.
describe('saving over a file that changed on disk', () => {
  it('reports a conflict instead of overwriting, and saves when told to', async () => {
    const { ws } = setup()
    const file = path.join(ws, 'q.sql')
    fs.writeFileSync(file, 'select 1')
    fs.writeFileSync(file, 'select 1 -- pulled')

    expect(await saveWorkspaceFileAsync(ws, file, 'select 2', 'select 1')).toEqual({ success: false, conflict: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('select 1 -- pulled')
    expect(await saveWorkspaceFileAsync(ws, file, 'select 2', 'select 1 -- pulled')).toMatchObject({ success: true })
    expect(await saveWorkspaceFileAsync(ws, file, 'select 3')).toMatchObject({ success: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('select 3')
  })

  it('writes a deleted file back rather than calling it a conflict', async () => {
    const { ws } = setup()
    const file = path.join(ws, 'gone.sql')
    expect(await saveWorkspaceFileAsync(ws, file, 'select 1', 'what it held')).toMatchObject({ success: true })
    expect(fs.readFileSync(file, 'utf8')).toBe('select 1')
  })
})

describe('saving keeps what the file was', () => {
  it('writes through a symlink to its target instead of replacing the link', async () => {
    const { ws } = setup()
    fs.mkdirSync(path.join(ws, 'shared'))
    const real = path.join(ws, 'shared', 'q.sql')
    const link = path.join(ws, 'q.sql')
    fs.writeFileSync(real, 'select 1')
    fs.symlinkSync(real, link)

    expect(await saveWorkspaceFileAsync(ws, link, 'select 2', 'select 1')).toMatchObject({ success: true, path: link })
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(real, 'utf8')).toBe('select 2')
  })

  it('keeps the file mode', async () => {
    const { ws } = setup()
    const file = path.join(ws, 'private.sql')
    fs.writeFileSync(file, 'select 1', { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    await saveWorkspaceFileAsync(ws, file, 'select 2')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})

// A case-insensitive disk (macOS, Windows) opens .sqlkit under any spelling, so
// the internal folder is matched case-folded: the config holds credentials.
describe('the internal folder under another spelling', () => {
  it('refuses .SQLKIT paths for every file operation', async () => {
    const { ws } = setup()
    fs.mkdirSync(path.join(ws, '.sqlkit', 'backups'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.sqlkit', 'config.json'), '{}')
    fs.writeFileSync(path.join(ws, '.sqlkit', 'backups', 'abc.sql'), 'unsaved work')
    const refused = { success: false, error: 'The .sqlkit folder is internal' }

    for (const spelling of ['.SQLKIT', '.SqlKit']) {
      expect(resolveWorkspaceItem(ws, path.join(ws, spelling, 'config.json'))).toHaveProperty('error', refused.error)
      expect(renameWorkspaceFile(ws, path.join(ws, spelling, 'backups', 'abc.sql'), 'x.sql')).toEqual(refused)
      expect(await saveWorkspaceFileAsync(ws, path.join(ws, spelling, 'backups', 'abc.sql'), 'x')).toEqual(refused)
    }
    // Backups are .sql files, but they are only ever read through the session channel.
    expect(await readWorkspaceFileAsync(ws, path.join(ws, '.sqlkit', 'backups', 'abc.sql'))).toEqual(refused)
    expect(fs.readFileSync(path.join(ws, '.sqlkit', 'backups', 'abc.sql'), 'utf8')).toBe('unsaved work')
  })
})
