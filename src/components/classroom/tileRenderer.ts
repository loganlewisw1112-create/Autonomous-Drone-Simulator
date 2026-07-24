import type { LatLng } from '@/types'
import { codeToState, type GridDrone } from '@/classroom/gridFrame'

// Canvas-2D tile renderer for the classroom "screen wall" (up to ~40 student sims).
// A per-tile MapLibre/WebGL context is impossible here: browsers cap live WebGL
// contexts at ~8-16, so 40 tiles would blow the budget and start evicting maps.
// Instead every tile is plain Canvas 2D drawn over a shared static backdrop bitmap.
// Over a ~5 km classroom AO a LINEAR lat/lng→pixel map is sub-pixel accurate, so
// Web Mercator's transcendental math is pure overhead we skip.

export interface Bbox {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

// A zero span would make project() divide by zero, so a single point (or any
// axis with no spread) falls back to this half-degree window (~550 m) around it.
const DEFAULT_SPAN = 0.005

export function computeBbox(points: LatLng[], marginFrac = 0.12): Bbox {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  // Empty input leaves the extents non-finite; anchor at 0,0 so we still return
  // a usable (if arbitrary) window rather than NaN.
  if (!Number.isFinite(minLat)) {
    minLat = maxLat = 0
    minLng = maxLng = 0
  }
  // Guard degenerate spans BEFORE applying the margin so a single point still
  // resolves to DEFAULT_SPAN rather than collapsing projection.
  let latSpan = maxLat - minLat
  let lngSpan = maxLng - minLng
  if (latSpan < 1e-9) {
    const mid = (minLat + maxLat) / 2
    minLat = mid - DEFAULT_SPAN / 2
    maxLat = mid + DEFAULT_SPAN / 2
    latSpan = DEFAULT_SPAN
  }
  if (lngSpan < 1e-9) {
    const mid = (minLng + maxLng) / 2
    minLng = mid - DEFAULT_SPAN / 2
    maxLng = mid + DEFAULT_SPAN / 2
    lngSpan = DEFAULT_SPAN
  }
  const latMargin = latSpan * marginFrac
  const lngMargin = lngSpan * marginFrac
  return {
    minLat: minLat - latMargin,
    maxLat: maxLat + latMargin,
    minLng: minLng - lngMargin,
    maxLng: maxLng + lngMargin,
  }
}

/**
 * Web Mercator Y, in the same radian-ish units as longitude. `y = ln(tan(π/4 + φ/2))`.
 *
 * The tiles used to project latitude LINEARLY, which was wrong twice over: it ignored that a
 * degree of longitude is only `cos(lat)` as wide as a degree of latitude (~27% off at Bay Area
 * latitudes), and it did not match what a real basemap draws. Now that the wall composites an
 * actual MapLibre-rendered basemap underneath the mission geometry, "close enough" is no longer
 * good enough — the drone glyphs have to land on the right streets, so the tiles project in
 * exactly the projection the basemap was rendered in.
 */
export function mercatorY(latDeg: number): number {
  const clamped = Math.max(-85.051129, Math.min(85.051129, latDeg))
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360))
}

/** Longitude in the same units as `mercatorY`. */
export function mercatorX(lngDeg: number): number {
  return (lngDeg * Math.PI) / 180
}

/** Inverse of `mercatorY` — needed to turn a fitted Mercator window back into latitudes. */
export function inverseMercatorY(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI
}

/**
 * Expand a bbox so it fills a canvas of `width`×`height` WITHOUT distorting geography.
 *
 * In Mercator, x and y are already in the same units and a square on the ground is a square on
 * screen, so this is a straight aspect comparison — no `cos(lat)` correction needed, because the
 * projection has already done it. Only ever grows the window, never crops, so every point that
 * was visible stays visible.
 */
