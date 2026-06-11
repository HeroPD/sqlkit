import { LitElement, css, html, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { codicons, scrollbars, typography } from '../shared-styles'
import type { FileInfo } from '../electron'

type FileNode = {
  type: 'file' | 'folder'
  name: string
  relativePath: string
  file?: FileInfo
  children: Map<string, FileNode>
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

// The Explorer sidebar tree of workspace .sql files. Owns folder
// expand/collapse; dispatches `file-open` with the picked FileInfo.
@customElement('file-tree')
export class FileTree extends LitElement {
  @property({ attribute: false })
  files: FileInfo[] = []

  /** Absolute path of the file open in the active tab, if any. */
  @property()
  activePath: string | null = null

  @state()
  private _expanded = new Set<string>()

  render() {
    if (!this.files.some((file) => file.type === 'file')) {
      return html`<p class="muted hint">No .sql files in this workspace yet.</p>`
    }

    const ancestors = ancestorsOf(this.files, this.activePath)
    const isOpen = (relativePath: string) => this._expanded.has(relativePath) || ancestors.has(relativePath)

    const rows: TemplateResult[] = []
    const walk = (node: FileNode, depth: number) => {
      for (const child of sortedChildren(node)) {
        const isFolder = child.type === 'folder'
        const expanded = isFolder && isOpen(child.relativePath)
        rows.push(this._renderRow(child, depth, expanded))
        if (expanded) walk(child, depth + 1)
      }
    }
    walk(buildTree(this.files), 0)
    return html`<div class="tree" role="tree">${rows}</div>`
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
      >
        <i
          class="codicon codicon-chevron-right chevron ${expanded ? 'expanded' : ''} ${isFolder ? '' : 'hidden'}"
          aria-hidden="true"
        ></i>
        <i class="codicon ${isFolder ? 'codicon-folder' : 'codicon-file-code'}" aria-hidden="true"></i>
        <span class="name">${node.name}</span>
      </div>
    `
  }

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
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      this._onRow(node)
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
    `,
  ]
}

declare global {
  interface HTMLElementTagNameMap {
    'file-tree': FileTree
  }
}
