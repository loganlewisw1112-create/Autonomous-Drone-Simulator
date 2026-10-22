/**
 * Points MapLibre at a content-versioned copy of its tile/style worker.
 *
 * MapLibre v6 loads `maplibre-gl-worker.mjs` (which imports `maplibre-gl-shared.mjs`) from a fixed
 * filename next to its own chunk. Production serves `/assets/*` as `immutable` for a year, so after a
 * MapLibre upgrade a returning browser kept the OLD worker while running the NEW main chunk. The two
 * do not share a wire format ("can't deserialize unregistered class ..."), no tile is ever drawn, and
 * the map shows only the style's near-white background. That is the "white screen on Mac" report of
 * October 2026: the Mac had first loaded the site on MapLibre 6.11, the site then moved to 6.12.
 *
 * The build (vite.config.ts, maplibreWorkerAssetPlugin) copies both files into
 * `assets/maplibre-worker-<content hash>/` and passes that path in as VITE_MAPLIBRE_WORKER_PATH, so any
 * change to the worker changes its URL. Imported first by main.tsx, before any map can be created.
 */
import * as maplibregl from 'maplibre-gl'

/**
 * Absolute worker URL for a build-provided relative path, resolved against this module's own URL
 * (every chunk lives in the same assets directory). Null in dev, in tests, and on non-http(s)
 * pages, where MapLibre's own default resolution is left alone.
 */
export function resolveMaplibreWorkerUrl(workerPath: string | undefined, moduleUrl: string): string | null {
  if (!workerPath || !/^https?:/.test(moduleUrl)) return null
  return new URL(workerPath, moduleUrl).href
}

const workerUrl = resolveMaplibreWorkerUrl(import.meta.env.VITE_MAPLIBRE_WORKER_PATH, import.meta.url)
if (workerUrl) maplibregl.setWorkerUrl(workerUrl)
