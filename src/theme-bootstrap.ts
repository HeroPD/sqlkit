import { themeOrDefault } from './themes'

// Runs before the bundle so the first paint is not default-dark; the roster it
// validates against is shared, and importing it costs no other module.
document.documentElement.dataset.theme = themeOrDefault(localStorage.getItem('sqlkit-theme'))