export function fitBboxToAspect(bbox: Bbox, width: number, height: number): Bbox {
  if (!(width > 0) || !(height > 0)) return bbox

  const latSpan = bbox.maxLat - bbox.minLat
  const lngSpan = bbox.maxLng - bbox.minLng
  if (!(latSpan > 0) || !(lngSpan > 0)) return bbox

  const yMin = mercatorY(bbox.minLat)
  const yMax = mercatorY(bbox.maxLat)
  const xMin = mercatorX(bbox.minLng)
  const xMax = mercatorX(bbox.maxLng)

  const ySpan = yMax - yMin
  const xSpan = xMax - xMin
  if (!(ySpan > 0) || !(xSpan > 0)) return bbox

  const targetAspect = width / height
  let nextXSpan = xSpan
  let nextYSpan = ySpan
  if (xSpan / ySpan > targetAspect) {
    nextYSpan = xSpan / targetAspect   // too wide — add vertical headroom
  } else {
    nextXSpan = ySpan * targetAspect   // too tall — add horizontal headroom
  }

  const midY = (yMin + yMax) / 2
  const midX = (xMin + xMax) / 2
  return {
    minLat: inverseMercatorY(midY - nextYSpan / 2),
    maxLat: inverseMercatorY(midY + nextYSpan / 2),
    minLng: ((midX - nextXSpan / 2) * 180) / Math.PI,
    maxLng: ((midX + nextXSpan / 2) * 180) / Math.PI,
  }
}

// Web Mercator projection, matching the basemap the tiles composite over. lng grows left→right;
// lat is INVERTED so maxLat sits at the top (y=0), matching screen coordinates. Intentionally NOT
// clamped — an off-map point projects outside [0,width]×[0,height] so callers can cull it.
export function project(lat: number, lng: number, bbox: Bbox, width: number, height: number): { x: number; y: number } {
  const yTop = mercatorY(bbox.maxLat)
  const ySpan = yTop - mercatorY(bbox.minLat)
  const x = ((lng - bbox.minLng) / (bbox.maxLng - bbox.minLng)) * width
  const y = ySpan === 0 ? 0 : ((yTop - mercatorY(lat)) / ySpan) * height
  return { x, y }
}

export interface BackdropGeometry {
  geofences?: LatLng[][]
  searchAreas?: LatLng[][]
  routes?: LatLng[][]
  sites?: LatLng[]
}

function strokePolyline(ctx: CanvasRenderingContext2D, poly: LatLng[], bbox: Bbox, width: number, height: number, close: boolean): void {
  if (poly.length === 0) return
  ctx.beginPath()
  for (let i = 0; i < poly.length; i++) {
    const { x, y } = project(poly[i].lat, poly[i].lng, bbox, width, height)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  if (close) ctx.closePath()
  ctx.stroke()
}

// Drawn ONCE per class into an offscreen canvas; every tile then blits the
// resulting bitmap in renderTile(), so this cost is amortised across all tiles.
/**
 * Nice round ground distance for a scale bar roughly `targetPx` wide — 1/2/5 × 10^n metres, the
 * standard progression, so the bar always reads as a number a person can reason with.
 */
export function scaleBarMetres(metresPerPixel: number, targetPx: number): number {
  const raw = Math.max(1, metresPerPixel * targetPx)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / pow
  const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1
  return step * pow
}

/** Ground metres per horizontal pixel for a fitted bbox. */
export function metresPerPixel(bbox: Bbox, width: number): number {
  const midLat = (bbox.minLat + bbox.maxLat) / 2
  const spanM = (bbox.maxLng - bbox.minLng) * 111_320 * Math.cos((midLat * Math.PI) / 180)
  return width > 0 ? spanM / width : 0
}

/**
 * Reference graticule, scale bar and north arrow.
 *
 * Without these the tile is mission geometry floating in an empty void, which is most of why the
 * wall read as "zoomed in and wrong": there was nothing to judge distance or orientation against.
 * The wall cannot show streets — §16.2 rules out ~40 live WebGL basemaps — so it earns legibility
 * the way a tactical plot does instead, with a measured grid rather than a picture.
 */
function drawReferenceFrame(ctx: CanvasRenderingContext2D, bbox: Bbox, width: number, height: number): void {
  const mpp = metresPerPixel(bbox, width)
  if (!(mpp > 0)) return

  // Graticule at the same round interval as the scale bar, so the grid IS the scale.
  const gridM = scaleBarMetres(mpp, Math.max(48, width / 6))
  const gridPx = gridM / mpp
  if (gridPx >= 12) {
    ctx.strokeStyle = 'rgba(138, 148, 166, 0.10)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = gridPx; x < width; x += gridPx) {
      ctx.moveTo(Math.round(x) + 0.5, 0)
      ctx.lineTo(Math.round(x) + 0.5, height)
    }
    for (let y = gridPx; y < height; y += gridPx) {
      ctx.moveTo(0, Math.round(y) + 0.5)
      ctx.lineTo(width, Math.round(y) + 0.5)
    }
    ctx.stroke()
  }

  const pad = Math.max(6, Math.round(width * 0.025))
  const barPx = gridPx
  const label = gridM >= 1000 ? `${(gridM / 1000).toFixed(gridM % 1000 === 0 ? 0 : 1)} km` : `${gridM} m`
  const fontPx = Math.max(9, Math.min(13, Math.round(width / 34)))

  // Scale bar, bottom-left.
  const y = height - pad
  ctx.strokeStyle = 'rgba(214, 224, 238, 0.75)'
  ctx.lineWidth = Math.max(1, Math.round(width / 320))
  ctx.beginPath()
  ctx.moveTo(pad, y)
  ctx.lineTo(pad + barPx, y)
  ctx.moveTo(pad, y - 4)
  ctx.lineTo(pad, y)
  ctx.moveTo(pad + barPx, y - 4)
  ctx.lineTo(pad + barPx, y)
  ctx.stroke()

  ctx.fillStyle = 'rgba(214, 224, 238, 0.75)'
  ctx.font = `${fontPx}px var(--font-mono, monospace)`
  ctx.textBaseline = 'bottom'
  ctx.fillText(label, pad, y - 5)

  // North arrow, top-right. Orientation is fixed (the projection is north-up), but saying so
  // removes the question rather than leaving the instructor to assume it.
  const nx = width - pad
  const ny = pad + fontPx
  ctx.beginPath()
  ctx.moveTo(nx, ny - fontPx)
  ctx.lineTo(nx - fontPx * 0.32, ny)
  ctx.lineTo(nx + fontPx * 0.32, ny)
  ctx.closePath()
  ctx.fill()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText('N', nx, ny + 2)
  ctx.textAlign = 'start'
  ctx.textBaseline = 'alphabetic'
}

