'use strict'

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  engine: 'postgresql',
  connected: false,
  selectedTable: null,
  isConnecting: false,
  isRunning: false,
  expandedTables: new Set(),
  panelTab: 'results',
  messages: [],
  sidebarVisible: true,
  tables: []
}

const ENGINE_DEFAULTS = {
  postgresql: { port: '5432', database: 'postgres', username: 'postgres' },
  mysql:      { port: '3306', database: 'mysql',    username: 'root' },
  sqlserver:  { port: '1433', database: 'master',   username: 'sa' }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const el = {
  // Activity bar
  activityItems: document.querySelectorAll('.activity-item'),

  // Sidebar
  sidebar:       $('sidebar'),
  sectionHeaders: document.querySelectorAll('.section-header'),

  // Connection
  engineBtns:    document.querySelectorAll('.engine-btn'),
  host:          $('host'),
  port:          $('port'),
  database:      $('database'),
  username:      $('username'),
  password:      $('password'),
  connectBtn:    $('connect-btn'),
  refreshBtn:    $('refresh-btn'),
  connStatus:    $('connection-status'),

  // Tables
  tableTree:     $('table-tree'),
  tableEmpty:    $('table-empty'),

  // Editor
  lineNumbers:   $('line-numbers'),
  queryEditor:   $('query-editor'),

  // Panel
  panelTabs:     document.querySelectorAll('.panel-tab'),
  runBtn:        $('run-btn'),
  resultsPanel:  $('results-panel'),
  messagesPanel: $('messages-panel'),
  resultsEmpty:  $('results-empty'),
  resultsScroll: $('results-scroll'),
  resultsThead:  $('results-thead'),
  resultsTbody:  $('results-tbody'),
  messagesEmpty: $('messages-empty'),
  messagesList:  $('messages-list'),

  // Status bar
  statusBar:     $('status-bar'),
  statusConnText:$('status-conn-text'),
  statusInfo:    $('status-info'),
}

// ── Activity Bar ──────────────────────────────────────────────────────────────
el.activityItems.forEach(item => {
  item.addEventListener('click', () => {
    const wasActive = item.classList.contains('active')
    if (wasActive) {
      // Toggle sidebar visibility
      item.classList.remove('active')
      el.sidebar.classList.add('hidden')
      state.sidebarVisible = false
    } else {
      el.activityItems.forEach(i => i.classList.remove('active'))
      item.classList.add('active')
      el.sidebar.classList.remove('hidden')
      state.sidebarVisible = true
    }
  })
})

// ── Collapsible Sections ──────────────────────────────────────────────────────
el.sectionHeaders.forEach(header => {
  header.addEventListener('click', (e) => {
    // Don't collapse when clicking action buttons
    if (e.target.closest('.section-actions')) return
    header.classList.toggle('collapsed')
  })
})

// ── Engine Selection ──────────────────────────────────────────────────────────
el.engineBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (state.connected) return
    const engine = btn.dataset.engine
    if (engine === state.engine) return

    el.engineBtns.forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    state.engine = engine

    const d = ENGINE_DEFAULTS[engine]
    el.port.value     = d.port
    el.database.value = d.database
    el.username.value = d.username

    if (engine !== 'postgresql') {
      setConnStatus(`${engine === 'mysql' ? 'MySQL' : 'SQL Server'} support coming soon`, 'error')
    } else {
      setConnStatus('', '')
    }
  })
})

// ── Connect / Disconnect ──────────────────────────────────────────────────────
el.connectBtn.addEventListener('click', () => {
  state.connected ? disconnect() : connect()
})

el.refreshBtn.addEventListener('click', loadTables)

async function connect() {
  if (state.isConnecting) return
  state.isConnecting = true
  setConnStatus('Connecting...', '')
  el.connectBtn.disabled = true
  el.connectBtn.textContent = 'Connecting...'

  const profile = {
    engine:   state.engine,
    host:     el.host.value.trim()     || 'localhost',
    port:     el.port.value.trim()     || '5432',
    database: el.database.value.trim() || 'postgres',
    username: el.username.value.trim() || 'postgres',
    password: el.password.value
  }

  const res = await window.sqlkit.connect(profile)

  if (res.success) {
    state.connected = true
    el.connectBtn.textContent = 'Disconnect'
    el.refreshBtn.disabled = false
    el.runBtn.disabled = false
    const ver = res.serverVersion || 'PostgreSQL'
    setConnStatus(`Connected — ${ver}`, 'ok')
    setStatusConnection(ver)
    addMessage('ok', `Connected to ${ver}`)
    await loadTables()
  } else {
    setConnStatus(res.error, 'error')
    el.connectBtn.textContent = 'Connect'
    addMessage('error', res.error)
  }

  el.connectBtn.disabled = false
  state.isConnecting = false
}

