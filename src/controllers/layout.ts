import type { ReactiveController, ReactiveControllerHost } from 'lit'

// The editor pane never shrinks below this; the results panel grows freely into
// the rest of the area (no fixed cap). A small floor keeps the panel usable.
const EDITOR_MIN_HEIGHT = 250
const RESULTS_MIN_HEIGHT = 80

type Deps = {
  // Committing a collapse drag drops the active sidebar view (host state).
  onSidebarCollapse: () => void
  // The results-panel and editor-pane elements, measured at panel-resize start
  // to bound the drag by the editor's minimum height.
  panelEl: () => HTMLElement | null
  editorPaneEl: () => HTMLElement | null
}

// Owns the resizable-layout state: sidebar width + collapse, and the results
// panel height. Move/up are listened for on `window`, not the grabbed handle:
// pointer events bubble (composed) to window regardless of target, so the drag
// keeps tracking even as the pointer crosses the CodeMirror editor — its nested
// shadow DOM + contenteditable drops pointer capture, which froze the drag.
// Fields aren't reactive on their own, so every mutation calls requestUpdate().
export class LayoutController implements ReactiveController {
  sidebarWidth = 280
  resizing: { startX: number; startWidth: number } | null = null
  sidebarCollapsing = false

  // null = the default split: results take 70% of the editor area, editor 30%.
  panelHeight: number | null = null
  panelResizing: { startY: number; startHeight: number; maxHeight: number } | null = null

  private host: ReactiveControllerHost
  private deps: Deps

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
    host.addController(this)
  }

  // A drag in flight when the workbench unmounts has nothing left to track.
  hostDisconnected() {
    this.stopSidebarResize()
    this.stopPanelResize()
    this.resizing = null
    this.panelResizing = null
    this.sidebarCollapsing = false
  }

  resetSidebarWidth = () => {
    this.sidebarWidth = 280
    this.host.requestUpdate()
  }

  resetPanelHeight = () => {
    this.panelHeight = null
    this.host.requestUpdate()
  }

  onSidebarResizeStart = (event: PointerEvent) => {
    this.resizing = { startX: event.clientX, startWidth: this.sidebarWidth }
    event.preventDefault()
    window.addEventListener('pointermove', this.onSidebarResizeMove)
    window.addEventListener('pointerup', this.onSidebarResizeEnd)
    window.addEventListener('pointercancel', this.onSidebarResizeEnd)
    this.host.requestUpdate()
  }

  private onSidebarResizeMove = (event: PointerEvent) => {
    if (!this.resizing) return
    const raw = this.resizing.startWidth + (event.clientX - this.resizing.startX)

    // Dragged under the minimum with a little intent margin: snap closed.
    // Dragging back out reopens at the minimum.
    if (raw < 110) {
      this.sidebarCollapsing = true
      this.host.requestUpdate()
      return
    }

    this.sidebarCollapsing = false
    this.sidebarWidth = Math.max(170, Math.min(500, raw))
    this.host.requestUpdate()
  }

  private onSidebarResizeEnd = () => {
    if (!this.resizing) return
    this.resizing = null
    this.stopSidebarResize()

    if (this.sidebarCollapsing) {
      this.sidebarCollapsing = false
      this.sidebarWidth = 280
      this.deps.onSidebarCollapse()
    }
    this.host.requestUpdate()
  }

  private stopSidebarResize() {
    window.removeEventListener('pointermove', this.onSidebarResizeMove)
    window.removeEventListener('pointerup', this.onSidebarResizeEnd)
    window.removeEventListener('pointercancel', this.onSidebarResizeEnd)
  }

  onPanelResizeStart = (event: PointerEvent) => {
    const panel = this.deps.panelEl()
    const editorPane = this.deps.editorPaneEl()
    if (!panel || !editorPane) return
    // Editor and results share this space (the divider is fixed); cap the panel
    // so the editor keeps its minimum height.
    const available = panel.offsetHeight + editorPane.offsetHeight
    this.panelResizing = {
      startY: event.clientY,
      startHeight: panel.offsetHeight,
      maxHeight: Math.max(RESULTS_MIN_HEIGHT, available - EDITOR_MIN_HEIGHT),
    }
    event.preventDefault()
    window.addEventListener('pointermove', this.onPanelResizeMove)
    window.addEventListener('pointerup', this.onPanelResizeEnd)
    window.addEventListener('pointercancel', this.onPanelResizeEnd)
    this.host.requestUpdate()
  }

  private onPanelResizeMove = (event: PointerEvent) => {
    if (!this.panelResizing) return
    // Dragging up grows the panel.
    const raw = this.panelResizing.startHeight - (event.clientY - this.panelResizing.startY)
    this.panelHeight = Math.max(RESULTS_MIN_HEIGHT, Math.min(this.panelResizing.maxHeight, raw))
    this.host.requestUpdate()
  }

  private onPanelResizeEnd = () => {
    if (!this.panelResizing) return
    this.panelResizing = null
    this.stopPanelResize()
    this.host.requestUpdate()
  }

  private stopPanelResize() {
    window.removeEventListener('pointermove', this.onPanelResizeMove)
    window.removeEventListener('pointerup', this.onPanelResizeEnd)
    window.removeEventListener('pointercancel', this.onPanelResizeEnd)
  }
}
