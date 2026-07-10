import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  // Project Pages site — assets resolve under /<repo>/ on GitHub Pages.
  // Local dev/preview and the packaged offline build are unaffected because
  // GITHUB_PAGES is only set in the deploy workflow.
  base: process.env.GITHUB_PAGES ? '/Autonomous-Drone-Simulator/' : '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          charts: ['recharts'],
        },
      },
    },
  },
})
