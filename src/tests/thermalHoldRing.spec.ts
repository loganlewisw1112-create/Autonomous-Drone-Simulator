import { describe, expect, it } from 'vitest'
import {
  THERMAL_HOLD_PULSE_SOURCE,
  THERMAL_HOLD_RING_LAYERS,
  THERMAL_HOLD_RING_COLOR,
  THERMAL_HOLD_OUTLINE_COLOR,
  THERMAL_HOLD_PULSE_PERIOD_MS,
  registerThermalHoldRingLayers,
  setThermalHoldRingMode,
  paintThermalHoldPulse,
  thermalHoldPulsePaint,
  type ThermalHoldRingHost,
} from '@/components/thermalHoldRing'

/**
 * c4: the thermal-hold attention ring has to be readable by a cold viewer on the greyscale IR map.
 * Verifier v-c4 found the first cut faint: a yellow that greys out, an opacity that fell to zero every cycle,
 * and a radius range the ~44 px phone drone marker covered. These numbers are the fix; the tests pin them.
 */

/** Relative luminance (0..255) the way CSS `filter: grayscale(1) brightness(b) contrast(c)` computes it. */
function irMapLuma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const grey = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  const bright = Math.min(1, grey * 0.62)
  const contrast = Math.max(0, Math.min(1, (bright - 0.5) * 1.35 + 0.5))
  return contrast * 255
}

/** Minimal in-memory stand-in for the MapLibre surface the ring touches. */
function fakeMap(): ThermalHoldRingHost & {
  sources: Set<string>
  layers: string[]
  layout: Map<string, string>
  paint: Map<string, Record<string, unknown>>
  addLayerCalls: number
} {
  const sources = new Set<string>()
  const layers: string[] = []
  const layout = new Map<string, string>()
  const paint = new Map<string, Record<string, unknown>>()
  const host = {
    sources,
    layers,
    layout,
    paint,
    addLayerCalls: 0,
    getSource: (id: string) => (sources.has(id) ? {} : undefined),
    addSource: (id: string) => { sources.add(id) },
    getLayer: (id: string) => (layers.includes(id) ? {} : undefined),
    addLayer: (spec: { id: string; layout?: { visibility?: string }; paint?: object }) => {
      host.addLayerCalls += 1
      layers.push(spec.id)
      layout.set(spec.id, spec.layout?.visibility ?? 'visible')
      paint.set(spec.id, { ...(spec.paint ?? {}) })
    },
    setLayoutProperty: (id: string, prop: string, value: string) => {
      if (prop === 'visibility') layout.set(id, value)
    },
    setPaintProperty: (id: string, prop: string, value: unknown) => {
      paint.set(id, { ...(paint.get(id) ?? {}), [prop]: value })
    },
  }
  return host
}

const byKind = (kind: string) => THERMAL_HOLD_RING_LAYERS.find((l) => l.kind === kind)!

describe('thermal-hold ring: animated pulse numbers', () => {
  it('grows from 24 px to 60 px with a 6 px stroke', () => {
    expect(thermalHoldPulsePaint(0)).toMatchObject({ radius: 24, strokeWidth: 6 })
    expect(thermalHoldPulsePaint(1)).toMatchObject({ radius: 60, strokeWidth: 6 })
    expect(thermalHoldPulsePaint(0.5).radius).toBeCloseTo(42, 6)
  })

  it('never fades below 0.45 stroke opacity and starts fully opaque', () => {
    expect(thermalHoldPulsePaint(0).strokeOpacity).toBe(1)
    expect(thermalHoldPulsePaint(1).strokeOpacity).toBeCloseTo(0.45, 6)
    for (let i = 0; i <= 200; i++) {
      expect(thermalHoldPulsePaint(i / 200).strokeOpacity).toBeGreaterThanOrEqual(0.45)
    }
  })

  it('clamps an out-of-range phase instead of extrapolating', () => {
    expect(thermalHoldPulsePaint(-0.5)).toEqual(thermalHoldPulsePaint(0))
    expect(thermalHoldPulsePaint(2)).toEqual(thermalHoldPulsePaint(1))
  })

  it('keeps the 1600 ms period', () => {
    expect(THERMAL_HOLD_PULSE_PERIOD_MS).toBe(1600)
  })

  it('stays clear of the ~44 px phone drone marker (radius 22) for the whole cycle', () => {
    // MapLibre draws a circle stroke outside circle-radius, so the ring covers radius..radius+6 and its
    // dark outline covers radius-2..radius+8: the outline's inner edge is the closest thing to the marker.
    const MARKER_RADIUS = 22
    for (let i = 0; i <= 100; i++) {
      const p = thermalHoldPulsePaint(i / 100)
      expect(p.radius - 2).toBeGreaterThanOrEqual(MARKER_RADIUS)
    }
  })
})

