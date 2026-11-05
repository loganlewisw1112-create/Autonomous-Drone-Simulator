import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveMaplibreWorkerUrl } from '@/components/maplibreWorker'

// Regression for the October 2026 "white map on Mac" report: a returning browser kept a cached
// MapLibre 6.11 worker under a fixed URL while the site moved to 6.12, and no tile ever drew.
describe('versioned MapLibre worker URL', () => {
  const path = 'maplibre-worker-0123456789ab/maplibre-gl-worker.mjs'

  it('resolves next to the chunk that loads it, under any deploy base', () => {
    expect(resolveMaplibreWorkerUrl(path, 'https://autonomous-drone-simulator.vercel.app/assets/index-abc.js'))
      .toBe('https://autonomous-drone-simulator.vercel.app/assets/maplibre-worker-0123456789ab/maplibre-gl-worker.mjs')
    expect(resolveMaplibreWorkerUrl(path, 'http://127.0.0.1:8787/sub/assets/index-abc.js'))
      .toBe('http://127.0.0.1:8787/sub/assets/maplibre-worker-0123456789ab/maplibre-gl-worker.mjs')
  })

  it('leaves MapLibre alone in dev/tests (no path) and on non-http pages', () => {
    expect(resolveMaplibreWorkerUrl('', 'https://example.test/assets/index.js')).toBeNull()
    expect(resolveMaplibreWorkerUrl(undefined, 'https://example.test/assets/index.js')).toBeNull()
    expect(resolveMaplibreWorkerUrl(path, 'file:///C:/app/assets/index.js')).toBeNull()
  })

  it('is the first import of the app entry, so no map can start before the URL is set', () => {
    const main = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8')
    const firstImport = main.split('\n').find((line) => line.startsWith('import '))
    expect(firstImport).toBe("import '@/components/maplibreWorker'")
  })

  it('the classroom LAN server serves .mjs as JavaScript (module workers refuse octet-stream)', () => {
    const server = readFileSync(resolve(__dirname, '../../server/classroom.mjs'), 'utf8')
    expect(server).toMatch(/'\.mjs':\s*'text\/javascript'/)
  })
})
