import { state, el, esc, fmtTime } from './utils.js'

// ── Panel Tabs ───────────────────────────────────────────────────────────────

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

export function switchPanel(panel) {
  state.panelTab = panel
  el.panelTabs.forEach(t => {
    t.classList.toggle('active', t.dataset.panel === panel)
  })
  el.resultsPanel.hidden = (panel !== 'results')
  el.messagesPanel.hidden = (panel !== 'messages')
}

// ── Messages ─────────────────────────────────────────────────────────────────

export function addMessage(type, text) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false })
  state.messages.push({ type, text, time })
  renderMessages()
}

export function clearMessages() {
  state.messages = []
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

// ── Query Execution ──────────────────────────────────────────────────────────

el.runBtn.addEventListener('click', runQuery)

export async function runQuery() {
  const sql = el.queryEditor.value.trim()
  if (!sql || state.isRunning || !state.connected) return

  state.isRunning = true
  el.runBtn.disabled = true
  el.runBtn.textContent = '\u25b6 Running...'
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
    const cmd  = res.command ? `${res.command} \u2014 ` : ''
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
    const msg = `${shown} row${shown !== 1 ? 's' : ''} \u2014 ${fmtTime(res.executionTime)}${suffix}`
    addMessage('ok', msg)
    el.statusInfo.textContent = msg
  }

  state.isRunning = false
  el.runBtn.disabled = false
  el.runBtn.textContent = '\u25b6 Run'
}

// ── Render Results ───────────────────────────────────────────────────────────

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