async function disconnect() {
  await window.sqlkit.disconnect()
  state.connected = false
  state.selectedTable = null
  state.expandedTables.clear()
  state.tables = []

  el.connectBtn.textContent = 'Connect'
  el.refreshBtn.disabled = true
  el.runBtn.disabled = true
  clearTableTree()
  el.tableEmpty.textContent = 'Connect to explore tables'
  el.tableEmpty.style.display = ''
  setConnStatus('Disconnected', '')
  setStatusDisconnected()
  addMessage('info', 'Disconnected')
}

// ── Table Tree ────────────────────────────────────────────────────────────────
function clearTableTree() {
  // Remove all tree items but keep the empty message
  el.tableTree.querySelectorAll('.tree-item').forEach(el => el.remove())
}

async function loadTables() {
  clearTableTree()
  state.expandedTables.clear()
  el.tableEmpty.textContent = 'Loading...'
  el.tableEmpty.style.display = ''

  const res = await window.sqlkit.getTables()

  if (!res.success) {
    el.tableEmpty.textContent = res.error || 'Failed to load tables'
    return
  }

  if (res.tables.length === 0) {
    el.tableEmpty.textContent = 'No tables found'
    return
  }

  el.tableEmpty.style.display = 'none'
  state.tables = res.tables

  res.tables.forEach(t => {
    const item = createTableTreeItem(t)
    el.tableTree.appendChild(item)
  })

  // Auto-select first
  const first = res.tables[0]
  const firstEl = el.tableTree.querySelector('.tree-item')
  if (first && firstEl) selectTable(first, firstEl)
}

function createTableTreeItem(t) {
  const div = document.createElement('div')
  div.className = 'tree-item'
  div.dataset.schema = t.schema
  div.dataset.name = t.name
  div.dataset.type = t.type

  const isView = t.type === 'view'
  const iconClass = isView ? 'view-icon' : 'table-icon'
  const icon = isView ? '◫' : '▦'

  div.innerHTML = `
    <span class="tree-chevron" data-action="expand">
      <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>
    </span>
    <span class="tree-icon ${iconClass}">${icon}</span>
    <span class="tree-label">${esc(t.name)}</span>
    <span class="tree-type">${esc(t.schema)}</span>`

  div.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="expand"]')) {
      toggleTableExpand(t, div)
    } else {
      selectTable(t, div)
    }
  })

  div.addEventListener('dblclick', () => browseTable(t))

  return div
}

function selectTable(t, itemEl) {
  state.selectedTable = t
  el.tableTree.querySelectorAll('.tree-item').forEach(e => e.classList.remove('selected'))
  itemEl?.classList.add('selected')
}

async function toggleTableExpand(t, itemEl) {
  const key = `${t.schema}.${t.name}`
  const chevron = itemEl.querySelector('.tree-chevron')

  if (state.expandedTables.has(key)) {
    // Collapse: remove column items
    state.expandedTables.delete(key)
    chevron.classList.remove('expanded')
    removeColumnItems(key)
  } else {
    // Expand: fetch and show columns
    state.expandedTables.add(key)
    chevron.classList.add('expanded')

    const res = await window.sqlkit.getColumns(t.schema, t.name)
    if (res.success && res.columns.length > 0) {
      const frag = document.createDocumentFragment()
      res.columns.forEach(col => {
        const colDiv = document.createElement('div')
        colDiv.className = 'tree-item tree-column'
        colDiv.dataset.parent = key

        colDiv.innerHTML = `
          <span class="tree-indent depth-1"></span>
          <span class="tree-chevron hidden">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.7 13.7L5 13l4.6-4.6L5 3.7l.7-.7 5.3 5.3z"/></svg>
          </span>
          <span class="tree-icon column-icon">◇</span>
          <span class="tree-label">${esc(col.name)}</span>
          <span class="tree-type">${esc(col.type)}</span>`

        frag.appendChild(colDiv)
      })
      // Insert columns after the table item
      itemEl.after(frag)
    }
  }
}