export interface DrawBackdropOptions {
  /**
   * Paint the dark field first. False when a basemap has already been composited underneath —
   * filling over it would erase the very thing the wall is now able to show.
   */
  fillBackground?: boolean
}

export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  geo: BackdropGeometry,
  bbox: Bbox,
  width: number,
  height: number,
  options: DrawBackdropOptions = {},
): void {
  if (options.fillBackground !== false) {
    ctx.fillStyle = '#0b0f17'
    ctx.fillRect(0, 0, width, height)
  }

  ctx.lineWidth = 1
  // Geofences — thin red outlines.
  ctx.strokeStyle = 'rgba(255, 77, 77, 0.7)'
  for (const poly of geo.geofences ?? []) strokePolyline(ctx, poly, bbox, width, height, true)

  // Search areas — thin cyan outlines.
  ctx.strokeStyle = 'rgba(64, 220, 255, 0.7)'
  for (const poly of geo.searchAreas ?? []) strokePolyline(ctx, poly, bbox, width, height, true)

  // Routes — faint gray polylines (open, not closed).
  ctx.strokeStyle = 'rgba(138, 148, 166, 0.4)'
  for (const poly of geo.routes ?? []) strokePolyline(ctx, poly, bbox, width, height, false)

  // Sites — small squares.
  ctx.fillStyle = 'rgba(138, 148, 166, 0.9)'
  for (const site of geo.sites ?? []) {
    const { x, y } = project(site.lat, site.lng, bbox, width, height)
    ctx.fillRect(x - 3, y - 3, 6, 6)
  }
}

// State→glyph colour. Buckets mirror the wall's semantics: red = something is
// wrong (emergency / stranded / recovery in progress), amber = coming home
// (RTB / recharge), gray = on the ground or done, green = actively flying.
const RED_STATES = new Set(['emergency', 'stranded', 'recovery_requested', 'recovery_enroute'])
const AMBER_STATES = new Set(['return_to_base', 'recharge'])
// remote_landed is a landed variant (set down away from base) — grouped with the
// other terminal/idle states rather than the active-flight default.
const GRAY_STATES = new Set(['landed', 'recovered', 'idle', 'unrecoverable_sim', 'remote_landed'])

export function stateColor(stateCode: number): string {
  const s = codeToState(stateCode)
  if (RED_STATES.has(s)) return '#ff4d4d'
  if (AMBER_STATES.has(s)) return '#ffb020'
  if (GRAY_STATES.has(s)) return '#8a94a6'
  return '#39d98a' // navigate / sar_grid / hover / inspect / launch / etc.
}

