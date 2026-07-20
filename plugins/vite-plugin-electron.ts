import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { builtinModules, createRequire } from 'node:module'
import { resolve } from 'node:path'
import {
  build,
  type InlineConfig,
  type Plugin,
  type ResolvedConfig,
  type Rollup,
  type ViteDevServer,
} from 'vite'

type ElectronPluginOptions = {
  main?: string
  /** Built as CJS (`.cjs`) because sandboxed preload scripts cannot be ESM. */
  preload?: string
  /** utilityProcess entry forked at runtime (SQLite runs off the main process). */
  worker?: string
  outDir?: string
}

type EntryKind = 'main' | 'preload' | 'worker'

type RollupWatcher = Rollup.RollupWatcher

const require = createRequire(import.meta.url)
const builtinExternals = [...new Set(['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)])]

export function vitePluginElectron(options: ElectronPluginOptions = {}): Plugin {
  let viteConfig: ResolvedConfig
  let devServer: ViteDevServer | undefined
  const watchers: RollupWatcher[] = []
  let electronProcess: ChildProcess | undefined
  let closing = false
  let restarting = false

  function resolvePaths() {
    const main = resolve(viteConfig.root, options.main ?? 'electron/main.ts')
    const preloadEntry = resolve(viteConfig.root, options.preload ?? 'electron/preload.ts')
    const preload = existsSync(preloadEntry) ? preloadEntry : undefined
    const workerEntry = resolve(viteConfig.root, options.worker ?? 'electron/db/sqlite.worker.ts')
    const worker = existsSync(workerEntry) ? workerEntry : undefined
    const outDir = resolve(viteConfig.root, options.outDir ?? 'dist-electron')

    return { main, preload, worker, outDir }
  }

  function cleanup() {
    closing = true

    for (const watcher of watchers) {
      void watcher.close()
    }
    watchers.length = 0

    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill()
    }
  }

  function launchElectron(devServerUrl: string) {
    const electronPath = require('electron') as string

    electronProcess = spawn(electronPath, [viteConfig.root], {
      cwd: viteConfig.root,
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: devServerUrl,
      },
    })

    electronProcess.on('exit', (code) => {
      electronProcess = undefined

      if (!closing && !restarting) {
        process.exitCode = code ?? 0
        void devServer?.close()
      }
    })
  }

  function restartElectron(devServerUrl: string) {
    if (restarting) {
      return
    }

    if (!electronProcess) {
      launchElectron(devServerUrl)
      return
    }

    restarting = true
    electronProcess.once('exit', () => {
      restarting = false
      launchElectron(devServerUrl)
    })
    electronProcess.kill()
  }

  /** Starts a watch build and resolves after the first successful bundle. */
  async function watchBuild(entry: string, kind: EntryKind, outDir: string, onBuildEnd: () => void) {
    const watcher = (await build(createBuildConfig(viteConfig, { entry, kind, outDir, watch: true }))) as RollupWatcher
    watchers.push(watcher)

    return new Promise<void>((firstBuild) => {
      watcher.on('event', (event) => {
        if (event.code === 'BUNDLE_END') {
          void event.result.close()
          onBuildEnd()
          firstBuild()
        }

        if (event.code === 'ERROR') {
          viteConfig.logger.error(event.error.message, { error: event.error })
        }
      })
    })
  }

  async function startDev(server: ViteDevServer) {
    const devServerUrl = getDevServerUrl(server)
    const { main, preload, worker, outDir } = resolvePaths()

    // The preload bundle must exist before Electron launches, so wait for its
    // first build before starting the main-process watcher.
    if (preload) {
      await watchBuild(preload, 'preload', outDir, () => {
        server.ws.send({ type: 'full-reload' })
      })
    }

    // The SQLite worker is forked from disk at runtime, so build it before
    // launch (and on change). No restart — a fresh fork picks up the rebuild.
    if (worker) {
      await watchBuild(worker, 'worker', outDir, () => {})
    }

    await watchBuild(main, 'main', outDir, () => {
      restartElectron(devServerUrl)
    })
  }

  return {
    name: 'vite-plugin-electron',
    config(config, env) {
      if (env.command === 'build' && config.base == null) {
        return { base: './' }
      }
    },
    configResolved(config) {
      viteConfig = config
    },
    configureServer(server) {
      devServer = server

      server.httpServer?.once('listening', () => {
        startDev(server).catch((error: unknown) => {
          viteConfig.logger.error(`[vite-plugin-electron] ${String(error)}`)
        })
      })

      server.httpServer?.once('close', cleanup)
    },
    async closeBundle() {
      if (viteConfig.command !== 'build') {
        return
      }

      const { main, preload, worker, outDir } = resolvePaths()

      await rm(outDir, { recursive: true, force: true })
      await build(createBuildConfig(viteConfig, { entry: main, kind: 'main', outDir, watch: false }))

      if (preload) {
        await build(createBuildConfig(viteConfig, { entry: preload, kind: 'preload', outDir, watch: false }))
      }

      if (worker) {
        await build(createBuildConfig(viteConfig, { entry: worker, kind: 'worker', outDir, watch: false }))
      }
    },
  }
}

function getDevServerUrl(server: ViteDevServer) {
  const localUrl = server.resolvedUrls?.local[0]

  if (localUrl) {
    return localUrl
  }

  const address = server.httpServer?.address() as AddressInfo | null

  if (!address) {
    throw new Error('Vite dev server address is unavailable.')
  }

  const protocol = server.config.server.https ? 'https' : 'http'

  return `${protocol}://${formatHost(address)}:${address.port}/`
}

function formatHost(address: AddressInfo) {
  if (address.address === '::' || address.address === '0.0.0.0') {
    return 'localhost'
  }

  return address.family === 'IPv6' ? `[${address.address}]` : address.address
}

function createBuildConfig(
  config: ResolvedConfig,
  target: { entry: string; kind: EntryKind; outDir: string; watch: boolean },
): InlineConfig {
  const { entry, kind, outDir, watch } = target

  // Production dependencies stay external: electron-builder packs them into
  // the app's node_modules, and CJS drivers with lazy optional requires (pg →
  // pg-native) don't survive bundling into ESM.
  const pkg = require(resolve(config.root, 'package.json')) as { dependencies?: Record<string, string> }
  const external = [...builtinExternals, ...Object.keys(pkg.dependencies ?? {})]

  return {
    root: config.root,
    mode: config.mode,
    configFile: false,
    publicDir: false,
    logLevel: config.logLevel,
    build: {
      ssr: entry,
      outDir,
      // Main and preload share outDir, so neither build may empty it;
      // closeBundle clears it once before the production builds.
      emptyOutDir: false,
      // Minify the real build; keep dev/watch readable for debugging.
      minify: !watch,
      sourcemap: watch,
      target: 'node22',
      watch: watch ? {} : null,
      rollupOptions: {
        external,
        output: {
          // Sandboxed preload scripts are loaded as CJS; the main process runs as ESM.
          format: kind === 'preload' ? 'cjs' : 'es',
          entryFileNames: kind === 'preload' ? '[name].cjs' : '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  }
}
