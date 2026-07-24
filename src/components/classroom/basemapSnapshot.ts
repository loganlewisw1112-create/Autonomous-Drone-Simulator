import maplibregl from 'maplibre-gl'
import type { Bbox } from '@/components/classroom/tileRenderer'

// Shared basemap bitmap for the classroom wall (COORDINATOR_BUILD_PLAN §16.2).
//
// THE PROBLEM. §16.2 rules out a MapLibre instance per tile: browsers cap live WebGL contexts at
// roughly 8-16, so a class of 40 would blow the budget and start evicting maps. That is why the
// wall is Canvas 2D. But a wall with no basemap is mission geometry floating on a black field,
// and an instructor cannot tell whether a drone is over a park or a freeway.
//
// THE INSIGHT. Every student in a class flies the SAME scenario over the SAME area of operations.
// So the basemap is not per-student data at all — it is one picture the whole class shares. It
// only ever needed to be rendered once.
//
// So: spin up exactly ONE MapLibre instance offscreen, let it draw the AO, copy the pixels into a
// plain bitmap, and destroy it. Every tile then blits that bitmap the same way it already blits
// the vector backdrop. Forty tiles, forty real basemaps, and zero live WebGL contexts once the
// capture is done — the context is transient, not per-tile.
//
// The capture also RETURNS THE BOUNDS MapLibre actually settled on, which is the detail that makes
// the drones land on the right streets: fitBounds snaps to its own zoom and padding, so the window
// it drew is not exactly the window it was asked for. Projecting against the requested bbox would
// leave every glyph slightly off. Callers must project against `bounds`, not their own input.

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

/** Give up and let the wall fall back to the plain dark backdrop. */
const CAPTURE_TIMEOUT_MS = 12_000

export interface BasemapSnapshot {
  /** The rendered basemap, ready to blit. */
  image: HTMLCanvasElement
  /** The window MapLibre actually drew — project against THIS, not the requested bbox. */
  bounds: Bbox
}

export interface CaptureOptions {
  bbox: Bbox
  width: number
  height: number
  /** Overridable so a test can point at a stub style. */
  style?: string
  timeoutMs?: number
}

/**
 * Render `bbox` to a bitmap using one transient MapLibre instance.
 *
 * Resolves `null` — never rejects — when there is no WebGL, the style cannot be reached, or the
 * render does not settle in time. A classroom on a locked-down laptop or a dead network still
 * gets its wall, just without streets under it.
 */
/**
 * Resolve once the document is actually visible.
 *
 * MapLibre's `idle` event fires after a completed render pass, and a hidden tab never completes
 * one — the browser stops compositing it. Starting the capture in a background tab therefore
 * hangs until the timeout and then gives up PERMANENTLY, leaving the whole class with no basemap
 * for a reason that has nothing to do with the network. An instructor who opens the console
 * before switching to their slides would hit exactly that.
 *
 * So the capture simply waits its turn.
 */
function whenVisible(): Promise<void> {
  if (typeof document === 'undefined' || !document.hidden) return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = () => {
      if (document.hidden) return
      document.removeEventListener('visibilitychange', onChange)
      resolve()
    }
    document.addEventListener('visibilitychange', onChange)
  })
}

export async function captureBasemap(options: CaptureOptions): Promise<BasemapSnapshot | null> {
  const { bbox, width, height } = options
  if (typeof document === 'undefined' || !(width > 0) || !(height > 0)) return null

  await whenVisible()

  return new Promise((resolve) => {
    // Offscreen but LAID OUT: MapLibre sizes itself from the container, and `display: none`
    // would give it a zero-size canvas and nothing to draw.
    const host = document.createElement('div')
    host.style.cssText = `position:absolute;left:-10000px;top:0;width:${width}px;height:${height}px;pointer-events:none`
    document.body.appendChild(host)

    let map: maplibregl.Map
    let settled = false

    const cleanup = () => {
      try { map?.remove() } catch { /* already gone */ }
      host.remove()
    }
    const finish = (result: BasemapSnapshot | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      cleanup()
      resolve(result)
    }

    const timer = window.setTimeout(() => {
      console.warn('[basemapSnapshot] basemap capture timed out — wall will use the plain backdrop')
      finish(null)
    }, options.timeoutMs ?? CAPTURE_TIMEOUT_MS)

    try {
      map = new maplibregl.Map({
        container: host,
        style: options.style ?? MAP_STYLE,
        // Without `preserveDrawingBuffer` the drawing buffer is cleared after compositing and the
        // copy comes back blank. It costs memory, which is exactly why it is set on this ONE
        // transient map and never on the live ones. (MapLibre 5 moved it under
        // `canvasContextAttributes`; it was a top-level option in 4.)
        canvasContextAttributes: { preserveDrawingBuffer: true },
        attributionControl: false,
        interactive: false,
        fadeDuration: 0,
      })
    } catch (err) {
      console.warn('[basemapSnapshot] WebGL unavailable — wall will use the plain backdrop:', err)
      finish(null)
      return
    }

    map.on('error', (event) => {
      // Only a style failure is fatal; a missing tile still leaves most of the picture.
      if (!map.isStyleLoaded()) {
        console.warn('[basemapSnapshot] basemap style failed:', event.error?.message ?? event.error)
        finish(null)
      }
    })

    map.on('load', () => {
      map.fitBounds(
        [[bbox.minLng, bbox.minLat], [bbox.maxLng, bbox.maxLat]],
        { padding: 0, duration: 0, animate: false },
      )
      // `idle` is the honest "everything that is going to be drawn has been drawn" signal —
      // waiting on `load` alone would capture a half-tiled map.
      map.once('idle', () => {
        try {
          // Guard against the tab being hidden between load and idle; the drawing buffer of a
          // non-compositing map is not worth capturing.
          if (document.hidden) return finish(null)
          const source = map.getCanvas()
          const out = document.createElement('canvas')
          out.width = source.width
          out.height = source.height
          const ctx = out.getContext('2d')
          if (!ctx) return finish(null)
          ctx.drawImage(source, 0, 0)

          const b = map.getBounds()
          finish({
            image: out,
            bounds: {
              minLat: b.getSouth(),
              maxLat: b.getNorth(),
              minLng: b.getWest(),
              maxLng: b.getEast(),
            },
          })
        } catch (err) {
          console.warn('[basemapSnapshot] could not read the rendered basemap:', err)
          finish(null)
        }
      })
    })
  })
}
