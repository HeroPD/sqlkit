// Platform-aware keybind labels, shared by every component that displays
// shortcuts (palette, empty screen, explorer hints, results panel).
export const isMac = navigator.platform.startsWith('Mac')

export const mod = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`)
