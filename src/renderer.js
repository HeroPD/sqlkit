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
  tables: [],

  // Workspace
  workspace: null,   // { path, name, config }
  files: [],         // [{ name, path, modified }]

  // Tabs
  tabs: [],          // [{ id, name, filePath, content, modified }]
  activeTabId: null,
  nextTabId: 1,
  untitledCount: 0,
}

const ENGINE_DEFAULTS = {
  postgresql: { port: '5432', database: 'postgres', username: 'postgres' },
  mysql:      { port: '3306', database: 'mysql',    username: 'root' },
  sqlserver:  { port: '1433', database: 'master',   username: 'sa' }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const el = {
  // Screens
  screenWelcome:   $('screen-welcome'),
  screenWorkbench: $('screen-workbench'),
  welcomeOpen:     $('welcome-open'),
  welcomeRecentSection: $('welcome-recent-section'),
  welcomeRecentList:    $('welcome-recent-list'),
  titlebarTitle:   $('titlebar-title'),

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

  // Files
  fileTree:      $('file-tree'),
  fileEmpty:     $('file-empty'),
  newFileBtn:    $('new-file-btn'),
  refreshFilesBtn: $('refresh-files-btn'),

  // Tables
  tableTree:     $('table-tree'),
  tableEmpty:    $('table-empty'),

  // Editor
  tabBar:        $('tab-bar'),
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
  statusWorkspace: $('status-workspace'),

  // Save prompt
  saveOverlay:   $('save-overlay'),
  saveInput:     $('save-input'),
  saveCancel:    $('save-cancel'),
  saveConfirm:   $('save-confirm'),
  saveError:     $('save-error'),
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function init() {
  // Try to open last workspace
  const last = await window.sqlkit.getLastWorkspace()
  if (last.success) {
    const res = await window.sqlkit.openWorkspacePath(last.path)
    if (res.success) {
      enterWorkspace(res)
      return
    }
  }
  // Show welcome
  showWelcome()
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  const target = name === 'welcome' ? el.screenWelcome : el.screenWorkbench
  target.classList.add('active')
}

async function showWelcome() {
  showScreen('welcome')

  // Load recent
  const res = await window.sqlkit.getRecentWorkspaces()
  if (res.success && res.workspaces.length > 0) {
    el.welcomeRecentSection.hidden = false
    el.welcomeRecentList.innerHTML = res.workspaces.map(w => `
      <div class="recent-item" data-path="${esc(w.path)}">
        <div>
          <div class="recent-name">${esc(w.name)}</div>
          <div class="recent-path">${esc(w.path)}</div>
        </div>
      </div>`
    ).join('')

    el.welcomeRecentList.querySelectorAll('.recent-item').forEach(item => {
      item.addEventListener('click', async () => {
        const res = await window.sqlkit.openWorkspacePath(item.dataset.path)
        if (res.success) enterWorkspace(res)
      })
    })
  }
}

el.welcomeOpen.addEventListener('click', openWorkspaceDialog)

async function openWorkspaceDialog() {
  const res = await window.sqlkit.openWorkspace()
  if (res.success) enterWorkspace(res)
}

function enterWorkspace(res) {
  state.workspace = { path: res.path, name: res.name, config: res.config || {} }
  showScreen('workbench')
  el.titlebarTitle.textContent = `SqlKit — ${res.name}`
  el.statusWorkspace.textContent = res.name

  // Restore connection config
  if (res.config?.connection) {
    const c = res.config.connection
    if (c.engine) {
      state.engine = c.engine
      el.engineBtns.forEach(b => b.classList.toggle('active', b.dataset.engine === c.engine))
      const d = ENGINE_DEFAULTS[c.engine]
      el.port.value = c.port || d.port
      el.database.value = c.database || d.database
      el.username.value = c.username || d.username
    }
    if (c.host) el.host.value = c.host
  }

  // Load files and create first tab
  loadFiles()
  if (state.tabs.length === 0) createNewTab()
}

// ── Activity Bar ──────────────────────────────────────────────────────────────
el.activityItems.forEach(item => {
  item.addEventListener('click', () => {
    const view = item.dataset.view
    const wasActive = item.classList.contains('active')

    if (wasActive) {
      // Toggle sidebar off
      item.classList.remove('active')
      el.sidebar.classList.add('hidden')
      state.sidebarVisible = false
    } else {
      // Switch to this view
      el.activityItems.forEach(i => i.classList.remove('active'))
      item.classList.add('active')
      el.sidebar.classList.remove('hidden')
      state.sidebarVisible = true

      // Switch sidebar view
      document.querySelectorAll('.sidebar-view').forEach(v => v.classList.remove('active'))
      const target = document.getElementById('view-' + view)
      if (target) target.classList.add('active')
    }
  })
})

// ── Collapsible Sections ──────────────────────────────────────────────────────
el.sectionHeaders.forEach(header => {
  header.addEventListener('click', (e) => {
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

    // Save connection to workspace config (no password)
    saveConnectionConfig(profile)
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

function saveConnectionConfig(profile) {
  if (!state.workspace) return
  const config = state.workspace.config || {}
  config.connection = {
    engine: profile.engine,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    username: profile.username,
  }
  state.workspace.config = config
  window.sqlkit.saveWorkspaceConfig(config)
}

// ── Files ─────────────────────────────────────────────────────────────────────
el.newFileBtn.addEventListener('click', () => createNewTab())
el.refreshFilesBtn.addEventListener('click', loadFiles)

async function loadFiles() {
  if (!state.workspace) return
  el.fileTree.querySelectorAll('.file-item').forEach(e => e.remove())

  const res = await window.sqlkit.listFiles()
  if (!res.success || res.files.length === 0) {
    el.fileEmpty.style.display = ''
    el.fileEmpty.textContent = res.files?.length === 0 ? 'No SQL files' : (res.error || 'No files')
    state.files = []
    return
  }

  el.fileEmpty.style.display = 'none'
  state.files = res.files

  res.files.forEach(f => {
    const div = document.createElement('div')
    div.className = 'file-item'
    div.dataset.path = f.path
    div.innerHTML = `<span class="file-icon">&#9671;</span><span class="file-name">${esc(f.name)}</span>`
    div.addEventListener('click', () => openFile(f))
    el.fileTree.appendChild(div)
  })

  updateFileListActive()
}

async function openFile(f) {
  // Check if already open in a tab
  const existing = state.tabs.find(t => t.filePath === f.path)
  if (existing) {
    switchTab(existing.id)
    return
  }

  const res = await window.sqlkit.readFile(f.path)
  if (!res.success) {
    addMessage('error', `Failed to open ${f.name}: ${res.error}`)
    return
  }

  const tab = {
    id: state.nextTabId++,
    name: res.name,
    filePath: res.path,
    content: res.content,
    modified: false,
  }
  state.tabs.push(tab)
  switchTab(tab.id)
}

function updateFileListActive() {
  const activeTab = state.tabs.find(t => t.id === state.activeTabId)
  el.fileTree.querySelectorAll('.file-item').forEach(item => {
    item.classList.toggle('active', activeTab?.filePath === item.dataset.path)
  })
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function createNewTab() {
  state.untitledCount++
  const tab = {
    id: state.nextTabId++,
    name: `Untitled-${state.untitledCount}`,
    filePath: null,
    content: '',
    modified: false,
  }
  state.tabs.push(tab)
  switchTab(tab.id)
}

function switchTab(id) {
  // Save current editor content to outgoing tab
  const current = state.tabs.find(t => t.id === state.activeTabId)
  if (current) {
    const editorVal = el.queryEditor.value
    if (current.content !== editorVal) {
      current.content = editorVal
      current.modified = true
    }
  }

  state.activeTabId = id
  const tab = state.tabs.find(t => t.id === id)
  if (tab) {
    el.queryEditor.value = tab.content
    updateLineNumbers()
  }
  renderTabs()
  updateFileListActive()
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id)
  if (idx === -1) return

  state.tabs.splice(idx, 1)

  if (state.tabs.length === 0) {
    state.activeTabId = null
    el.tabBar.innerHTML = ''
    el.queryEditor.value = ''
    updateLineNumbers()
    return
  }

  if (state.activeTabId === id) {
    const newIdx = Math.min(idx, state.tabs.length - 1)
    switchTab(state.tabs[newIdx].id)
  } else {
    renderTabs()
  }
}

function renderTabs() {
  el.tabBar.innerHTML = ''
  state.tabs.forEach(tab => {
    const div = document.createElement('div')
    div.className = 'editor-tab' + (tab.id === state.activeTabId ? ' active' : '') + (tab.modified ? ' modified' : '')
    div.dataset.tabId = tab.id

    div.innerHTML = `
      <span class="tab-label">${esc(tab.name)}</span>
      <span class="tab-modified"></span>
      <span class="tab-close">&times;</span>`

    div.querySelector('.tab-label').addEventListener('click', () => switchTab(tab.id))
    div.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(tab.id)
    })
    div.addEventListener('click', () => switchTab(tab.id))

    el.tabBar.appendChild(div)
  })
}

function markCurrentTabModified() {
  const tab = state.tabs.find(t => t.id === state.activeTabId)
  if (tab && !tab.modified) {
    tab.modified = true
    renderTabs()
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
let saveResolve = null

async function saveCurrentTab() {
  const tab = state.tabs.find(t => t.id === state.activeTabId)
  if (!tab) return

  tab.content = el.queryEditor.value

  if (tab.filePath) {
    // Save directly
    const res = await window.sqlkit.saveFile(tab.filePath, tab.content)
    if (res.success) {
      tab.modified = false
      renderTabs()
      addMessage('ok', `Saved ${tab.name}`)
    } else {
      addMessage('error', `Failed to save: ${res.error}`)
    }
  } else {
    // Prompt for filename
    const name = await promptFileName(tab.name)
    if (!name) return

    const res = await window.sqlkit.saveNewFile(name, tab.content)
    if (res.success) {
      tab.name = res.name
      tab.filePath = res.path
      tab.modified = false
      renderTabs()
      addMessage('ok', `Saved ${res.name}`)
      loadFiles()
    } else {
      addMessage('error', res.error)
    }
  }
}

function promptFileName(defaultName) {
  return new Promise(resolve => {
    saveResolve = resolve
    el.saveInput.value = defaultName.endsWith('.sql') ? defaultName : defaultName + '.sql'
    el.saveError.textContent = ''
    el.saveOverlay.hidden = false
    el.saveInput.focus()
    el.saveInput.select()
  })
}

el.saveConfirm.addEventListener('click', confirmSave)
el.saveCancel.addEventListener('click', cancelSave)

el.saveInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmSave()
  if (e.key === 'Escape') cancelSave()
})

el.saveOverlay.addEventListener('mousedown', e => {
  if (e.target === el.saveOverlay) cancelSave()
})

async function confirmSave() {
  const name = el.saveInput.value.trim()
  if (!name) {
    el.saveError.textContent = 'Name cannot be empty'
    return
  }

  // Check if file exists
  const fileName = name.endsWith('.sql') ? name : name + '.sql'
  if (state.files.some(f => f.name === fileName)) {
    el.saveError.textContent = `"${fileName}" already exists`
    return
  }

  el.saveOverlay.hidden = true
  if (saveResolve) {
    saveResolve(name)
    saveResolve = null
  }
}

function cancelSave() {
  el.saveOverlay.hidden = true
  if (saveResolve) {
    saveResolve(null)
    saveResolve = null
  }
}

// ── Table Tree ────────────────────────────────────────────────────────────────
function clearTableTree() {
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
    state.expandedTables.delete(key)
    chevron.classList.remove('expanded')
    removeColumnItems(key)
  } else {
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
      itemEl.after(frag)
    }
  }
}

function removeColumnItems(parentKey) {
  el.tableTree.querySelectorAll(`.tree-column[data-parent="${parentKey}"]`).forEach(el => el.remove())
}

async function browseTable(t) {
  const tab = state.tabs.find(tb => tb.id === state.activeTabId)
  if (tab) {
    tab.content = `SELECT * FROM "${t.schema}"."${t.name}" LIMIT 200`
    tab.modified = true
    el.queryEditor.value = tab.content
    updateLineNumbers()
    renderTabs()
  }
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
    markCurrentTabModified()
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    runQuery()
  }
})

