/**
 * c4: the attention ring drawn on the contact a held drone is waiting on.
 *
 * It lives on the IR map, which the app greys with `grayscale(1) brightness(.62) contrast(1.35)`, so the
 * colour has to survive greyscale: a near-white ring over a dark outline reads as light-on-black wherever
 * it lands. The ring never fades out (opacity floor 0.45) and its radius range sits outside the ~44 px
 * drone marker the phone layout draws on the contact, so something is always visible around the marker.
 * A second, static ring keeps one visible outline up even at the instant the pulse is smallest.
 *
 * MapLibre draws a circle's stroke OUTSIDE circle-radius, so a ring at radius R covers R..R+width. Its dark
 * outline is drawn 2 px wider on each side: radius R-2, width+4, which covers R-2..R+width+2.
 *
 * Four circle layers share one GeoJSON source and draw back to front:
 *   pulse-outline, inner-outline (dark), pulse, inner (near-white).
 */

export const THERMAL_HOLD_PULSE_SOURCE = 'thermal-hold-pulse'
export const THERMAL_HOLD_PULSE_PERIOD_MS = 1600

export const THERMAL_HOLD_RING_COLOR = '#fff3c4'
export const THERMAL_HOLD_OUTLINE_COLOR = '#05080c'

/** The dark outline is this many px wider than its ring in total (2 px on each side). */
const OUTLINE_EXTRA_WIDTH = 4
/** ...so its circle-radius sits this far inside the ring's radius (strokes grow outward from the radius). */
const OUTLINE_RADIUS_INSET = OUTLINE_EXTRA_WIDTH / 2

const PULSE_RADIUS_MIN = 24
const PULSE_RADIUS_MAX = 60
const PULSE_STROKE_WIDTH = 6
const PULSE_OPACITY_MAX = 1
const PULSE_OPACITY_MIN = 0.45

const INNER_RADIUS = 26
const INNER_STROKE_WIDTH = 3
const INNER_OPACITY = 0.9

const STATIC_RADIUS = 30
const STATIC_STROKE_WIDTH = 6
const STATIC_OPACITY = 0.9

export type ThermalHoldRingKind = 'pulse-outline' | 'inner-outline' | 'pulse' | 'inner'
export type ThermalHoldRingMode = 'hidden' | 'pulse' | 'static'

export interface ThermalHoldCirclePaint {
  'circle-radius': number
  'circle-color': string
  'circle-stroke-width': number
  'circle-stroke-color': string
  'circle-stroke-opacity': number
}

export interface ThermalHoldRingLayer {
  id: string
  kind: ThermalHoldRingKind
  paint: ThermalHoldCirclePaint
}

const circlePaint = (radius: number, width: number, color: string, opacity: number): ThermalHoldCirclePaint => ({
  'circle-radius': radius,
  'circle-color': 'rgba(0,0,0,0)',
  'circle-stroke-width': width,
  'circle-stroke-color': color,
  'circle-stroke-opacity': opacity,
})

/** Back to front. `thermal-hold-pulse-ring` keeps its original id: the live checks look the ring up by it. */
export const THERMAL_HOLD_RING_LAYERS: readonly ThermalHoldRingLayer[] = [
  { id: 'thermal-hold-pulse-outline', kind: 'pulse-outline', paint: circlePaint(PULSE_RADIUS_MIN - OUTLINE_RADIUS_INSET, PULSE_STROKE_WIDTH + OUTLINE_EXTRA_WIDTH, THERMAL_HOLD_OUTLINE_COLOR, PULSE_OPACITY_MAX) },
  { id: 'thermal-hold-inner-outline', kind: 'inner-outline', paint: circlePaint(INNER_RADIUS - OUTLINE_RADIUS_INSET, INNER_STROKE_WIDTH + OUTLINE_EXTRA_WIDTH, THERMAL_HOLD_OUTLINE_COLOR, INNER_OPACITY) },
  { id: 'thermal-hold-pulse-ring', kind: 'pulse', paint: circlePaint(PULSE_RADIUS_MIN, PULSE_STROKE_WIDTH, THERMAL_HOLD_RING_COLOR, PULSE_OPACITY_MAX) },
  { id: 'thermal-hold-inner-ring', kind: 'inner', paint: circlePaint(INNER_RADIUS, INNER_STROKE_WIDTH, THERMAL_HOLD_RING_COLOR, INNER_OPACITY) },
]

const layerOf = (kind: ThermalHoldRingKind): ThermalHoldRingLayer => THERMAL_HOLD_RING_LAYERS.find((l) => l.kind === kind)!

