import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const appTarget = process.env.VITE_APP_TARGET ?? env.VITE_APP_TARGET ?? 'universal'
  const buildingLayerModule = appTarget === 'mobile'
    ? 'scenarioBuildingLayers.mobile.ts'
    : appTarget === 'windows'
      ? 'scenarioBuildingLayers.windows.ts'
      : 'scenarioBuildingLayers.target.ts'

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
  define: mode === 'classroom'
    ? { 'import.meta.env.VITE_CLASSROOM_ENABLED': JSON.stringify('true') }
    : {},
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
