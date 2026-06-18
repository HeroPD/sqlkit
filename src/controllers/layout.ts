import type { ReactiveController, ReactiveControllerHost } from 'lit'

type Deps = {
  // Committing a collapse drag drops the active sidebar view (host state).
  onSidebarCollapse: () => void
  // The results-panel element, measured at the start of a panel-resize drag.
  panelEl: () => HTMLElement | null
}

// Owns the resizable-layout state: sidebar width + collapse, and the results
// panel height. Drag handlers use pointer capture on the grabbed handle, so
// they keep tracking outside the element. Fields aren't reactive on their own,
// so every mutation calls host.requestUpdate().
export class LayoutController implements ReactiveController {
  sidebarWidth = 280
  resizing: { startX: number; startWidth: number } | null = null
  sidebarCollapsing = false

  // null = the default split: results take half of the editor area.
  panelHeight: number | null = null
  panelResizing: { startY: number; startHeight: number } | null = null

  private host: ReactiveControllerHost
  private deps: Deps

  constructor(host: ReactiveControllerHost, deps: Deps) {
    this.host = host
    this.deps = deps
    host.addController(this)
  }

  // A drag in flight when the workbench unmounts has nothing left to track.
  hostDisconnected() {
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
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this.resizing = { startX: event.clientX, startWidth: this.sidebarWidth }
    event.preventDefault()
    this.host.requestUpdate() // show the handle's active highlight from pointerdown
  }

  onSidebarResizeMove = (event: PointerEvent) => {
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

  onSidebarResizeEnd = (event: PointerEvent) => {
    if (!this.resizing) return
    this.resizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)

    if (this.sidebarCollapsing) {
      this.sidebarCollapsing = false
      this.sidebarWidth = 280
      this.deps.onSidebarCollapse()
    }
    this.host.requestUpdate()
  }

  onPanelResizeStart = (event: PointerEvent) => {
    const panel = this.deps.panelEl()
    if (!panel) return
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    this.panelResizing = { startY: event.clientY, startHeight: panel.offsetHeight }
    event.preventDefault()
    this.host.requestUpdate() // show the handle's active highlight from pointerdown
  }

  onPanelResizeMove = (event: PointerEvent) => {
    if (!this.panelResizing) return
    // Dragging up grows the panel.
    const raw = this.panelResizing.startHeight - (event.clientY - this.panelResizing.startY)
    this.panelHeight = Math.max(80, Math.min(600, raw))
    this.host.requestUpdate()
  }

  onPanelResizeEnd = (event: PointerEvent) => {
    if (!this.panelResizing) return
    this.panelResizing = null
    ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
    this.host.requestUpdate()
  }
}