el.queryEditor.addEventListener('input', () => {
  updateLineNumbers()
  markCurrentTabModified()
})

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

  switchPanel('results')

  const res = await window.sqlkit.runQuery(sql)

  if (!res.success) {
    addMessage('error', res.error)
    el.statusInfo.textContent = 'Error'
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
  el.resultsEmpty.style.display = 'none'
  el.resultsEmpty.style.color = ''

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

// ── Command Palette ───────────────────────────────────────────────────────────
const palette = {
  overlay: $('palette-overlay'),
  input:   $('palette-input'),
  list:    $('palette-list'),
  mode:    null,
  items:   [],
  active:  0,
}

const COMMANDS = [
  { id: 'connect',         label: 'Connect to Database',     icon: '⚡', key: '',         action: () => { if (!state.connected) connect() } },
  { id: 'disconnect',      label: 'Disconnect',              icon: '⊘',  key: '',         action: () => { if (state.connected) disconnect() } },
  { id: 'run-query',       label: 'Run Query',               icon: '▶',  key: '⌘↵',      action: () => runQuery() },
  { id: 'new-file',        label: 'New File',                icon: '+',  key: '⌘N',      action: () => createNewTab() },
  { id: 'save-file',       label: 'Save File',               icon: '⬡',  key: '⌘S',      action: () => saveCurrentTab() },
  { id: 'close-tab',       label: 'Close Tab',               icon: '✕',  key: '⌘W',      action: () => closeTab(state.activeTabId) },
  { id: 'open-workspace',  label: 'Open Folder...',          icon: '📂', key: '',         action: () => openWorkspaceDialog() },
  { id: 'refresh-files',   label: 'Refresh Files',           icon: '↻',  key: '',         action: () => loadFiles() },
  { id: 'refresh-tables',  label: 'Refresh Tables',          icon: '↻',  key: '',         action: () => { if (state.connected) loadTables() } },
  { id: 'toggle-sidebar',  label: 'Toggle Sidebar',          icon: '◧',  key: '⌘B',      action: toggleSidebar },
  { id: 'focus-editor',    label: 'Focus Query Editor',      icon: '⌨',  key: '',         action: () => el.queryEditor.focus() },
  { id: 'show-results',    label: 'Show Results Panel',      icon: '▤',  key: '',         action: () => switchPanel('results') },
  { id: 'show-messages',   label: 'Show Messages Panel',     icon: '✉',  key: '',         action: () => switchPanel('messages') },
  { id: 'clear-messages',  label: 'Clear Messages',          icon: '⌫',  key: '',         action: () => { state.messages = []; renderMessages() } },
  { id: 'quick-open',      label: 'Go to Table...',          icon: '▦',  key: '⌘P',      action: () => openPalette('tables') },
]

function openPalette(mode) {
  palette.mode = mode
  palette.active = 0
  palette.overlay.hidden = false

  if (mode === 'commands') {
    palette.input.placeholder = 'Type a command...'
  } else {
    palette.input.placeholder = 'Search tables...'
  }
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

function toggleSidebar() {
  if (state.sidebarVisible) {
    document.querySelector('.activity-item.active')?.classList.remove('active')
    el.sidebar.classList.add('hidden')
    state.sidebarVisible = false
  } else {
    // Restore last active view or default to explorer
    const first = document.querySelector('.activity-item')
    if (first) first.classList.add('active')
    document.querySelectorAll('.sidebar-view').forEach(v => v.classList.remove('active'))
    const view = document.getElementById('view-' + (first?.dataset.view || 'explorer'))
    if (view) view.classList.add('active')
    el.sidebar.classList.remove('hidden')
    state.sidebarVisible = true
  }
}

// ── Global Keyboard Shortcuts ─────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  // Cmd+Shift+P — Command Palette
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'commands') closePalette(); else openPalette('commands')
    return
  }
  // Cmd+P — Quick Open
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'p') {
    e.preventDefault()
    if (palette.mode === 'tables') closePalette(); else openPalette('tables')
    return
  }
  // Cmd+S — Save
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 's') {
    e.preventDefault()
    saveCurrentTab()
    return
  }
  // Cmd+N — New file
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'n') {
    e.preventDefault()
    createNewTab()
    return
  }
  // Cmd+W — Close tab
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'w') {
    e.preventDefault()
    closeTab(state.activeTabId)
    return
  }
  // Cmd+B — Toggle Sidebar
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'b') {
    e.preventDefault()
    toggleSidebar()
    return
  }
  // Escape
  if (e.key === 'Escape' && palette.mode) {
    e.preventDefault()
    closePalette()
    return
  }
})

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

// ── Init ──────────────────────────────────────────────────────────────────────
init()
