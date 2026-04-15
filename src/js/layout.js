import { state, el, $, ENGINE_DEFAULTS, esc } from './utils.js'
import { loadFiles } from './explorer.js'
import { createNewTab } from './editor.js'

// ── Screens ──────────────────────────────────────────────────────────────────

export function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  const target = name === 'welcome' ? el.screenWelcome : el.screenWorkbench
  target.classList.add('active')
}

// ── Welcome ──────────────────────────────────────────────────────────────────

export async function showWelcome() {
  showScreen('welcome')

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

export async function openWorkspaceDialog() {
  const res = await window.sqlkit.openWorkspace()
  if (res.success) enterWorkspace(res)
}

export function enterWorkspace(res) {
  state.workspace = { path: res.path, name: res.name, config: res.config || {} }
  showScreen('workbench')
  el.titlebarTitle.textContent = `SqlKit \u2014 ${res.name}`
  el.statusWorkspace.textContent = res.name

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

  loadFiles()
  if (state.tabs.length === 0) createNewTab()
}

el.welcomeOpen.addEventListener('click', openWorkspaceDialog)

// ── Activity Bar ─────────────────────────────────────────────────────────────

el.activityItems.forEach(item => {
  item.addEventListener('click', () => {
    const view = item.dataset.view
    const wasActive = item.classList.contains('active')

    if (wasActive) {
      item.classList.remove('active')
      el.sidebar.classList.add('hidden')
      state.sidebarVisible = false
    } else {
      el.activityItems.forEach(i => i.classList.remove('active'))
      item.classList.add('active')
      el.sidebar.classList.remove('hidden')
      state.sidebarVisible = true

      document.querySelectorAll('.sidebar-view').forEach(v => v.classList.remove('active'))
      const target = document.getElementById('view-' + view)
      if (target) target.classList.add('active')
    }
  })
})

// ── Collapsible Sections ─────────────────────────────────────────────────────

el.sectionHeaders.forEach(header => {
  header.addEventListener('click', (e) => {
    if (e.target.closest('.section-actions')) return
    header.classList.toggle('collapsed')
  })
})

// ── Toggle Sidebar ───────────────────────────────────────────────────────────

export function toggleSidebar() {
  if (state.sidebarVisible) {
    document.querySelector('.activity-item.active')?.classList.remove('active')
    el.sidebar.classList.add('hidden')
    state.sidebarVisible = false
  } else {
    const first = document.querySelector('.activity-item')
    if (first) first.classList.add('active')
    document.querySelectorAll('.sidebar-view').forEach(v => v.classList.remove('active'))
    const view = document.getElementById('view-' + (first?.dataset.view || 'explorer'))
    if (view) view.classList.add('active')
    el.sidebar.classList.remove('hidden')
    state.sidebarVisible = true
  }
}

// ── Resize Handles ───────────────────────────────────────────────────────────

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
