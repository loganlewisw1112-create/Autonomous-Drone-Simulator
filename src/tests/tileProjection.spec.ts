import { describe, expect, it } from 'vitest'
import {
  computeBbox, fitBboxToAspect, metresPerPixel, project, scaleBarMetres,
} from '@/components/classroom/tileRenderer'

/**
 * Coordinator wall projection.
 *
 * Symptom: student tiles looked "blurry and too zoomed in". Two independent causes, and this
 * file covers the geometric one — the tiles stretched each axis independently to fill the canvas,
 * ignoring both the canvas aspect ratio and the fact that a degree of longitude is only cos(lat)
 * as wide as a degree of latitude. Drones landed in the right relative places, but nothing was
 * the right SHAPE. (The blur itself was a devicePixelRatio problem in the canvas sizing.)
 */

const BAY_AREA = { lat: 37.9, lng: -122.24 }

/** Ground distance in metres between two points, good enough at these scales. */
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): { x: number; y: number } {
  const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  return {
    x: (b.lng - a.lng) * 111_320 * Math.cos(midLat),
    y: (b.lat - a.lat) * 111_320,
  }
}

describe('tile bbox aspect fitting', () => {
  it('makes equal ground distances span equal pixel distances', () => {
    // The core property: uniform scale. Take a square-ish AO and check that a 500 m step east
    // covers the same pixels as a 500 m step north.
    const square = computeBbox([
      { lat: BAY_AREA.lat - 0.01, lng: BAY_AREA.lng - 0.01 },
      { lat: BAY_AREA.lat + 0.01, lng: BAY_AREA.lng + 0.01 },
    ])
    const W = 360
    const H = 240
    const fitted = fitBboxToAspect(square, W, H)

    const origin = project(BAY_AREA.lat, BAY_AREA.lng, fitted, W, H)
    // 0.002° lat ≈ 222 m north; the equivalent easting in degrees at this latitude.
    const dLat = 0.002
    const dLng = dLat / Math.cos((BAY_AREA.lat * Math.PI) / 180)

    const north = project(BAY_AREA.lat + dLat, BAY_AREA.lng, fitted, W, H)
    const east = project(BAY_AREA.lat, BAY_AREA.lng + dLng, fitted, W, H)

    const pxNorth = Math.abs(north.y - origin.y)
    const pxEast = Math.abs(east.x - origin.x)
    // Equal ground distance ⇒ equal pixels, within a fraction of a percent.
    expect(pxEast / pxNorth).toBeCloseTo(1, 2)
  })

  it('the unfitted bbox is genuinely distorted — the bug this guards', () => {
    // Same test against the raw bbox must FAIL the uniform-scale property, or the fix above
    // would be untested decoration.
    const square = computeBbox([
      { lat: BAY_AREA.lat - 0.01, lng: BAY_AREA.lng - 0.01 },
      { lat: BAY_AREA.lat + 0.01, lng: BAY_AREA.lng + 0.01 },
    ])
    const W = 360
    const H = 240
    const origin = project(BAY_AREA.lat, BAY_AREA.lng, square, W, H)
    const dLat = 0.002
    const dLng = dLat / Math.cos((BAY_AREA.lat * Math.PI) / 180)
    const pxNorth = Math.abs(project(BAY_AREA.lat + dLat, BAY_AREA.lng, square, W, H).y - origin.y)
    const pxEast = Math.abs(project(BAY_AREA.lat, BAY_AREA.lng + dLng, square, W, H).x - origin.x)
    expect(pxEast / pxNorth).not.toBeCloseTo(1, 2)
  })

  it('only ever grows the window, so nothing visible is cropped', () => {
    const bbox = computeBbox([
      { lat: 37.88, lng: -122.26 },
      { lat: 37.92, lng: -122.22 },
    ])
    for (const [w, h] of [[360, 240], [240, 360], [800, 200], [200, 800]] as const) {
      const fitted = fitBboxToAspect(bbox, w, h)
      expect(fitted.minLat).toBeLessThanOrEqual(bbox.minLat + 1e-12)
      expect(fitted.maxLat).toBeGreaterThanOrEqual(bbox.maxLat - 1e-12)
      expect(fitted.minLng).toBeLessThanOrEqual(bbox.minLng + 1e-12)
      expect(fitted.maxLng).toBeGreaterThanOrEqual(bbox.maxLng - 1e-12)
    }
  })

  it('keeps the mission centred', () => {
    const bbox = computeBbox([{ lat: 37.88, lng: -122.26 }, { lat: 37.92, lng: -122.22 }])
    const fitted = fitBboxToAspect(bbox, 900, 300)
    expect((fitted.minLat + fitted.maxLat) / 2).toBeCloseTo((bbox.minLat + bbox.maxLat) / 2, 9)
    expect((fitted.minLng + fitted.maxLng) / 2).toBeCloseTo((bbox.minLng + bbox.maxLng) / 2, 9)
  })

  it('a wide tile gains longitude and a tall tile gains latitude', () => {
    const bbox = computeBbox([{ lat: 37.88, lng: -122.26 }, { lat: 37.92, lng: -122.22 }])
    const wide = fitBboxToAspect(bbox, 900, 300)
    const tall = fitBboxToAspect(bbox, 300, 900)
    expect(wide.maxLng - wide.minLng).toBeGreaterThan(tall.maxLng - tall.minLng)
    expect(tall.maxLat - tall.minLat).toBeGreaterThan(wide.maxLat - wide.minLat)
  })

  it('survives degenerate input without producing NaN', () => {
    for (const bbox of [computeBbox([]), computeBbox([BAY_AREA])]) {
      const fitted = fitBboxToAspect(bbox, 360, 240)
      for (const v of [fitted.minLat, fitted.maxLat, fitted.minLng, fitted.maxLng]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      const p = project(BAY_AREA.lat, BAY_AREA.lng, fitted, 360, 240)
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    // Zero-sized canvas is a no-op rather than a division by zero.
    const bbox = computeBbox([{ lat: 37.88, lng: -122.26 }, { lat: 37.92, lng: -122.22 }])
    expect(fitBboxToAspect(bbox, 0, 240)).toEqual(bbox)
    expect(fitBboxToAspect(bbox, 360, 0)).toEqual(bbox)
  })

  it('a fitted window is already fitted — idempotent', () => {
    const bbox = computeBbox([{ lat: 37.88, lng: -122.26 }, { lat: 37.92, lng: -122.22 }])
    const once = fitBboxToAspect(bbox, 360, 240)
    const twice = fitBboxToAspect(once, 360, 240)
    expect(twice.minLat).toBeCloseTo(once.minLat, 12)
    expect(twice.maxLng).toBeCloseTo(once.maxLng, 12)
  })

  it('scenario geometry keeps its real proportions on the wall', () => {
    // End to end: a 2 km × 1 km AO must project to a 2:1 pixel footprint, whatever the tile size.
    const sw = { lat: 37.9, lng: -122.25 }
    const ne = { lat: sw.lat + 1000 / 111_320, lng: sw.lng + 2000 / (111_320 * Math.cos((37.9 * Math.PI) / 180)) }
    const ground = metres(sw, ne)
    expect(ground.x / ground.y).toBeCloseTo(2, 1)

    const bbox = fitBboxToAspect(computeBbox([sw, ne]), 320, Math.round(320 / (3 / 2)))
    const a = project(sw.lat, sw.lng, bbox, 320, Math.round(320 / (3 / 2)))
    const b = project(ne.lat, ne.lng, bbox, 320, Math.round(320 / (3 / 2)))
    expect(Math.abs(b.x - a.x) / Math.abs(b.y - a.y)).toBeCloseTo(2, 1)
  })
})

describe('tile reference frame', () => {
  it('picks round 1/2/5 scale-bar distances', () => {
    // The standard progression — a bar reading "437 m" is useless to an instructor.
    expect(scaleBarMetres(1, 100)).toBe(100)
    expect(scaleBarMetres(1, 230)).toBe(200)
    expect(scaleBarMetres(1, 640)).toBe(500)
    expect(scaleBarMetres(1, 1100)).toBe(1000)
    expect(scaleBarMetres(0.5, 100)).toBe(50)
    expect(scaleBarMetres(10, 100)).toBe(1000)
    // Every result is a 1, 2 or 5 followed by zeros.
    for (const mpp of [0.2, 1, 3.7, 12, 95]) {
      for (const px of [40, 90, 160, 320]) {
        const m = scaleBarMetres(mpp, px)
        const lead = m / Math.pow(10, Math.floor(Math.log10(m)))
        expect([1, 2, 5]).toContain(Math.round(lead))
      }
    }
  })

  it('reports ground scale that matches the fitted window', () => {
    const bbox = fitBboxToAspect(
      computeBbox([{ lat: 37.9, lng: -122.25 }, { lat: 37.91, lng: -122.24 }]),
      320, 213,
    )
    const mpp = metresPerPixel(bbox, 320)
    // A ~1 km-ish AO across 320 px lands in single-digit metres per pixel.
    expect(mpp).toBeGreaterThan(1)
    expect(mpp).toBeLessThan(30)
    // Doubling the pixel width halves the ground scale.
    expect(metresPerPixel(bbox, 640)).toBeCloseTo(mpp / 2, 6)
  })

  it('degenerate widths do not produce a scale', () => {
    const bbox = computeBbox([{ lat: 37.9, lng: -122.25 }])
    expect(metresPerPixel(bbox, 0)).toBe(0)
  })
})
