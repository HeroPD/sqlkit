// ── SqlKit Entry Point ───────────────────────────────────────────────────────

import { showWelcome, enterWorkspace } from './layout.js'
import './explorer.js'
import './editor.js'
import './panel.js'
import './palette.js'

async function init() {
  const last = await window.sqlkit.getLastWorkspace()
  if (last.success) {
    const res = await window.sqlkit.openWorkspacePath(last.path)
    if (res.success) {
      enterWorkspace(res)
      return
    }
  }
  showWelcome()
}

init()
