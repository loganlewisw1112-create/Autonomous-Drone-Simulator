import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'path'

/** Local-only unlock material from gitignored `local-secrets/`. Never commit that folder. */
function loadLocalInstructorAccessHash(cwd: string): string | undefined {
  try {
    const filePath = resolve(cwd, 'local-secrets', 'instructor-access-hash.txt')
    if (!existsSync(filePath)) return undefined
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase()
    }
  } catch {
    /* missing or unreadable — build continues without instructor unlock */
  }
  return undefined
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appTarget = process.env.VITE_APP_TARGET ?? env.VITE_APP_TARGET ?? 'universal'
  const buildingLayerModule = appTarget === 'mobile'
    ? 'scenarioBuildingLayers.mobile.ts'
    : appTarget === 'windows'
      ? 'scenarioBuildingLayers.windows.ts'
      : 'scenarioBuildingLayers.target.ts'

  const defineEnv: Record<string, string> = {}
  if (mode === 'classroom') {
    defineEnv['import.meta.env.VITE_CLASSROOM_ENABLED'] = JSON.stringify('true')
  }
  // Prefer process/dashboard env (e.g. Vercel), else local-secrets file for LAN builds.
  const instructorHash = (process.env.VITE_INSTRUCTOR_ACCESS_HASH
    ?? env.VITE_INSTRUCTOR_ACCESS_HASH
    ?? loadLocalInstructorAccessHash(process.cwd()))?.trim()
  if (instructorHash && /^[0-9a-fA-F]{64}$/.test(instructorHash)) {
    const hex = instructorHash.toLowerCase()
    // Expose via both the usual Vite env key and a global define so every chunk
    // (including lazy ClassroomEntry) sees the same digest at runtime.
    defineEnv['import.meta.env.VITE_INSTRUCTOR_ACCESS_HASH'] = JSON.stringify(hex)
    defineEnv['globalThis.__INSTRUCTOR_ACCESS_HASH__'] = JSON.stringify(hex)
  }

  return ({
  // Project Pages site — assets resolve under /<repo>/ on GitHub Pages.
  // Local dev/preview and the packaged offline build are unaffected because
  // GITHUB_PAGES is only set in the deploy workflow.
  base: process.env.GITHUB_PAGES ? '/Autonomous-Drone-Simulator/' : '/',
  plugins: [react()],
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
