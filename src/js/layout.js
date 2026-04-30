import { state, el, $, ENGINE_DEFAULTS, esc } from './utils.js'
import { loadFiles, disconnect } from './explorer.js'
import { createNewTab, confirmDiscardOpenTabs, resetEditorState } from './editor.js'
import { resetPanelState } from './panel.js'

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
        if (!confirmWorkspaceSwitch(item.dataset.path)) return
        const res = await window.sqlkit.openWorkspacePath(item.dataset.path)
        if (res.success) await enterWorkspace(res)
      })
    })
  }
}

export async function openWorkspaceDialog() {
  if (!confirmWorkspaceSwitch()) return
  const res = await window.sqlkit.openWorkspace()
  if (res.success) await enterWorkspace(res)
}

function confirmWorkspaceSwitch(nextPath = null) {
  if (!state.workspace) return true
  if (nextPath && nextPath === state.workspace.path) return true
  return confirmDiscardOpenTabs('Switch workspace and discard unsaved changes in open tabs?')
}

export async function enterWorkspace(res) {
  if (state.workspace?.path && state.workspace.path !== res.path) {
    await disconnect(true)
    resetEditorState()
    resetPanelState()
    state.expandedFileFolders.clear()
  }

  state.workspace = { path: res.path, name: res.name, config: res.config || {} }
  showScreen('workbench')
  el.titlebarTitle.textContent = `SqlKit \u2014 ${res.name}`
  el.filesSectionTitle.textContent = res.name
  el.statusWorkspace.textContent = res.name

  const connection = res.config?.connection || {}
  const engine = connection.engine || 'postgresql'
  const defaults = ENGINE_DEFAULTS[engine]

  state.engine = engine
  el.engineBtns.forEach(b => b.classList.toggle('active', b.dataset.engine === engine))
  el.host.value = connection.host || 'localhost'
  el.port.value = connection.port || defaults.port
  el.database.value = connection.database || defaults.database
  el.username.value = connection.username || defaults.username
  el.password.value = ''

  await loadFiles()
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
    const collapsed = header.classList.toggle('collapsed')
    header.closest('.sidebar-section')?.classList.toggle('collapsed', collapsed)
    updateExplorerSectionCollapseLayout()
    updateExplorerResizeState()
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

function makeExplorerSectionsResizable() {
  const handle = $('explorer-section-resize')
  const view = $('view-explorer')
  const workspaceSection = $('workspace-section')
  const tablesSection = $('tables-section')
  const minSectionHeight = 72
  let dragging = false, startY, startHeight, workspaceCollapsedOnDrag, tablesCollapsedOnDrag

  handle.addEventListener('mousedown', e => {
    if (isExplorerResizeDisabled()) return
    dragging = true
    startY = e.clientY
    workspaceCollapsedOnDrag = workspaceSection.classList.contains('collapsed')
    tablesCollapsedOnDrag = tablesSection.classList.contains('collapsed')
    startHeight = workspaceCollapsedOnDrag ? 0 : workspaceSection.offsetHeight
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    handle.classList.add('active')
    e.preventDefault()
  })

  document.addEventListener('mousemove', e => {
    if (!dragging) return
    const delta = e.clientY - startY

    if (workspaceCollapsedOnDrag) {
      if (delta <= 0) return
      expandSidebarSection(workspaceSection)
      workspaceCollapsedOnDrag = false
    }

    if (tablesCollapsedOnDrag) {
      if (delta >= 0) return
      expandSidebarSection(tablesSection)
      tablesCollapsedOnDrag = false
    }

    const availableHeight = view.clientHeight - view.querySelector('.sidebar-title').offsetHeight - handle.offsetHeight
    const maxHeight = Math.max(minSectionHeight, availableHeight - minSectionHeight)
    const height = Math.max(minSectionHeight, Math.min(maxHeight, startHeight + delta))

    workspaceSection.style.flex = `0 0 ${height}px`
    tablesSection.style.flex = '1 1 0'
  })

  document.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    handle.classList.remove('active')
  })

  handle.addEventListener('dblclick', () => {
    if (isExplorerResizeDisabled()) return
    workspaceSection.style.flex = ''
    tablesSection.style.flex = ''
  })

  updateExplorerResizeState()
}

function isExplorerResizeDisabled() {
  return $('tables-section')?.classList.contains('collapsed')
}

function updateExplorerResizeState() {
  $('explorer-section-resize')?.classList.toggle('disabled', isExplorerResizeDisabled())
}

function updateExplorerSectionCollapseLayout() {
  const workspaceCollapsed = $('workspace-section')?.classList.contains('collapsed')
  const tablesCollapsed = $('tables-section')?.classList.contains('collapsed')
  $('tables-section')?.classList.toggle('pin-bottom', tablesCollapsed && !workspaceCollapsed)
}

function expandSidebarSection(section) {
  section.classList.remove('collapsed')
  section.querySelector('.section-header')?.classList.remove('collapsed')
  updateExplorerSectionCollapseLayout()
  updateExplorerResizeState()
}

makeResizable('sidebar-resize', 'sidebar', 'x')
makeResizable('panel-resize',   'panel',   'y', true)
makeExplorerSectionsResizable()
