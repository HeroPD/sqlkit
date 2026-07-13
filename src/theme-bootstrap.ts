import type { ThemeId } from './electron'

const stored = localStorage.getItem('sqlkit-theme')
const theme: ThemeId = stored === 'light' || stored === 'midnight-blue' || stored === 'warm-dark' ? stored : 'dark'
document.documentElement.dataset.theme = theme
