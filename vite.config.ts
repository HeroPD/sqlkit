import { defineConfig } from 'vite'
import { vitePluginElectron } from './plugins/vite-plugin-electron'

export default defineConfig({
  plugins: [vitePluginElectron()],
})
