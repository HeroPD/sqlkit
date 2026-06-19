import { defineConfig, type Plugin } from 'vite'
import { vitePluginElectron } from './plugins/vite-plugin-electron'

// Defense-in-depth for the packaged renderer: it runs user SQL and renders DB
// result cells, so a stray XSS must not be able to reach window.sqlkit. Scripts
// are pinned to 'self' (no inline) — the modulePreload polyfill is disabled
// below so the build emits no inline <script>. 'unsafe-inline' stays for styles
// only (CodeMirror injects <style> and the grid uses inline style attrs).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
].join('; ')

// Build-only: the dev server needs inline scripts and a WebSocket for HMR, so a
// strict CSP there would break `npm run dev`.
const cspMeta = (): Plugin => ({
  name: 'sqlkit-csp-meta',
  apply: 'build',
  transformIndexHtml: {
    order: 'pre',
    handler: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  },
})

export default defineConfig({
  plugins: [cspMeta(), vitePluginElectron()],
  build: {
    // Electron's Chromium supports modulepreload natively; dropping the polyfill
    // keeps the built HTML free of the inline <script> that 'unsafe-inline' would
    // otherwise require.
    modulePreload: { polyfill: false },
  },
})
