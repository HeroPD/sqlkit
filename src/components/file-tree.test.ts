// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { FileInfo } from '../electron'
import { FileTree, type FileCreateDetail, type FileDeleteDetail, type FileRenameDetail } from './file-tree'

type Node = { type: 'file' | 'folder'; name: string; relativePath: string; file?: FileInfo }
type Editing = { mode: 'rename'; relativePath: string } | { mode: 'create'; parent: string } | null

const internals = (tree: FileTree) =>
  tree as never as {
    _expanded: Set<string>
    _editing: Editing
    _onRow(node: Node): void
    _onMenuPick(id: string, node: Node | null): void
    _onEditKeydown(event: KeyboardEvent): void
    _requestDelete(node: Node): void
  }

const file = (relativePath: string): FileInfo => ({
  type: 'file',
  name: relativePath.split('/').pop() ?? '',
  path: `/ws/${relativePath}`,
  relativePath,
})

const fileNode = (info: FileInfo): Node => ({ type: 'file', name: info.name, relativePath: info.relativePath, file: info })

// A keydown whose target carries the edit input's value; jsdom KeyboardEvents
// have no settable target, so tests fake the two fields the handler reads.
const editKey = (key: string, value: string) =>
  ({ key, preventDefault: () => {}, target: { value } }) as never as KeyboardEvent

const capture = <T>(tree: FileTree, type: string) => {
  const seen: T[] = []
  tree.addEventListener(type, (e) => seen.push((e as CustomEvent<T>).detail))
  return seen
}

describe('FileTree rows', () => {
  it('toggles folder expansion on click and opens files', () => {
    const tree = new FileTree()
    const inner = internals(tree)
    const opened = capture<{ file: FileInfo }>(tree, 'file-open')
    const folder: Node = { type: 'folder', name: 'reports', relativePath: 'reports' }

    inner._onRow(folder)
    expect(inner._expanded.has('reports')).toBe(true)
    inner._onRow(folder)
    expect(inner._expanded.has('reports')).toBe(false)

    const info = file('reports/q1.sql')
    inner._onRow(fileNode(info))
    expect(opened).toEqual([{ file: info }])
  })
})

describe('FileTree create flow', () => {
  it('starts creating inside the right parent and expands it', () => {
    const tree = new FileTree()
    const inner = internals(tree)

    inner._onMenuPick('new', fileNode(file('reports/q1.sql')))
    expect(inner._editing).toEqual({ mode: 'create', parent: 'reports' })
    expect(inner._expanded.has('reports')).toBe(true)

    inner._onMenuPick('new', null)
    expect(inner._editing).toEqual({ mode: 'create', parent: '' })
  })

  it('dispatches file-create on Enter and rejects names with separators', () => {
    const tree = new FileTree()
    const inner = internals(tree)
    const created = capture<FileCreateDetail>(tree, 'file-create')

    inner._editing = { mode: 'create', parent: 'reports' }
    inner._onEditKeydown(editKey('Enter', '  q2.sql  '))
    expect(created).toEqual([{ parent: 'reports', name: 'q2.sql' }])
    expect(inner._editing).toBeNull()

    inner._editing = { mode: 'create', parent: '' }
    inner._onEditKeydown(editKey('Enter', 'a/b.sql'))
    expect(created).toHaveLength(1)
  })

  it('cancels editing on Escape without dispatching', () => {
    const tree = new FileTree()
    const inner = internals(tree)
    const created = capture<FileCreateDetail>(tree, 'file-create')

    inner._editing = { mode: 'create', parent: '' }
    inner._onEditKeydown(editKey('Escape', 'q.sql'))
    expect(inner._editing).toBeNull()
    expect(created).toHaveLength(0)
  })
})

describe('FileTree rename flow', () => {
  it('dispatches file-rename only when the name actually changed', () => {
    const tree = new FileTree()
    const info = file('q1.sql')
    tree.files = [info]
    const inner = internals(tree)
    const renamed = capture<FileRenameDetail>(tree, 'file-rename')

    inner._editing = { mode: 'rename', relativePath: 'q1.sql' }
    inner._onEditKeydown(editKey('Enter', 'q1.sql'))
    expect(renamed).toHaveLength(0)

    inner._editing = { mode: 'rename', relativePath: 'q1.sql' }
    inner._onEditKeydown(editKey('Enter', 'revenue.sql'))
    expect(renamed).toEqual([{ file: info, newName: 'revenue.sql' }])
  })
})

describe('FileTree delete flow', () => {
  it('resolves the absolute path from the flat file list', () => {
    const tree = new FileTree()
    const info = file('reports/q1.sql')
    tree.files = [info]
    const deleted = capture<FileDeleteDetail>(tree, 'file-delete')

    internals(tree)._requestDelete(fileNode(info))
    expect(deleted).toEqual([{ path: '/ws/reports/q1.sql', name: 'q1.sql' }])
  })

  it('ignores nodes with no backing FileInfo (synthesized folders)', () => {
    const tree = new FileTree()
    tree.files = [file('reports/q1.sql')]
    const deleted = capture<FileDeleteDetail>(tree, 'file-delete')

    internals(tree)._requestDelete({ type: 'folder', name: 'reports', relativePath: 'reports' })
    expect(deleted).toHaveLength(0)
  })
})