const GLYPH_RADIUS = 5

export function drawDroneGlyph(ctx: CanvasRenderingContext2D, d: GridDrone, bbox: Bbox, width: number, height: number): void {
  const { x, y } = project(d.lat, d.lng, bbox, width, height)
  const color = stateColor(d.stateCode)

  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, GLYPH_RADIUS, 0, Math.PI * 2)
  ctx.fill()

  // Heading triangle. Canvas rotates clockwise (y-down), which matches compass
  // convention: 0°=up/north, 90°=right/east. Tip drawn at (0,-r) before rotation.
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((d.headingDeg * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, -(GLYPH_RADIUS + 4))
  ctx.lineTo(-3, -(GLYPH_RADIUS - 1))
  ctx.lineTo(3, -(GLYPH_RADIUS - 1))
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

/**
 * Match a canvas's backing store to the size it is actually DISPLAYED at, times the device
 * pixel ratio, and scale the context so drawing code keeps working in CSS pixels.
 *
 * This is the fix for the blurry wall. The tiles drew into a fixed 240×160 bitmap and the CSS
 * then stretched it with `width: 100%` to fill a grid column that is routinely 300–400 px wide —
 * and on a HiDPI screen the browser upscales again on top of that. The result was a soft, smeared
 * map. Nothing was wrong with the drawing; it was being resampled twice.
 *
 * Returns the CSS-pixel size to draw at, or null when the element has no layout yet.
 */
export function syncCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  aspect: number,
): { width: number; height: number } | null {
  const cssWidth = canvas.clientWidth
  if (!(cssWidth > 0)) return null
  const cssHeight = Math.max(1, Math.round(cssWidth / aspect))

  // Cap DPR: beyond 2 the extra pixels are invisible but the per-frame fill cost is real, and
  // this is a hot path running on up to ~40 tiles at once.
  const dpr = Math.min(2, Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  const backingWidth = Math.round(cssWidth * dpr)
  const backingHeight = Math.round(cssHeight * dpr)

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth
    canvas.height = backingHeight
  }
  canvas.style.height = `${cssHeight}px`

  const ctx = canvas.getContext('2d')
  // setTransform (not scale) so repeated frames never compound the ratio.
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { width: cssWidth, height: cssHeight }
}

// Per-tile, per-frame hot path (40 tiles × animation frames) — keep it cheap:
// blit the shared backdrop bitmap, then stamp each drone glyph. No allocations.
export function renderTile(ctx: CanvasRenderingContext2D, backdrop: CanvasImageSource | null, drones: GridDrone[], bbox: Bbox, width: number, height: number): void {
  if (backdrop) {
    ctx.drawImage(backdrop, 0, 0, width, height)
  } else {
    ctx.fillStyle = '#0b0f17'
    ctx.fillRect(0, 0, width, height)
  }
  // Drawn per tile rather than baked into the shared backdrop: the backdrop is blitted at whatever
  // size the tile happens to be, which would scale the label text and hairlines along with it and
  // leave them either soft or the wrong weight. Cheap enough — a couple of dozen line segments and
  // two short strings, against a Canvas2D budget that already absorbs the whole wall.
  drawReferenceFrame(ctx, bbox, width, height)
  for (const d of drones) drawDroneGlyph(ctx, d, bbox, width, height)
}

// Wire frames land at 1 Hz but tiles animate faster, so we tween between the last
// two frames. Match by id; a drone only in `next` (just spawned) passes through.
export function lerpDrones(prev: GridDrone[], next: GridDrone[], alpha: number): GridDrone[] {
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha
  const prevById = new Map(prev.map((d) => [d.id, d]))
  return next.map((n) => {
    const p = prevById.get(n.id)
    if (!p) return n
    // Shortest angular path so 350°→10° sweeps through 0, not backwards through 180.
    const dHeading = ((n.headingDeg - p.headingDeg + 540) % 360) - 180
    const heading = (((p.headingDeg + dHeading * a) % 360) + 360) % 360
    return {
      ...n,
      lat: p.lat + (n.lat - p.lat) * a,
      lng: p.lng + (n.lng - p.lng) * a,
      headingDeg: heading,
      batteryPct: p.batteryPct + (n.batteryPct - p.batteryPct) * a,
    }
  })
}
