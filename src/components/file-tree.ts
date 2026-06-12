import { LitElement, css, html, type PropertyValues, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import type { FileInfo } from '../electron'
import './context-menu'
import type { MenuItem, MenuPickDetail } from './context-menu'

type FileNode = {
  type: 'file' | 'folder'
  name: string
  relativePath: string
  file?: FileInfo
  children: Map<string, FileNode>
}

export type FileRenameDetail = { file: FileInfo; newName: string }
/** parent is ''-rooted, '/'-separated, relative to the context folder. */
export type FileCreateDetail = { parent: string; name: string }
export type FileDeleteDetail = { path: string; name: string }

type Editing = { mode: 'rename'; relativePath: string } | { mode: 'create'; parent: string }

type Menu = { x: number; y: number; node: FileNode | null }

const isMac = navigator.platform.startsWith('Mac')

const parentOf = (relativePath: string) => relativePath.split('/').slice(0, -1).join('/')

// All file types are listed; the icon hints at what opening will do (.sql →
// editor, the rest → system default app).
const fileIcon = (name: string) => {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'sql') return 'codicon-file-code'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'mp4', 'mov'].includes(ext)) return 'codicon-file-media'
  if (['zip', 'gz', 'tar', '7z'].includes(ext)) return 'codicon-file-zip'
  if (ext === 'pdf') return 'codicon-file-pdf'
  return 'codicon-file'
}

function buildTree(files: FileInfo[]): FileNode {
  const root: FileNode = { type: 'folder', name: '', relativePath: '', children: new Map() }
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, i) => {
      const partPath = parts.slice(0, i + 1).join('/')
      if (i === parts.length - 1 && file.type === 'file') {
        node.children.set(part, { type: 'file', name: file.name || part, relativePath: partPath, file, children: new Map() })
        return
      }
      if (!node.children.has(part)) {
        node.children.set(part, { type: 'folder', name: part, relativePath: partPath, children: new Map() })
      }
      node = node.children.get(part)!
    })
  }
  return root
}

const sortedChildren = (node: FileNode) =>
  [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

// Folder paths leading to the active file, so it is always revealed even when
// its folders were never expanded by hand.
function ancestorsOf(files: FileInfo[], activePath: string | null): Set<string> {
  const set = new Set<string>()
  if (!activePath) return set
  const file = files.find((entry) => entry.path === activePath)
  if (!file) return set
  const parts = file.relativePath.split('/').filter(Boolean)
  parts.pop()
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    set.add(acc)
  }
  return set
}

// The Explorer sidebar tree of one database context's .sql files. Owns folder
// expand/collapse and the editing affordances — inline rename (F2, or Enter
// on macOS), inline create, and a right-click menu — and dispatches
// `file-open` / `file-rename` / `file-create` / `file-delete`; the workbench
// performs the actual IPC.
@customElement('file-tree')
export class FileTree extends LitElement {
  @property({ attribute: false })
  files: FileInfo[] = []

  /** Absolute path of the file open in the active tab, if any. */
  @property()
  activePath: string | null = null

  @state()
  private _expanded = new Set<string>()

  @state()
  private _editing: Editing | null = null

  @state()
  private _menu: Menu | null = null

  render() {
    const hasFiles = this.files.some((file) => file.type === 'file')
    const ancestors = ancestorsOf(this.files, this.activePath)
    const isOpen = (relativePath: string) => this._expanded.has(relativePath) || ancestors.has(relativePath)
    const creating = this._editing?.mode === 'create' ? this._editing.parent : null

    const rows: TemplateResult[] = []
    if (creating === '') rows.push(this._renderEditRow(0, ''))
    const walk = (node: FileNode, depth: number) => {
      for (const child of sortedChildren(node)) {
        const isFolder = child.type === 'folder'
        const expanded = isFolder && isOpen(child.relativePath)
        if (this._editing?.mode === 'rename' && this._editing.relativePath === child.relativePath) {
          rows.push(this._renderEditRow(depth, child.name))
        } else {
          rows.push(this._renderRow(child, depth, expanded))
        }
        if (isFolder && expanded) {
          if (creating === child.relativePath) rows.push(this._renderEditRow(depth + 1, ''))
          walk(child, depth + 1)
        }
      }
    }
    walk(buildTree(this.files), 0)

    return html`
      <div class="tree" role="tree" @contextmenu=${this._onBackgroundMenu}>
        ${rows.length ? rows : hasFiles ? '' : html`<p class="muted hint">No .sql files yet. Right-click to create one.</p>`}
      </div>
      ${this._renderMenu()}
    `
  }