describe('thermal-hold ring: static inner ring and outlines', () => {
  it('has a static inner ring: radius 26, stroke 3, opacity 0.9', () => {
    const inner = byKind('inner')
    expect(inner.paint['circle-radius']).toBe(26)
    expect(inner.paint['circle-stroke-width']).toBe(3)
    expect(inner.paint['circle-stroke-opacity']).toBe(0.9)
    // strokes grow outward from circle-radius, so even the outline (26 - 2) is outside the phone marker (radius 22)
    expect(26 - 2).toBeGreaterThan(22)
  })

  it('puts a dark outline under each ring, 2 px wider on each side', () => {
    const pairs: Array<[string, string]> = [['pulse-outline', 'pulse'], ['inner-outline', 'inner']]
    for (const [outlineKind, ringKind] of pairs) {
      const o = byKind(outlineKind)
      const r = byKind(ringKind)
      expect(o.paint['circle-stroke-color']).toBe(THERMAL_HOLD_OUTLINE_COLOR)
      expect(r.paint['circle-stroke-color']).toBe(THERMAL_HOLD_RING_COLOR)
      expect(Number(o.paint['circle-stroke-width'])).toBe(Number(r.paint['circle-stroke-width']) + 4)
      // stroke grows outward from the radius, so a 2 px-per-side outline starts 2 px inside the ring's radius
      expect(Number(o.paint['circle-radius'])).toBe(Number(r.paint['circle-radius']) - 2)
      expect(THERMAL_HOLD_RING_LAYERS.indexOf(o)).toBeLessThan(THERMAL_HOLD_RING_LAYERS.indexOf(r))
    }
    expect(THERMAL_HOLD_RING_LAYERS.map((l) => l.kind).slice(0, 2)).toEqual(['pulse-outline', 'inner-outline'])
  })

  it('is high-contrast against its outline once the IR filter has greyed the map', () => {
    const ring = irMapLuma(THERMAL_HOLD_RING_COLOR)
    const outline = irMapLuma(THERMAL_HOLD_OUTLINE_COLOR)
    expect(ring - outline).toBeGreaterThanOrEqual(120)
    // and it is not the old amber, which greys out to a mid tone
    expect(irMapLuma('#ffd24a')).toBeLessThan(ring)
  })
})

describe('thermal-hold ring: layer registration', () => {
  it('registers the source and all four layers, hidden, exactly once even if called twice', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    registerThermalHoldRingLayers(m)
    expect([...m.sources]).toEqual([THERMAL_HOLD_PULSE_SOURCE])
    expect(m.layers).toEqual(THERMAL_HOLD_RING_LAYERS.map((l) => l.id))
    expect(new Set(m.layers).size).toBe(4)
    expect(m.addLayerCalls).toBe(4)
    for (const id of m.layers) expect(m.layout.get(id)).toBe('none')
  })

  it('keeps the ring layer id that the live checks and TacticalMap look up', () => {
    expect(byKind('pulse').id).toBe('thermal-hold-pulse-ring')
    expect(THERMAL_HOLD_PULSE_SOURCE).toBe('thermal-hold-pulse')
  })

  it('fills in a missing layer when the source already exists', () => {
    const m = fakeMap()
    m.sources.add(THERMAL_HOLD_PULSE_SOURCE)
    registerThermalHoldRingLayers(m)
    expect(m.layers).toEqual(THERMAL_HOLD_RING_LAYERS.map((l) => l.id))
  })
})

describe('thermal-hold ring: modes', () => {
  it('hidden hides every layer', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    setThermalHoldRingMode(m, 'pulse')
    setThermalHoldRingMode(m, 'hidden')
    for (const l of THERMAL_HOLD_RING_LAYERS) expect(m.layout.get(l.id)).toBe('none')
  })

  it('pulse shows all four layers', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    setThermalHoldRingMode(m, 'pulse')
    for (const l of THERMAL_HOLD_RING_LAYERS) expect(m.layout.get(l.id)).toBe('visible')
  })

  it('reduced motion: one static ring, radius 30, stroke 6, opacity 0.9, over its outline; the inner pair is hidden', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    setThermalHoldRingMode(m, 'pulse')
    setThermalHoldRingMode(m, 'static')
    const ring = m.paint.get(byKind('pulse').id)!
    expect(ring['circle-radius']).toBe(30)
    expect(ring['circle-stroke-width']).toBe(6)
    expect(ring['circle-stroke-opacity']).toBe(0.9)
    const outline = m.paint.get(byKind('pulse-outline').id)!
    expect(outline['circle-radius']).toBe(28)
    expect(outline['circle-stroke-width']).toBe(10)
    expect(m.layout.get(byKind('pulse').id)).toBe('visible')
    expect(m.layout.get(byKind('pulse-outline').id)).toBe('visible')
    expect(m.layout.get(byKind('inner').id)).toBe('none')
    expect(m.layout.get(byKind('inner-outline').id)).toBe('none')
    // outline 28..38 and ring 30..36: clear of the phone marker (radius 22)
    expect(30 - 2).toBeGreaterThan(22)
  })

  it('switching static -> pulse restores the inner ring', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    setThermalHoldRingMode(m, 'static')
    setThermalHoldRingMode(m, 'pulse')
    expect(m.layout.get(byKind('inner').id)).toBe('visible')
  })

  it('paintThermalHoldPulse drives the ring and its outline together, and leaves the inner ring alone', () => {
    const m = fakeMap()
    registerThermalHoldRingLayers(m)
    setThermalHoldRingMode(m, 'pulse')
    paintThermalHoldPulse(m, 0.5)
    const ring = m.paint.get(byKind('pulse').id)!
    const outline = m.paint.get(byKind('pulse-outline').id)!
    expect(ring['circle-radius']).toBeCloseTo(42, 6)
    expect(ring['circle-stroke-width']).toBe(6)
    expect(outline['circle-radius']).toBeCloseTo(40, 6)
    expect(outline['circle-stroke-width']).toBe(10)
    expect(outline['circle-stroke-opacity']).toBe(ring['circle-stroke-opacity'])
    const inner = m.paint.get(byKind('inner').id)!
    expect(inner['circle-radius']).toBe(26)
    expect(inner['circle-stroke-opacity']).toBe(0.9)
  })
})