function removeColumnItems(parentKey) {
  el.tableTree.querySelectorAll(`.tree-column[data-parent="${parentKey}"]`).forEach(el => el.remove())
}

async function browseTable(t) {
  el.queryEditor.value = `SELECT * FROM "${t.schema}"."${t.name}" LIMIT 200`
  updateLineNumbers()
  await runQuery()
}

// ── Panel Tabs ────────────────────────────────────────────────────────────────
el.panelTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const panel = tab.dataset.panel
    if (panel === state.panelTab) return

    state.panelTab = panel
    el.panelTabs.forEach(t => t.classList.remove('active'))
    tab.classList.add('active')

    if (panel === 'results') {
      el.resultsPanel.hidden = false
      el.messagesPanel.hidden = true
    } else {
      el.resultsPanel.hidden = true
      el.messagesPanel.hidden = false
    }
  })
})

// ── Messages ──────────────────────────────────────────────────────────────────
function addMessage(type, text) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false })
  state.messages.push({ type, text, time })
  renderMessages()
}

function renderMessages() {
  if (state.messages.length === 0) {
    el.messagesEmpty.style.display = ''
    el.messagesList.style.display = 'none'
    return
  }

  el.messagesEmpty.style.display = 'none'
  el.messagesList.style.display = ''

  const html = state.messages.map(m => `
    <div class="message-line">
      <span class="message-time">[${m.time}]</span>
      <span class="message-text ${m.type}">${esc(m.text)}</span>
    </div>`
  ).join('')

  el.messagesList.innerHTML = html
  el.messagesList.scrollTop = el.messagesList.scrollHeight
}

// ── Query Editor ──────────────────────────────────────────────────────────────
el.runBtn.addEventListener('click', runQuery)

el.queryEditor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault()
    const s = el.queryEditor.selectionStart
    const v = el.queryEditor.value
    el.queryEditor.value = v.slice(0, s) + '  ' + v.slice(el.queryEditor.selectionEnd)
    el.queryEditor.selectionStart = el.queryEditor.selectionEnd = s + 2
    updateLineNumbers()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    runQuery()
  }
})

el.queryEditor.addEventListener('input', updateLineNumbers)
el.queryEditor.addEventListener('scroll', syncLineNumberScroll)

function updateLineNumbers() {
  const lines = el.queryEditor.value.split('\n').length
  el.lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n')
}

function syncLineNumberScroll() {
  el.lineNumbers.scrollTop = el.queryEditor.scrollTop
}

// ── Run Query ─────────────────────────────────────────────────────────────────
async function runQuery() {
  const sql = el.queryEditor.value.trim()
  if (!sql || state.isRunning || !state.connected) return

  state.isRunning = true
  el.runBtn.disabled = true
  el.runBtn.textContent = '▶ Running...'
  el.statusInfo.textContent = 'Running query...'

  // Switch to results panel
  switchPanel('results')

  const res = await window.sqlkit.runQuery(sql)

  if (!res.success) {
    addMessage('error', res.error)
    el.statusInfo.textContent = 'Error'
    // Show empty with error
    el.resultsScroll.hidden = true
    el.resultsEmpty.textContent = res.error
    el.resultsEmpty.style.display = ''
    el.resultsEmpty.style.color = 'var(--red)'
  } else if (res.columns.length === 0) {
    const rows = res.rowCount != null ? `${res.rowCount} row(s) affected` : 'Done'
    const cmd  = res.command ? `${res.command} — ` : ''
    const msg = `${cmd}${rows} (${fmtTime(res.executionTime)})`
    addMessage('ok', msg)
    el.statusInfo.textContent = msg
    el.resultsScroll.hidden = true
    el.resultsEmpty.textContent = msg
    el.resultsEmpty.style.display = ''
    el.resultsEmpty.style.color = ''
  } else {
    renderResults(res)
    const cap = res.rows.length > 10000
    const shown = cap ? 10000 : res.rows.length
    const suffix = cap ? ` (showing first 10,000 of ${res.rows.length})` : ''
    const msg = `${shown} row${shown !== 1 ? 's' : ''} — ${fmtTime(res.executionTime)}${suffix}`
    addMessage('ok', msg)
    el.statusInfo.textContent = msg
  }

  state.isRunning = false
  el.runBtn.disabled = false
  el.runBtn.textContent = '▶ Run'
}

