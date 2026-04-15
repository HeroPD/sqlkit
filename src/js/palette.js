import { state, el, $, esc } from './utils.js'
import { connect, disconnect, loadFiles, loadTables, browseTable, selectTable } from './explorer.js'
import { createNewTab, closeTab, saveCurrentTab } from './editor.js'
import { switchPanel, clearMessages, runQuery } from './panel.js'
import { toggleSidebar, openWorkspaceDialog } from './layout.js'

// ── Command Palette ──────────────────────────────────────────────────────────

const palette = {
  overlay: $('palette-overlay'),
  input:   $('palette-input'),
  list:    $('palette-list'),
  mode:    null,
  items:   [],
  active:  0,
}

const COMMANDS = [
  { id: 'connect',         label: 'Connect to Database',     icon: '\u26a1', key: '',              action: () => { if (!state.connected) connect() } },
  { id: 'disconnect',      label: 'Disconnect',              icon: '\u2298', key: '',              action: () => { if (state.connected) disconnect() } },
  { id: 'run-query',       label: 'Run Query',               icon: '\u25b6', key: '\u2318\u21b5',  action: () => runQuery() },
  { id: 'new-file',        label: 'New File',                icon: '+',      key: '\u2318N',       action: () => createNewTab() },
  { id: 'save-file',       label: 'Save File',               icon: '\u2b21', key: '\u2318S',       action: () => saveCurrentTab() },
  { id: 'close-tab',       label: 'Close Tab',               icon: '\u2715', key: '\u2318W',       action: () => closeTab(state.activeTabId) },
  { id: 'open-workspace',  label: 'Open Folder...',          icon: '\ud83d\udcc2', key: '',        action: () => openWorkspaceDialog() },
  { id: 'refresh-files',   label: 'Refresh Files',           icon: '\u21bb', key: '',              action: () => loadFiles() },
  { id: 'refresh-tables',  label: 'Refresh Tables',          icon: '\u21bb', key: '',              action: () => { if (state.connected) loadTables() } },
  { id: 'toggle-sidebar',  label: 'Toggle Sidebar',          icon: '\u25e7', key: '\u2318B',       action: toggleSidebar },
  { id: 'focus-editor',    label: 'Focus Query Editor',      icon: '\u2328', key: '',              action: () => el.queryEditor.focus() },
  { id: 'show-results',    label: 'Show Results Panel',      icon: '\u25a4', key: '',              action: () => switchPanel('results') },
  { id: 'show-messages',   label: 'Show Messages Panel',     icon: '\u2709', key: '',              action: () => switchPanel('messages') },
  { id: 'clear-messages',  label: 'Clear Messages',          icon: '\u232b', key: '',              action: clearMessages },
  { id: 'quick-open',      label: 'Go to Table...',          icon: '\u25a6', key: '\u2318P',       action: () => openPalette('tables') },
]

function openPalette(mode) {
  palette.mode = mode
  palette.active = 0
  palette.overlay.hidden = false
  palette.input.placeholder = mode === 'commands' ? 'Type a command...' : 'Search tables...'
  palette.input.value = ''
  filterPalette()
  palette.input.focus()
}

function closePalette() {
  palette.overlay.hidden = true
  palette.input.value = ''
  palette.mode = null
}

function filterPalette() {
  const query = palette.input.value.toLowerCase()

  if (palette.mode === 'commands') {
    palette.items = COMMANDS.filter(c =>
      c.label.toLowerCase().includes(query) || c.id.includes(query)
    )
    renderPaletteCommands(query)
  } else {
    palette.items = state.tables.filter(t =>
      t.name.toLowerCase().includes(query) ||
      t.schema.toLowerCase().includes(query) ||
      `${t.schema}.${t.name}`.toLowerCase().includes(query)
    )
    renderPaletteTables(query)
  }

  palette.active = 0
  updatePaletteActive()
}

