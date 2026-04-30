import { state, el, $, esc } from './utils.js'
import { updateFileListActive, loadFiles } from './explorer.js'
import { addMessage, runQuery } from './panel.js'

// ── Tabs ─────────────────────────────────────────────────────────────────────

export function createNewTab() {
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

export function switchTab(id) {
  syncActiveTabState()

  state.activeTabId = id
  const tab = state.tabs.find(t => t.id === id)
  if (tab) {
    $('editor-wrap').style.display = ''
    $('panel-resize').style.display = ''
    $('panel').style.display = ''
    el.queryEditor.value = tab.content
    updateLineNumbers()
  }
  renderTabs()
  updateFileListActive()
}

export function closeTab(id) {
  syncActiveTabState()
  const idx = state.tabs.findIndex(t => t.id === id)
  if (idx === -1) return
  const tab = state.tabs[idx]

  if (tab.modified && !window.confirm(`Discard unsaved changes to "${tab.name}"?`)) {
    return false
  }

  state.tabs.splice(idx, 1)

  if (state.tabs.length === 0) {
    state.activeTabId = null
    createNewTab()
    return true
  }

  if (state.activeTabId === id) {
    const newIdx = Math.min(idx, state.tabs.length - 1)
    switchTab(state.tabs[newIdx].id)
  } else {
    renderTabs()
  }

  return true
}

export function renderTabs() {
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

export function markCurrentTabModified() {
  const tab = state.tabs.find(t => t.id === state.activeTabId)
  if (tab && !tab.modified) {
    tab.modified = true
    renderTabs()
  }
}

export function syncActiveTabState() {
  const current = state.tabs.find(t => t.id === state.activeTabId)
  if (!current) return

  const editorVal = el.queryEditor.value
  if (current.content !== editorVal) {
    current.content = editorVal
    current.modified = true
  }
}

export function hasModifiedTabs() {
  syncActiveTabState()
  return state.tabs.some(tab => tab.modified)
}

export function confirmDiscardOpenTabs(message) {
  return !hasModifiedTabs() || window.confirm(message)
}

export function resetEditorState() {
  state.tabs = []
  state.activeTabId = null
  state.nextTabId = 1
  state.untitledCount = 0
  el.tabBar.innerHTML = ''
  el.queryEditor.value = ''
  updateLineNumbers()
  $('editor-wrap').style.display = 'none'
  $('panel-resize').style.display = 'none'
  $('panel').style.display = 'none'
}

// ── Save ─────────────────────────────────────────────────────────────────────

let saveResolve = null

export async function saveCurrentTab() {
  const tab = state.tabs.find(t => t.id === state.activeTabId)
  if (!tab) return

  tab.content = el.queryEditor.value

  if (tab.filePath) {
    const res = await window.sqlkit.saveFile(tab.filePath, tab.content)
    if (res.success) {
      tab.relativePath = res.relativePath || tab.relativePath
      tab.modified = false
      renderTabs()
      addMessage('ok', `Saved ${tab.name}`)
    } else {
      addMessage('error', `Failed to save: ${res.error}`)
    }
  } else {
    const name = await promptFileName(tab.name)
    if (!name) return

    const res = await window.sqlkit.saveNewFile(name, tab.content)
    if (res.success) {
      tab.name = res.name
      tab.filePath = res.path
      tab.relativePath = res.relativePath
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

function normalizeSavePath(name) {
  const slashName = name.trim().replace(/\\/g, '/')

  if (slashName.startsWith('/')) return { error: 'Path must be relative to the workspace' }

  const normalized = slashName
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/')

  if (!normalized) return { error: 'Name cannot be empty' }

  const parts = normalized.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part === '.sqlkit')) {
    return { error: 'Path contains an invalid folder segment' }
  }

  return { path: normalized.toLowerCase().endsWith('.sql') ? normalized : normalized + '.sql' }
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
  const normalized = normalizeSavePath(el.saveInput.value)
  if (normalized.error) {
    el.saveError.textContent = normalized.error
    return
  }

  const filePath = normalized.path
  if (state.files.some(f => (f.relativePath || f.name) === filePath)) {
    el.saveError.textContent = `"${filePath}" already exists`
    return
  }

  el.saveOverlay.hidden = true
  if (saveResolve) {
    saveResolve(filePath)
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

// ── Query Editor ─────────────────────────────────────────────────────────────

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

el.queryEditor.addEventListener('scroll', () => {
  el.lineNumbers.scrollTop = el.queryEditor.scrollTop
})

export function updateLineNumbers() {
  const lines = el.queryEditor.value.split('\n').length
  el.lineNumbers.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n')
}
