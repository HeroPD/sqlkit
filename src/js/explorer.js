import { state, el, ENGINE_DEFAULTS, esc, setConnStatus, setStatusConnection, setStatusDisconnected } from './utils.js'
import { switchTab, createNewTab, renderTabs, updateLineNumbers } from './editor.js'
import { addMessage, runQuery } from './panel.js'

function getTableKey(t) {
  return `${t.schema}.${t.name}`
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

export function findTableTreeItem(table) {
  return Array.from(el.tableTree.querySelectorAll('.tree-item')).find(item => (
    item.dataset.schema === table.schema && item.dataset.name === table.name
  ))
}

// ── Engine Selection ─────────────────────────────────────────────────────────

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

// ── Connect / Disconnect ─────────────────────────────────────────────────────

el.connectBtn.addEventListener('click', () => {
  state.connected ? disconnect() : connect()
})

el.refreshBtn.addEventListener('click', loadTables)

export async function connect() {
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
    setConnStatus(`Connected \u2014 ${ver}`, 'ok')
    setStatusConnection(ver)
    addMessage('ok', `Connected to ${ver}`)
    await loadTables()
    saveConnectionConfig(profile)
  } else {
    setConnStatus(res.error, 'error')
    el.connectBtn.textContent = 'Connect'
    addMessage('error', res.error)
  }

  el.connectBtn.disabled = false
  state.isConnecting = false
}

export async function disconnect(silent = false) {
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
  if (!silent) addMessage('info', 'Disconnected')
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

// ── Files ────────────────────────────────────────────────────────────────────

el.newFileBtn.addEventListener('click', () => createNewTab())
el.refreshFilesBtn.addEventListener('click', loadFiles)

export async function loadFiles() {
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

export function updateFileListActive() {
  const activeTab = state.tabs.find(t => t.id === state.activeTabId)
  el.fileTree.querySelectorAll('.file-item').forEach(item => {
    item.classList.toggle('active', activeTab?.filePath === item.dataset.path)
  })
}

// ── Table Tree ───────────────────────────────────────────────────────────────

function clearTableTree() {
  el.tableTree.querySelectorAll('.tree-item').forEach(e => e.remove())
}

export async function loadTables() {
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
  const icon = isView ? '\u25eb' : '\u25a6'

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

export function selectTable(t, itemEl) {
  state.selectedTable = t
  el.tableTree.querySelectorAll('.tree-item').forEach(e => e.classList.remove('selected'))
  itemEl?.classList.add('selected')
}

async function toggleTableExpand(t, itemEl) {
  const key = getTableKey(t)
  const chevron = itemEl.querySelector('.tree-chevron')

  if (state.expandedTables.has(key)) {
    state.expandedTables.delete(key)
    chevron.classList.remove('expanded')
    Array.from(el.tableTree.querySelectorAll('.tree-column'))
      .filter(e => e.dataset.parent === key)
      .forEach(e => e.remove())
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
          <span class="tree-icon column-icon">\u25c7</span>
          <span class="tree-label">${esc(col.name)}</span>
          <span class="tree-type">${esc(col.type)}</span>`

        frag.appendChild(colDiv)
      })
      itemEl.after(frag)
    }
  }
}

export async function browseTable(t) {
  if (state.tabs.length === 0) createNewTab()
  const tab = state.tabs.find(tb => tb.id === state.activeTabId)
  if (tab) {
    tab.content = `SELECT * FROM ${quoteIdentifier(t.schema)}.${quoteIdentifier(t.name)} LIMIT 200`
    tab.modified = true
    el.queryEditor.value = tab.content
    updateLineNumbers()
    renderTabs()
  }
  await runQuery()
}