function renderPaletteCommands(query) {
  if (palette.items.length === 0) {
    palette.list.innerHTML = '<div class="palette-empty">No matching commands</div>'
    return
  }

  palette.list.innerHTML = palette.items.map((cmd, i) => `
    <div class="palette-item" data-index="${i}">
      <span class="palette-icon">${cmd.icon}</span>
      <span class="palette-label">${highlightMatch(cmd.label, query)}</span>
      ${cmd.key ? `<span class="palette-keybind">${cmd.key}</span>` : ''}
    </div>`
  ).join('')

  bindPaletteClicks()
}

function renderPaletteTables(query) {
  if (palette.items.length === 0) {
    const msg = state.tables.length === 0 ? 'No tables loaded' : 'No matching tables'
    palette.list.innerHTML = `<div class="palette-empty">${msg}</div>`
    return
  }

  palette.list.innerHTML = palette.items.map((t, i) => {
    const icon = t.type === 'view' ? '\u25eb' : '\u25a6'
    return `
    <div class="palette-item" data-index="${i}">
      <span class="palette-icon">${icon}</span>
      <span class="palette-label">${highlightMatch(t.name, query)}</span>
      <span class="palette-detail">${esc(t.schema)}</span>
    </div>`
  }).join('')

  bindPaletteClicks()
}

function highlightMatch(text, query) {
  if (!query) return esc(text)
  const escaped = esc(text)
  const idx = escaped.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return escaped
  const before = escaped.slice(0, idx)
  const match = escaped.slice(idx, idx + query.length)
  const after = escaped.slice(idx + query.length)
  return `${before}<mark>${match}</mark>${after}`
}

function bindPaletteClicks() {
  palette.list.querySelectorAll('.palette-item').forEach(item => {
    item.addEventListener('click', () => selectPaletteItem(parseInt(item.dataset.index)))
    item.addEventListener('mousemove', () => {
      palette.active = parseInt(item.dataset.index)
      updatePaletteActive()
    })
  })
}

function updatePaletteActive() {
  palette.list.querySelectorAll('.palette-item').forEach((item, i) => {
    item.classList.toggle('active', i === palette.active)
  })
  const active = palette.list.querySelector('.palette-item.active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

function selectPaletteItem(index) {
  if (palette.mode === 'commands') {
    const cmd = palette.items[index]
    if (cmd) { closePalette(); cmd.action() }
  } else {
    const table = palette.items[index]
    if (table) {
      closePalette()
      const treeItem = el.tableTree.querySelector(
        `.tree-item[data-schema="${table.schema}"][data-name="${table.name}"]`
      )
      if (treeItem) selectTable(table, treeItem)
      browseTable(table)
    }
  }
}

palette.input.addEventListener('input', filterPalette)

palette.input.addEventListener('keydown', e => {
  const count = palette.items.length
  if (e.key === 'Escape') { e.preventDefault(); closePalette() }
  else if (e.key === 'ArrowDown') { e.preventDefault(); if (count > 0) { palette.active = (palette.active + 1) % count; updatePaletteActive() } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (count > 0) { palette.active = (palette.active - 1 + count) % count; updatePaletteActive() } }
  else if (e.key === 'Enter') { e.preventDefault(); if (count > 0) selectPaletteItem(palette.active) }
})

palette.overlay.addEventListener('mousedown', e => {
  if (e.target === palette.overlay) closePalette()
})

// ── Global Keyboard Shortcuts ────────────────────────────────────────────────

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'commands') closePalette(); else openPalette('commands')
    return
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'tables') closePalette(); else openPalette('tables')
    return
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 's') {
    e.preventDefault()
    saveCurrentTab()
    return
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'n') {
    e.preventDefault()
    createNewTab()
    return
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'w') {
    e.preventDefault()
    closeTab(state.activeTabId)
    return
  }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
    e.preventDefault()
    toggleSidebar()
    return
  }
  if (e.key === 'Escape' && palette.mode) {
    e.preventDefault()
    closePalette()
    return
  }
})
