'use strict'

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  engine: 'postgresql',
  connected: false,
  selectedTable: null,
  isConnecting: false,
  isRunning: false
}

const ENGINE_DEFAULTS = {
  postgresql: { port: '5432', database: 'postgres', username: 'postgres' },
  mysql:      { port: '3306', database: 'mysql',    username: 'root' },
  sqlserver:  { port: '1433', database: 'master',   username: 'sa' }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

const el = {
  engineBtns:    document.querySelectorAll('.engine-btn'),
  host:          $('host'),
  port:          $('port'),
  database:      $('database'),
  username:      $('username'),
  password:      $('password'),
  connectBtn:    $('connect-btn'),
  refreshBtn:    $('refresh-btn'),
  connStatus:    $('connection-status'),
  browseBtn:     $('browse-btn'),
  tableEmpty:    $('table-list-empty'),
  tableList:     $('table-list'),
  useTableBtn:   $('use-table-btn'),
  runBtn:        $('run-btn'),
  queryEditor:   $('query-editor'),
  resultsStatus: $('results-status'),
  resultsEmpty:  $('results-empty'),
  resultsScroll: $('results-scroll'),
  resultsThead:  $('results-thead'),
  resultsTbody:  $('results-tbody'),
}

// ── Engine selection ──────────────────────────────────────────────────────────
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
  setConnStatus('Connecting…', '')
  el.connectBtn.disabled = true
  el.connectBtn.textContent = 'Connecting…'

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
    el.connectBtn.classList.add('primary-btn')
    el.refreshBtn.disabled = false
    el.runBtn.disabled = false
    setConnStatus(`Connected — ${res.serverVersion || 'PostgreSQL'}`, 'ok')
    await loadTables()
  } else {
    setConnStatus(res.error, 'error')
    el.connectBtn.textContent = 'Connect'
  }

  el.connectBtn.disabled = false
  state.isConnecting = false
}

async function disconnect() {
  await window.sqlkit.disconnect()
  state.connected = false
  state.selectedTable = null

  el.connectBtn.textContent = 'Connect'
  el.connectBtn.classList.remove('primary-btn')
  el.refreshBtn.disabled = true
  el.runBtn.disabled = true
  el.browseBtn.disabled = true
  el.useTableBtn.disabled = true
  el.tableList.innerHTML = ''
  el.tableEmpty.textContent = 'Connect to explore tables'
  el.tableEmpty.style.display = ''
  setConnStatus('Disconnected', '')
}

// ── Table list ────────────────────────────────────────────────────────────────
async function loadTables() {
  el.tableList.innerHTML = ''
  el.tableEmpty.textContent = 'Loading…'
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

  res.tables.forEach(t => {
    const li = document.createElement('li')
    li.className = 'table-item'
    li.dataset.schema = t.schema
    li.dataset.name   = t.name

    const icon = t.type === 'view' ? '◫' : '▦'
    li.innerHTML = `
      <span class="t-icon">${icon}</span>
      <div class="t-info">
        <span class="t-name">${esc(t.name)}</span>
        <span class="t-schema">${esc(t.schema)}</span>
      </div>`

    li.addEventListener('click', ()      => selectTable(t, li))
    li.addEventListener('dblclick', ()   => browseTable(t))
    el.tableList.appendChild(li)
  })

  // Auto-select first
  const first = res.tables[0]
  const firstEl = el.tableList.querySelector('.table-item')
  if (first && firstEl) selectTable(first, firstEl)
}

function selectTable(t, liEl) {
  state.selectedTable = t
  document.querySelectorAll('.table-item').forEach(e => e.classList.remove('selected'))
  liEl?.classList.add('selected')
  el.browseBtn.disabled = false
  el.useTableBtn.disabled = false
}

el.browseBtn.addEventListener('click', () => {
  if (state.selectedTable) browseTable(state.selectedTable)
})

async function browseTable(t) {
  el.queryEditor.value = `SELECT * FROM "${t.schema}"."${t.name}" LIMIT 200`
  await runQuery()
}

// ── Query ─────────────────────────────────────────────────────────────────────
el.useTableBtn.addEventListener('click', () => {
  if (!state.selectedTable) return
  const t = state.selectedTable
  el.queryEditor.value = `SELECT * FROM "${t.schema}"."${t.name}" LIMIT 200`
  el.queryEditor.focus()
})

el.runBtn.addEventListener('click', runQuery)

el.queryEditor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault()
    const s = el.queryEditor.selectionStart
    const v = el.queryEditor.value
    el.queryEditor.value = v.slice(0, s) + '  ' + v.slice(el.queryEditor.selectionEnd)
    el.queryEditor.selectionStart = el.queryEditor.selectionEnd = s + 2
    return
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    runQuery()
  }
})

async function runQuery() {
  const sql = el.queryEditor.value.trim()
  if (!sql || state.isRunning || !state.connected) return

  state.isRunning = true
  el.runBtn.disabled = true
  el.runBtn.textContent = 'Running…'
  setResultStatus('', '')

  const res = await window.sqlkit.runQuery(sql)

  if (!res.success) {
    setResultStatus(res.error, 'error')
  } else if (res.columns.length === 0) {
    const rows = res.rowCount != null ? `${res.rowCount} row(s) affected` : 'Done'
    const cmd  = res.command ? `${res.command} — ` : ''
    setResultStatus(`${cmd}${rows} (${fmtTime(res.executionTime)})`, 'ok')
  } else {
    renderResults(res)
    const cap = res.rows.length > 10000
    const shown = cap ? 10000 : res.rows.length
    const suffix = cap ? ` (showing first 10,000 of ${res.rows.length})` : ''
    setResultStatus(`${shown} row${shown !== 1 ? 's' : ''} — ${fmtTime(res.executionTime)}${suffix}`, 'ok')
  }

  state.isRunning = false
  el.runBtn.disabled = false
  el.runBtn.textContent = 'Run'
}

// ── Render results ────────────────────────────────────────────────────────────
function renderResults({ columns, rows }) {
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

  // Rows (cap at 10 000)
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
  el.resultsEmpty.style.display = 'none'
  el.resultsScroll.hidden = false
}

// ── Resize handles ────────────────────────────────────────────────────────────
function makeResizable(handleId, targetId, axis) {
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
    const delta = (axis === 'x' ? e.clientX : e.clientY) - start
    const min   = axis === 'x' ? 180  : 80
    const max   = axis === 'x' ? 480  : 560
    const size  = Math.max(min, Math.min(max, startSize + delta))

    if (axis === 'x') {
      target.style.width = size + 'px'
      document.documentElement.style.setProperty('--sidebar-w', size + 'px')
    } else {
      target.style.height = size + 'px'
      document.documentElement.style.setProperty('--query-h', size + 'px')
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
makeResizable('query-resize',   'query-section', 'y')

// ── Helpers ───────────────────────────────────────────────────────────────────
function setConnStatus(msg, cls) {
  el.connStatus.textContent = msg
  el.connStatus.className   = cls
}

function setResultStatus(msg, cls) {
  el.resultsStatus.textContent = msg
  el.resultsStatus.className   = cls
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

// ── Default query ─────────────────────────────────────────────────────────────
el.queryEditor.value =
`SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name
LIMIT 200`