export interface ThermalHoldPulsePaint {
  radius: number
  strokeWidth: number
  strokeOpacity: number
}

/** Animated ring at `phase` (0..1 through one period): radius 24 -> 60 px, stroke 6 px, opacity 1 -> 0.45. */
export function thermalHoldPulsePaint(phase: number): ThermalHoldPulsePaint {
  const p = Math.min(1, Math.max(0, phase))
  return {
    radius: PULSE_RADIUS_MIN + p * (PULSE_RADIUS_MAX - PULSE_RADIUS_MIN),
    strokeWidth: PULSE_STROKE_WIDTH,
    // max() so float rounding at phase 1 can never dip under the floor
    strokeOpacity: Math.max(PULSE_OPACITY_MIN, PULSE_OPACITY_MAX - p * (PULSE_OPACITY_MAX - PULSE_OPACITY_MIN)),
  }
}

/** The slice of the MapLibre map this ring touches (`maplibregl.Map` satisfies it). */
export interface ThermalHoldRingHost {
  getSource(id: string): unknown
  addSource(id: string, spec: { type: 'geojson'; data: { type: 'FeatureCollection'; features: [] } }): unknown
  getLayer(id: string): unknown
  addLayer(spec: {
    id: string
    type: 'circle'
    source: string
    layout: { visibility: 'none' }
    paint: ThermalHoldCirclePaint
  }): unknown
  setLayoutProperty(id: string, name: 'visibility', value: 'visible' | 'none'): unknown
  setPaintProperty(id: string, name: string, value: unknown): unknown
}

/** Idempotent: safe to call on every style (re)load. Layers start hidden. */
export function registerThermalHoldRingLayers(map: ThermalHoldRingHost): void {
  if (!map.getSource(THERMAL_HOLD_PULSE_SOURCE)) {
    map.addSource(THERMAL_HOLD_PULSE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
  }
  for (const layer of THERMAL_HOLD_RING_LAYERS) {
    if (map.getLayer(layer.id)) continue
    map.addLayer({ id: layer.id, type: 'circle', source: THERMAL_HOLD_PULSE_SOURCE, layout: { visibility: 'none' }, paint: { ...layer.paint } })
  }
}

function setVisible(map: ThermalHoldRingHost, kinds: readonly ThermalHoldRingKind[]): void {
  for (const layer of THERMAL_HOLD_RING_LAYERS) {
    map.setLayoutProperty(layer.id, 'visibility', kinds.includes(layer.kind) ? 'visible' : 'none')
  }
}

function paintCircle(map: ThermalHoldRingHost, id: string, radius: number, width: number, opacity: number): void {
  map.setPaintProperty(id, 'circle-radius', radius)
  map.setPaintProperty(id, 'circle-stroke-width', width)
  map.setPaintProperty(id, 'circle-stroke-opacity', opacity)
}

/** One animation frame: ring and its outline move together; the inner ring stays put. */
export function paintThermalHoldPulse(map: ThermalHoldRingHost, phase: number): void {
  const p = thermalHoldPulsePaint(phase)
  paintCircle(map, layerOf('pulse').id, p.radius, p.strokeWidth, p.strokeOpacity)
  paintCircle(map, layerOf('pulse-outline').id, p.radius - OUTLINE_RADIUS_INSET, p.strokeWidth + OUTLINE_EXTRA_WIDTH, p.strokeOpacity)
}

/**
 * hidden: nothing drawn. pulse: all four layers (the animation loop drives the pulse pair).
 * static (prefers-reduced-motion): one fixed ring, radius 30 / stroke 6 / opacity 0.9, over its outline; the inner ring is hidden
 * so two rings do not sit edge to edge.
 */
export function setThermalHoldRingMode(map: ThermalHoldRingHost, mode: ThermalHoldRingMode): void {
  if (mode === 'hidden') {
    setVisible(map, [])
  } else if (mode === 'pulse') {
    setVisible(map, ['pulse-outline', 'inner-outline', 'pulse', 'inner'])
  } else {
    paintCircle(map, layerOf('pulse').id, STATIC_RADIUS, STATIC_STROKE_WIDTH, STATIC_OPACITY)
    paintCircle(map, layerOf('pulse-outline').id, STATIC_RADIUS - OUTLINE_RADIUS_INSET, STATIC_STROKE_WIDTH + OUTLINE_EXTRA_WIDTH, STATIC_OPACITY)
    setVisible(map, ['pulse-outline', 'pulse'])
  }
}
