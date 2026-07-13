import type { ThemeId } from './electron'

const stored = localStorage.getItem('sqlkit-theme')
const theme: ThemeId = stored === 'light' ? stored : 'dark'
document.documentElement.dataset.theme = theme
