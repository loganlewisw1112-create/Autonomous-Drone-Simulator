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

// Linear projection. lng grows left→right; lat is INVERTED so maxLat sits at the
// top (y=0), matching screen coordinates. Intentionally NOT clamped — an off-map
// point projects outside [0,width]×[0,height] so callers can cull it.
export function project(lat: number, lng: number, bbox: Bbox, width: number, height: number): { x: number; y: number } {
  const x = ((lng - bbox.minLng) / (bbox.maxLng - bbox.minLng)) * width
  const y = ((bbox.maxLat - lat) / (bbox.maxLat - bbox.minLat)) * height
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
export function drawBackdrop(ctx: CanvasRenderingContext2D, geo: BackdropGeometry, bbox: Bbox, width: number, height: number): void {
  ctx.fillStyle = '#0b0f17'
  ctx.fillRect(0, 0, width, height)

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

// Per-tile, per-frame hot path (40 tiles × animation frames) — keep it cheap:
// blit the shared backdrop bitmap, then stamp each drone glyph. No allocations.
export function renderTile(ctx: CanvasRenderingContext2D, backdrop: CanvasImageSource | null, drones: GridDrone[], bbox: Bbox, width: number, height: number): void {
  if (backdrop) {
    ctx.drawImage(backdrop, 0, 0, width, height)
  } else {
    ctx.fillStyle = '#0b0f17'
    ctx.fillRect(0, 0, width, height)
  }
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
