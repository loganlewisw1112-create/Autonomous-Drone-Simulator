import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'path'
import type { Plugin } from 'vite'

function gitSha(cwd: string): string {
  const injected = process.env.VITE_GIT_SHA
    ?? process.env.VERCEL_GIT_COMMIT_SHA
    ?? process.env.GITHUB_SHA
  if (injected && /^[0-9a-f]{7,40}$/i.test(injected.trim())) return injected.trim().toLowerCase()
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().toLowerCase()
  } catch {
    return 'unknown'
  }
}

function targetParityArtifactPlugin(buildInfo: {
  version: string
  target: 'windows' | 'mobile' | 'classroom'
  gitSha: string
}): Plugin {
  let outDir = resolve(process.cwd(), 'dist')
  const harnessFile = 'target-parity-harness.js'

  return {
    name: 'target-parity-artifact',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    buildStart() {
      this.emitFile({
        type: 'chunk',
        id: resolve(process.cwd(), 'src/parity/artifactParity.ts'),
        fileName: harnessFile,
        preserveSignature: 'strict',
      })
    },
    async closeBundle() {
      // Import the code Rollup actually emitted, not its TypeScript source. A successful build
      // therefore leaves an executable target-parity.json inside every deployed artifact.
      const harnessUrl = `${pathToFileURL(resolve(outDir, harnessFile)).href}?target=${buildInfo.target}`
      const harness = await import(harnessUrl) as {
        default(input: typeof buildInfo): Promise<unknown>
      }
      const manifest = await harness.default(buildInfo)
      writeFileSync(
        resolve(outDir, 'target-parity.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      )
    },
  }
}

// MapLibre's tile/style worker and the shared chunk it imports by relative path.
const MAPLIBRE_WORKER_FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const
const MAPLIBRE_DIST = resolve(__dirname, 'node_modules/maplibre-gl/dist')

/**
 * `maplibre-worker-<hash>`: the folder name the worker files ship under, hashed from their contents.
 * Production serves assets `immutable` for a year, so these files must change URL whenever they change
 * content — a fixed name let returning browsers pair a cached old worker with a new MapLibre chunk,
 * which renders a blank (near-white) map. See src/components/maplibreWorker.ts.
 */
function maplibreWorkerDirName(srcDir = MAPLIBRE_DIST): string {
  const hash = createHash('sha256')
  for (const file of MAPLIBRE_WORKER_FILES) {
    const src = resolve(srcDir, file)
    if (!existsSync(src)) {
      throw new Error(
        `[maplibre-worker-asset] ${src} not found — maplibre-gl's dist layout changed. ` +
        `Update this plugin so the tile/style worker is still copied into the build.`,
      )
    }
    hash.update(file).update('\0').update(readFileSync(src))
  }
  return `maplibre-worker-${hash.digest('hex').slice(0, 12)}`
}

function maplibreWorkerAssetPlugin(workerDir: string): Plugin {
  // MapLibre v6 starts its tile/style worker at runtime via `new URL(`./${name}`, import.meta.url)`
  // with a *dynamically-chosen* filename. Rollup cannot statically analyse that expression, so it
  // never emits the worker chunk, and without help the map silently renders zero features (no
  // tiles are ever parsed). `optimizeDeps.exclude` below fixes only the dev server. For the build,
  // this plugin copies the worker and its shared chunk into a content-hashed folder, and the app
  // points MapLibre there with setWorkerUrl() (src/components/maplibreWorker.ts, which reads the
  // VITE_MAPLIBRE_WORKER_PATH define). The build fails if either half goes missing, so a blank map
  // can never ship silently again.
  let outDir = ''
  let assetsDir = 'assets'
  return {
    name: 'maplibre-worker-asset',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
      assetsDir = config.build.assetsDir
    },
    closeBundle() {
      const assetsOut = resolve(outDir, assetsDir)
      const target = resolve(assetsOut, workerDir)
      mkdirSync(target, { recursive: true })
      for (const file of MAPLIBRE_WORKER_FILES) copyFileSync(resolve(MAPLIBRE_DIST, file), resolve(target, file))
      // The app must actually point MapLibre at that folder: MapLibre's fallback path is never
      // emitted, so a lost setWorkerUrl() call would mean a 404 worker and a blank map.
      const workerPath = `${workerDir}/maplibre-gl-worker.mjs`
      const wired = readdirSync(assetsOut)
        .filter((name) => name.endsWith('.js'))
        .some((name) => readFileSync(resolve(assetsOut, name), 'utf8').includes(workerPath))
      if (!wired) {
        throw new Error(
          `[maplibre-worker-asset] no emitted chunk references ${workerPath}. ` +
          `src/components/maplibreWorker.ts must stay imported by main.tsx, or the map renders blank.`,
        )
      }
    },
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appTarget = process.env.VITE_APP_TARGET ?? env.VITE_APP_TARGET ?? 'universal'
  const target = mode === 'classroom' || env.VITE_CLASSROOM_ENABLED === 'true'
    ? 'classroom'
    : appTarget === 'mobile'
      ? 'mobile'
      : 'windows'
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string }
  const version = packageJson.version ?? '0.0.0'
  const commit = gitSha(process.cwd())
  const buildInfo = {
    version,
    target: target as 'windows' | 'mobile' | 'classroom',
    gitSha: commit,
    distributionChannel: env.VITE_DISTRIBUTION_CHANNEL ?? (process.env.VERCEL === '1' ? 'public_demo' : 'development'),
    licenseExpiresAt: env.VITE_LICENSE_EXPIRES_AT ?? null,
  }
  const buildingLayerModule = appTarget === 'mobile'
    ? 'scenarioBuildingLayers.mobile.ts'
    : appTarget === 'windows'
      ? 'scenarioBuildingLayers.windows.ts'
      : 'scenarioBuildingLayers.target.ts'
  const terrainLayerModule = appTarget === 'mobile'
    ? 'scenarioTerrainLayers.mobile.ts'
    : appTarget === 'windows'
      ? 'scenarioTerrainLayers.windows.ts'
      : 'scenarioTerrainLayers.target.ts'

  const defineEnv: Record<string, string> = {}
  defineEnv['import.meta.env.VITE_APP_VERSION'] = JSON.stringify(version)
  defineEnv['import.meta.env.VITE_BUILD_TARGET'] = JSON.stringify(target)
  defineEnv['import.meta.env.VITE_GIT_HASH'] = JSON.stringify(commit)
  defineEnv['import.meta.env.VITE_DISTRIBUTION_CHANNEL'] = JSON.stringify(
    env.VITE_DISTRIBUTION_CHANNEL ?? (process.env.VERCEL === '1' ? 'public_demo' : 'development'),
  )
  if (mode === 'classroom') {
    defineEnv['import.meta.env.VITE_CLASSROOM_ENABLED'] = JSON.stringify('true')
  }
  // Read from the process only (never .env files) and always defined, so every build that
  // harness/server.mjs did not start folds HARNESS_ENABLED to false and drops the harness chunk.
  defineEnv['import.meta.env.VITE_HARNESS'] = JSON.stringify(process.env.VITE_HARNESS === '1' ? '1' : '')
  // Build only: the dev server serves maplibre-gl unbundled, where its own worker path is right.
  const maplibreWorkerDir = command === 'build' ? maplibreWorkerDirName() : ''
  defineEnv['import.meta.env.VITE_MAPLIBRE_WORKER_PATH'] = JSON.stringify(
    maplibreWorkerDir ? `${maplibreWorkerDir}/maplibre-gl-worker.mjs` : '',
  )
  return ({
  // Project Pages site — assets resolve under /<repo>/ on GitHub Pages.
  // Local dev/preview and the packaged offline build are unaffected because
  // GITHUB_PAGES is only set in the deploy workflow.
  base: process.env.GITHUB_PAGES ? '/Autonomous-Drone-Simulator/' : '/',
  plugins: [
    react(),
    maplibreWorkerAssetPlugin(maplibreWorkerDir),
    targetParityArtifactPlugin(buildInfo),
    {
      name: 'release-build-info',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'build-info.json',
          source: `${JSON.stringify(buildInfo, null, 2)}\n`,
        })
      },
    },
  ],
  // `vite build --mode classroom` turns on the classroom build without needing an env file.
  // The per-mode .env files Vite would normally use for this are gitignored (.env.* with only
  // .env.example excepted), so a committed one would not survive a clone — and an inline
  // `VITE_X=true vite build` prefix is not portable to the Windows shells this project targets.
  // The Vercel classroom project sets VITE_CLASSROOM_ENABLED in its dashboard instead and uses
  // the ordinary build command, so both routes reach the same flag.
  define: defineEnv,
  optimizeDeps: {
    // MapLibre v6 spins up its tile/style worker via a relative import.meta.url path; Vite's
    // dep pre-bundler rewrites that path but never emits the worker chunk it points to, so the
    // worker 404s and the map silently never fetches a style. Excluding it serves the package's
    // own ESM build unmodified, which resolves the worker correctly.
    exclude: ['maplibre-gl'],
  },
  resolve: {
    // Resolve the physical-building renderer at build time. This is a release boundary, not
    // only a runtime branch: the mobile artifact never receives the desktop extrusion module.
    alias: [
      {
        find: '@/components/scenarioBuildingLayers.target',
        replacement: resolve(__dirname, 'src/components', buildingLayerModule),
      },
      {
        find: '@/components/scenarioTerrainLayers.target',
        replacement: resolve(__dirname, 'src/components', terrainLayerModule),
      },
      { find: '@', replacement: resolve(__dirname, 'src') },
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // maplibre is a static import (core map), so it stays a named vendor chunk.
        // recharts is NOT listed here: it's only reached via the lazy TelemetryCharts
        // component, so Rollup splits it into an async chunk automatically — listing it
        // in manualChunks would pull it back into the entry's modulepreload graph.
        // Function form: Vite 8's Rolldown bundler rejects the object form.
        manualChunks(id: string) {
          return /[\\/]node_modules[\\/]maplibre-gl[\\/]/.test(id) ? 'maplibre' : undefined
        },
      },
    },
  },
  })
})