function switchPanel(panel) {
  state.panelTab = panel
  el.panelTabs.forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panel)
  })
  el.resultsPanel.hidden = (panel !== 'results')
  el.messagesPanel.hidden = (panel !== 'messages')
}

// ── Render Results ────────────────────────────────────────────────────────────
function renderResults({ columns, rows }) {
  // Reset empty state
  el.resultsEmpty.style.display = 'none'
  el.resultsEmpty.style.color = ''

  // Header
  const hRow = document.createElement('tr')
  const numTh = document.createElement('th')
  numTh.textContent = '#'
  hRow.appendChild(numTh)
  columns.forEach(col => {
    const th = document.createElement('th')
    th.textContent = col
    th.title = col
    hRow.appendChild(th)
  })
  el.resultsThead.replaceChildren(hRow)

  // Rows (cap at 10,000)
  const display = rows.length > 10000 ? rows.slice(0, 10000) : rows
  const frag = document.createDocumentFragment()

  display.forEach((row, i) => {
    const tr = document.createElement('tr')

    const numTd = document.createElement('td')
    numTd.textContent = i + 1
    tr.appendChild(numTd)

    columns.forEach((_, j) => {
      const td = document.createElement('td')
      const v  = row[j]
      if (v === null) {
        td.textContent = 'NULL'
        td.classList.add('null-val')
      } else {
        td.textContent = v
        if (v.length > 60) td.title = v
      }
      tr.appendChild(td)
    })

    frag.appendChild(tr)
  })

  el.resultsTbody.replaceChildren(frag)
  el.resultsScroll.hidden = false
}

// ── Resize Handles ────────────────────────────────────────────────────────────
function makeResizable(handleId, targetId, axis, invert = false) {
  const handle = $(handleId)
  const target = $(targetId)
  let dragging = false, start, startSize

  handle.addEventListener('mousedown', e => {
    dragging = true
    start     = axis === 'x' ? e.clientX : e.clientY
    startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight
    document.body.style.cursor     = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    handle.classList.add('active')
    e.preventDefault()
  })

  document.addEventListener('mousemove', e => {
    if (!dragging) return
    const raw   = (axis === 'x' ? e.clientX : e.clientY) - start
    const delta = invert ? -raw : raw
    const min   = axis === 'x' ? 170  : 100
    const max   = axis === 'x' ? 500  : 800
    const size  = Math.max(min, Math.min(max, startSize + delta))

    if (axis === 'x') {
      target.style.width = size + 'px'
      document.documentElement.style.setProperty('--sidebar-w', size + 'px')
    } else {
      target.style.height = size + 'px'
    }
  })

  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor     = ''
    document.body.style.userSelect = ''
    handle.classList.remove('active')
  })
}

makeResizable('sidebar-resize', 'sidebar', 'x')
makeResizable('panel-resize',   'panel',   'y', true)

// ── Status Bar ────────────────────────────────────────────────────────────────
function setStatusConnection(version) {
  el.statusBar.classList.add('connected')
  el.statusConnText.textContent = version
}