  protected updated(changed: PropertyValues) {
    if (changed.has('_editing') && this._editing) {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>('.edit-row input')
      if (!input) return
      input.focus()
      // Pre-select the basename so typing replaces it but the extension stays.
      const dot = input.value.lastIndexOf('.')
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
    }
  }

  private _renderRow(node: FileNode, depth: number, expanded: boolean) {
    const isFolder = node.type === 'folder'
    return html`
      <div
        class="row ${node.file && node.file.path === this.activePath ? 'active' : ''}"
        role="treeitem"
        tabindex="0"
        title=${node.relativePath}
        style="padding-left: ${10 + depth * 12}px"
        @click=${() => this._onRow(node)}
        @keydown=${(e: KeyboardEvent) => this._onRowKeydown(e, node)}
        @contextmenu=${(e: MouseEvent) => this._onRowMenu(e, node)}
      >
        <i
          class="codicon codicon-chevron-right chevron ${expanded ? 'expanded' : ''} ${isFolder ? '' : 'hidden'}"
          aria-hidden="true"
        ></i>
        <i class="codicon ${isFolder ? 'codicon-folder' : fileIcon(node.name)}" aria-hidden="true"></i>
        <span class="name">${node.name}</span>
      </div>
    `
  }

  private _renderEditRow(depth: number, initial: string) {
    return html`
      <div class="row edit-row" style="padding-left: ${10 + depth * 12}px">
        <i class="codicon codicon-chevron-right chevron hidden" aria-hidden="true"></i>
        <i class="codicon codicon-file-code" aria-hidden="true"></i>
        <input
          type="text"
          .value=${initial}
          spellcheck="false"
          autocomplete="off"
          @keydown=${this._onEditKeydown}
          @blur=${() => (this._editing = null)}
          @click=${(e: Event) => e.stopPropagation()}
        />
      </div>
    `
  }

  private _renderMenu() {
    const menu = this._menu
    if (!menu) return ''
    const node = menu.node
    const items: MenuItem[] = [{ id: 'new', label: 'New File' }]
    if (node?.type === 'file') items.push({ id: 'rename', label: `Rename (${isMac ? '↵' : 'F2'})` })
    if (node) items.push({ id: 'delete', label: 'Delete', danger: true })

    return html`
      <context-menu
        .x=${menu.x}
        .y=${menu.y}
        .items=${items}
        @menu-pick=${(e: CustomEvent<MenuPickDetail>) => this._onMenuPick(e.detail.id, node)}
        @menu-close=${() => (this._menu = null)}
      ></context-menu>
    `
  }

  // --- interactions --------------------------------------------------------

  private _onRow(node: FileNode) {
    if (node.type === 'folder') {
      const expanded = new Set(this._expanded)
      if (!expanded.delete(node.relativePath)) expanded.add(node.relativePath)
      this._expanded = expanded
      return
    }
    if (node.file) {
      this.dispatchEvent(new CustomEvent('file-open', { detail: { file: node.file }, bubbles: true, composed: true }))
    }
  }

  private _onRowKeydown(event: KeyboardEvent, node: FileNode) {
    // Platform rename convention: Enter on macOS, F2 elsewhere.
    const renameKey = event.key === 'F2' || (isMac && event.key === 'Enter')
    if (renameKey && node.type === 'file') {
      event.preventDefault()
      this._startRename(node)
      return
    }
    const deleteKey = isMac ? event.key === 'Backspace' && event.metaKey : event.key === 'Delete'
    if (deleteKey) {
      event.preventDefault()
      this._requestDelete(node)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this._onRow(node)
    }
  }

