import { describe, it, expect } from 'vitest'
import { computeBbox, project, lerpDrones, stateColor } from '@/components/classroom/tileRenderer'
import { MISSION_STATE_CODES, type GridDrone } from '@/classroom/gridFrame'

// Pure math only — no canvas is instantiated here. The drawing functions are
// exercised in the browser; this suite pins the projection/interpolation logic.

const drone = (over: Partial<GridDrone>): GridDrone => ({
  id: 'a', lat: 0, lng: 0, headingDeg: 0, batteryPct: 100, stateCode: 0, ...over,
})

describe('computeBbox', () => {
  it('bounds a set of points and expands by the margin fraction', () => {
    const pts = [
      { lat: 10, lng: 20 },
      { lat: 14, lng: 30 },
    ]
    // spans: lat 4, lng 10; margin 0.1 → lat ±0.4, lng ±1
    const b = computeBbox(pts, 0.1)
    expect(b.minLat).toBeCloseTo(9.6, 6)
    expect(b.maxLat).toBeCloseTo(14.4, 6)
    expect(b.minLng).toBeCloseTo(19, 6)
    expect(b.maxLng).toBeCloseTo(31, 6)
  })

  it('gives a single point a non-zero span (no NaN, no zero-division)', () => {
    const b = computeBbox([{ lat: 37.77, lng: -122.42 }])
    expect(b.maxLat - b.minLat).toBeGreaterThan(0)
    expect(b.maxLng - b.minLng).toBeGreaterThan(0)
    expect(Number.isNaN(b.minLat)).toBe(false)
    expect(Number.isNaN(b.maxLng)).toBe(false)
    // The point stays centred in the fallback window.
    expect((b.minLat + b.maxLat) / 2).toBeCloseTo(37.77, 6)
    expect((b.minLng + b.maxLng) / 2).toBeCloseTo(-122.42, 6)
  })
})

describe('project', () => {
  const bbox = { minLat: 10, maxLat: 20, minLng: -100, maxLng: -80 }
  const W = 200
  const H = 400

  it('maps bbox corners to pixel corners (lat inverted)', () => {
    // top-left = (maxLat, minLng)
    const tl = project(20, -100, bbox, W, H)
    expect(tl.x).toBeCloseTo(0, 6)
    expect(tl.y).toBeCloseTo(0, 6)
    // bottom-right = (minLat, maxLng)
    const br = project(10, -80, bbox, W, H)
    expect(br.x).toBeCloseTo(W, 6)
    expect(br.y).toBeCloseTo(H, 6)
  })

  it('maps the center to (width/2, height/2)', () => {
    const c = project(15, -90, bbox, W, H)
    expect(c.x).toBeCloseTo(W / 2, 6)
    expect(c.y).toBeCloseTo(H / 2, 6)
  })

  it('does not clamp points outside the bbox', () => {
    const p = project(25, -70, bbox, W, H) // north of maxLat, east of maxLng
    expect(p.x).toBeGreaterThan(W)
    expect(p.y).toBeLessThan(0)
  })
})

describe('lerpDrones', () => {
  const prev = [drone({ id: 'a', lat: 0, lng: 0, headingDeg: 0, batteryPct: 100 })]
  const next = [drone({ id: 'a', lat: 10, lng: 20, headingDeg: 0, batteryPct: 80 })]

  it('alpha=0 returns prev positions', () => {
    const r = lerpDrones(prev, next, 0)
    expect(r[0].lat).toBeCloseTo(0, 6)
    expect(r[0].lng).toBeCloseTo(0, 6)
    expect(r[0].batteryPct).toBeCloseTo(100, 6)
  })

  it('alpha=1 returns next positions', () => {
    const r = lerpDrones(prev, next, 1)
    expect(r[0].lat).toBeCloseTo(10, 6)
    expect(r[0].lng).toBeCloseTo(20, 6)
    expect(r[0].batteryPct).toBeCloseTo(80, 6)
  })

  it('alpha=0.5 midpoints position and battery', () => {
    const r = lerpDrones(prev, next, 0.5)
    expect(r[0].lat).toBeCloseTo(5, 6)
    expect(r[0].lng).toBeCloseTo(10, 6)
    expect(r[0].batteryPct).toBeCloseTo(90, 6)
  })

  it('clamps alpha out of range', () => {
    expect(lerpDrones(prev, next, -1)[0].lat).toBeCloseTo(0, 6)
    expect(lerpDrones(prev, next, 2)[0].lat).toBeCloseTo(10, 6)
  })

  it('interpolates heading 350→10 through 0, not backwards through 180', () => {
    const p = [drone({ id: 'a', headingDeg: 350 })]
    const n = [drone({ id: 'a', headingDeg: 10 })]
    const mid = lerpDrones(p, n, 0.5)[0].headingDeg
    // Shortest path midpoint is 0/360, definitely nowhere near 180.
    const distToZero = Math.min(mid, 360 - mid)
    expect(distToZero).toBeLessThan(1)
    expect(Math.abs(mid - 180)).toBeGreaterThan(90)
  })

  it('passes through a drone present only in next', () => {
    const n = [...next, drone({ id: 'b', lat: 42, lng: 7, headingDeg: 123, batteryPct: 55 })]
    const r = lerpDrones(prev, n, 0.5)
    const b = r.find((d) => d.id === 'b')!
    expect(b.lat).toBe(42)
    expect(b.lng).toBe(7)
    expect(b.headingDeg).toBe(123)
    expect(b.batteryPct).toBe(55)
  })
})

describe('stateColor', () => {
  const code = (state: string) => MISSION_STATE_CODES.indexOf(state as never)

  it('emergency → red', () => {
    expect(stateColor(code('emergency'))).toBe('#ff4d4d')
    expect(stateColor(11)).toBe('#ff4d4d') // hardcoded index cross-check
  })

  it('navigate (active) → green', () => {
    expect(stateColor(code('navigate'))).toBe('#39d98a')
    expect(stateColor(3)).toBe('#39d98a')
  })

  it('landed → gray', () => {
    expect(stateColor(code('landed'))).toBe('#8a94a6')
    expect(stateColor(12)).toBe('#8a94a6')
  })

  it('idle → gray', () => {
    expect(stateColor(0)).toBe('#8a94a6')
  })
})
