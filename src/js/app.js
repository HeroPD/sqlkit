// ── SqlKit Entry Point ───────────────────────────────────────────────────────

import { showWelcome, enterWorkspace } from './layout.js'
import { confirmDiscardOpenTabs } from './editor.js'
import './explorer.js'
import './panel.js'
import './palette.js'

window.sqlkit.onRequestClose(() => {
  const shouldClose = confirmDiscardOpenTabs('Discard unsaved changes in open tabs and quit?')
  window.sqlkit.respondToClose(shouldClose)
})

async function init() {
  const last = await window.sqlkit.getLastWorkspace()
  if (last.success) {
    const res = await window.sqlkit.openWorkspacePath(last.path)
    if (res.success) {
      await enterWorkspace(res)
      return
    }
  }
  showWelcome()
}

init()