  private _onRowMenu(event: MouseEvent, node: FileNode) {
    event.preventDefault()
    event.stopPropagation()
    this._menu = { x: event.clientX, y: event.clientY, node }
  }

  private _onBackgroundMenu(event: MouseEvent) {
    event.preventDefault()
    this._menu = { x: event.clientX, y: event.clientY, node: null }
  }

  private _onMenuPick(id: string, node: FileNode | null) {
    this._menu = null
    if (id === 'new') {
      const parent = !node ? '' : node.type === 'folder' ? node.relativePath : parentOf(node.relativePath)
      if (parent) this._expanded = new Set(this._expanded).add(parent)
      this._editing = { mode: 'create', parent }
      return
    }
    if (id === 'rename' && node?.type === 'file') this._startRename(node)
    if (id === 'delete' && node) this._requestDelete(node)
  }

  private _startRename(node: FileNode) {
    this._editing = { mode: 'rename', relativePath: node.relativePath }
  }

  private _requestDelete(node: FileNode) {
    // Folder nodes carry no FileInfo; their absolute path is in the flat list.
    const info = this.files.find((file) => file.relativePath === node.relativePath && file.type === node.type)
    if (!info) return
    this.dispatchEvent(
      new CustomEvent<FileDeleteDetail>('file-delete', {
        detail: { path: info.path, name: info.name },
        bubbles: true,
        composed: true,
      }),
    )
  }

  private _onEditKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      this._editing = null
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()

    const editing = this._editing
    const value = (event.target as HTMLInputElement).value.trim()
    this._editing = null
    if (!editing || !value || value.includes('/') || value.includes('\\')) return

    if (editing.mode === 'create') {
      this.dispatchEvent(
        new CustomEvent<FileCreateDetail>('file-create', {
          detail: { parent: editing.parent, name: value },
          bubbles: true,
          composed: true,
        }),
      )
      return
    }

    const file = this.files.find((entry) => entry.relativePath === editing.relativePath && entry.type === 'file')
    if (file && value !== file.name) {
      this.dispatchEvent(
        new CustomEvent<FileRenameDetail>('file-rename', {
          detail: { file, newName: value },
          bubbles: true,
          composed: true,
        }),
      )
    }
  }

  static styles = [
    typography,
    codicons,
    scrollbars,
    css`
      :host {
        display: block;
        overflow-y: auto;
        min-height: 0;
        /* No rubber-band (it can wedge nested scrollers at the boundary on
           macOS) and no anchor-pinning when the watcher re-renders the list
           while scrolled to the end. */
        overscroll-behavior: none;
        overflow-anchor: none;
      }

      .tree {
        min-height: 100%;
      }

      .hint {
        padding: 0 20px;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 3px 10px;
        color: var(--text);
        font-size: var(--font-size);
        cursor: pointer;
        white-space: nowrap;
        user-select: none;
      }

      .row:hover {
        background: var(--list-hover);
      }

      .row.active {
        background: var(--list-selection);
        color: var(--list-selection-fg);
      }

      .row .codicon {
        font-size: 14px;
        flex-shrink: 0;
        color: var(--text-2);
      }

      .row.active .codicon {
        color: var(--list-selection-fg);
      }

      .chevron {
        transition: transform 0.1s ease;
      }

      .chevron.expanded {
        transform: rotate(90deg);
      }

      .chevron.hidden {
        visibility: hidden;
      }

      .name {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .edit-row {
        cursor: default;
      }

      .edit-row input {
        flex: 1;
        min-width: 0;
        height: 20px;
        padding: 0 4px;
        font: inherit;
        color: var(--input-fg);
        background: var(--input-bg);
        border: 1px solid var(--input-focus-border);
        border-radius: 2px;
        outline: none;
      }

    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'file-tree': FileTree
  }
}