function setStatusDisconnected() {
  el.statusBar.classList.remove('connected')
  el.statusConnText.textContent = 'Disconnected'
  el.statusInfo.textContent = ''
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setConnStatus(msg, cls) {
  el.connStatus.textContent = msg
  el.connStatus.className   = cls
}

function fmtTime(ms) {
  if (!ms && ms !== 0) return '?'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Command Palette ───────────────────────────────────────────────────────────
const palette = {
  overlay: $('palette-overlay'),
  input:   $('palette-input'),
  list:    $('palette-list'),
  mode:    null,       // 'tables' (Cmd+P) or 'commands' (Cmd+Shift+P)
  items:   [],         // current filtered items
  active:  0,          // active index
}

const COMMANDS = [
  { id: 'connect',         label: 'Connect to Database',     icon: '⚡', key: '',         action: () => { if (!state.connected) connect() } },
  { id: 'disconnect',      label: 'Disconnect',              icon: '⊘',  key: '',         action: () => { if (state.connected) disconnect() } },
  { id: 'run-query',       label: 'Run Query',               icon: '▶',  key: '⌘↵',      action: () => runQuery() },
  { id: 'refresh-tables',  label: 'Refresh Tables',          icon: '↻',  key: '',         action: () => { if (state.connected) loadTables() } },
  { id: 'toggle-sidebar',  label: 'Toggle Sidebar',          icon: '◧',  key: '⌘B',      action: toggleSidebar },
  { id: 'focus-editor',    label: 'Focus Query Editor',      icon: '⌨',  key: '',         action: () => el.queryEditor.focus() },
  { id: 'show-results',    label: 'Show Results Panel',      icon: '▤',  key: '',         action: () => switchPanel('results') },
  { id: 'show-messages',   label: 'Show Messages Panel',     icon: '✉',  key: '',         action: () => switchPanel('messages') },
  { id: 'clear-messages',  label: 'Clear Messages',          icon: '✕',  key: '',         action: () => { state.messages = []; renderMessages() } },
  { id: 'clear-editor',    label: 'Clear Editor',            icon: '⌫',  key: '',         action: () => { el.queryEditor.value = ''; updateLineNumbers() } },
  { id: 'quick-open',      label: 'Go to Table...',          icon: '▦',  key: '⌘P',      action: () => openPalette('tables') },
]

function openPalette(mode) {
  palette.mode = mode
  palette.active = 0
  palette.overlay.hidden = false

  if (mode === 'commands') {
    palette.input.placeholder = 'Type a command...'
    palette.input.value = ''
  } else {
    palette.input.placeholder = 'Search tables...'
    palette.input.value = ''
  }

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
    const icon = t.type === 'view' ? '◫' : '▦'
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
    item.addEventListener('click', () => {
      selectPaletteItem(parseInt(item.dataset.index))
    })
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
  // Scroll active into view
  const active = palette.list.querySelector('.palette-item.active')
  if (active) active.scrollIntoView({ block: 'nearest' })
}

function selectPaletteItem(index) {
  if (palette.mode === 'commands') {
    const cmd = palette.items[index]
    if (cmd) {
      closePalette()
      cmd.action()
    }
  } else {
    const table = palette.items[index]
    if (table) {
      closePalette()
      // Select the table in the tree
      const treeItem = el.tableTree.querySelector(
        `.tree-item[data-schema="${table.schema}"][data-name="${table.name}"]`
      )
      if (treeItem) selectTable(table, treeItem)
      browseTable(table)
    }
  }
}

// Palette input events
palette.input.addEventListener('input', filterPalette)

palette.input.addEventListener('keydown', e => {
  const count = palette.items.length
  if (e.key === 'Escape') {
    e.preventDefault()
    closePalette()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (count > 0) {
      palette.active = (palette.active + 1) % count
      updatePaletteActive()
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (count > 0) {
      palette.active = (palette.active - 1 + count) % count
      updatePaletteActive()
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    if (count > 0) selectPaletteItem(palette.active)
  }
})

// Close on overlay click
palette.overlay.addEventListener('mousedown', e => {
  if (e.target === palette.overlay) closePalette()
})

// Toggle sidebar helper
function toggleSidebar() {
  const activeItem = document.querySelector('.activity-item.active')
  if (state.sidebarVisible) {
    if (activeItem) activeItem.classList.remove('active')
    el.sidebar.classList.add('hidden')
    state.sidebarVisible = false
  } else {
    const first = document.querySelector('.activity-item')
    if (first) first.classList.add('active')
    el.sidebar.classList.remove('hidden')
    state.sidebarVisible = true
  }
}

// Global keyboard shortcuts
document.addEventListener('keydown', e => {
  // Cmd+Shift+P — Command Palette
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'commands') { closePalette() } else { openPalette('commands') }
    return
  }
  // Cmd+P — Quick Open (tables)
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'tables') { closePalette() } else { openPalette('tables') }
    return
  }
  // Cmd+B — Toggle Sidebar
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
    e.preventDefault()
    toggleSidebar()
    return
  }
  // Escape closes palette
  if (e.key === 'Escape' && palette.mode) {
    e.preventDefault()
    closePalette()
    return
  }
})

// ── Init ──────────────────────────────────────────────────────────────────────
el.queryEditor.value =
`SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
LIMIT 200`

updateLineNumbers()
