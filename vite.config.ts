import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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

export default defineConfig(({ mode }) => {
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
  return ({
  // Project Pages site — assets resolve under /<repo>/ on GitHub Pages.
  // Local dev/preview and the packaged offline build are unaffected because
  // GITHUB_PAGES is only set in the deploy workflow.
  base: process.env.GITHUB_PAGES ? '/Autonomous-Drone-Simulator/' : '/',
  plugins: [
    react(),
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
        manualChunks: {
          maplibre: ['maplibre-gl'],
        },
      },
    },
  },
  })
})
