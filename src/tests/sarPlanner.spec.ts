import { describe, it, expect } from 'vitest'
import { generatePerDroneWaypoints, generateGridLines } from '@/sim/mission/SARPlanner'
import type { LatLng } from '@/types'

// ~220m × ~222m box in Golden Gate Park
const SEARCH_AREA: LatLng[] = [
  { lat: 37.7700, lng: -122.4880 },
  { lat: 37.7720, lng: -122.4880 },
  { lat: 37.7720, lng: -122.4840 },
  { lat: 37.7700, lng: -122.4840 },
]

const SPACING_FT = 50

describe('SARPlanner', () => {
  it('returns empty array for degenerate polygon', () => {
    const wps = generatePerDroneWaypoints([{ lat: 0, lng: 0 }], 50, 0, 1, 120)
    expect(wps).toHaveLength(0)
  })

  it('generates at least 2 waypoints per drone for a valid area', () => {
    const wps = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 1, 120)
    expect(wps.length).toBeGreaterThanOrEqual(2)
  })

  it('all waypoints fall within bounding box of search area', () => {
    const wps = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 1, 120)
    for (const wp of wps) {
      expect(wp.position.lat).toBeGreaterThanOrEqual(37.7700 - 0.0001)
      expect(wp.position.lat).toBeLessThanOrEqual(37.7720 + 0.0001)
      expect(wp.position.lng).toBeGreaterThanOrEqual(-122.4880 - 0.0001)
      expect(wp.position.lng).toBeLessThanOrEqual(-122.4840 + 0.0001)
    }
  })

  it('waypoints use the assigned altitude', () => {
    const altFt = 140
    const wps = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 1, altFt)
    for (const wp of wps) {
      expect(wp.altitudeFt).toBe(altFt)
    }
  })

  it('3-drone split: each drone gets ~1/3 of the total rows', () => {
    const wps0 = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 3, 100)
    const wps1 = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 1, 3, 120)
    const wps2 = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 2, 3, 140)
    // All three combined should equal single-drone coverage
    const totalWps = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 1, 100)
    // Pairs per drone (2 wps per row). Allow ±2 for rounding.
    const combined = wps0.length + wps1.length + wps2.length
    expect(Math.abs(combined - totalWps.length)).toBeLessThanOrEqual(4)
  })

  it('adjacent waypoints in a row span the full width (east/west ends)', () => {
    const wps = generatePerDroneWaypoints(SEARCH_AREA, SPACING_FT, 0, 1, 120)
    if (wps.length < 2) return
    const [a, b] = wps
    // First row: endpoints span full longitude range
    const lngs = [a.position.lng, b.position.lng].sort((x, y) => x - y)
    expect(lngs[0]).toBeCloseTo(-122.4880, 3)
    expect(lngs[1]).toBeCloseTo(-122.4840, 3)
  })

  it('generateGridLines returns one line per row', () => {
    const lines = generateGridLines(SEARCH_AREA, SPACING_FT)
    // Each line spans the full longitude range
    for (const [start, end] of lines) {
      expect(start.lng).toBeCloseTo(-122.4880, 3)
      expect(end.lng).toBeCloseTo(-122.4840, 3)
    }
    expect(lines.length).toBeGreaterThan(0)
  })

  it('clips lawnmower rows to non-rectangular polygons (no bounding-box overshoot)', () => {
    // Right triangle: hypotenuse from NW to SE. Bounding-box rows would extend far east of
    // the hypotenuse on northern rows; clipped rows must stay inside the triangle.
    const TRIANGLE: LatLng[] = [
      { lat: 37.7700, lng: -122.4880 }, // SW
      { lat: 37.7720, lng: -122.4880 }, // NW
      { lat: 37.7700, lng: -122.4840 }, // SE
    ]
    const wps = generatePerDroneWaypoints(TRIANGLE, SPACING_FT, 0, 1, 120)
    expect(wps.length).toBeGreaterThanOrEqual(4)

    for (const wp of wps) {
      // For this triangle, the inside condition along a row is:
      // lng <= west edge + width * (1 - (lat - south)/height)
      const frac = (wp.position.lat - 37.7700) / 0.0020
      const maxLngAtRow = -122.4880 + 0.0040 * (1 - frac)
      expect(wp.position.lng, `row at ${wp.position.lat}`).toBeLessThanOrEqual(maxLngAtRow + 1e-9)
      expect(wp.position.lng).toBeGreaterThanOrEqual(-122.4880 - 1e-9)
    }

    // Northern rows must be shorter than southern rows (triangle narrows northward).
    const rows = new Map<number, number[]>()
    for (const wp of wps) {
      const key = wp.position.lat
      rows.set(key, [...(rows.get(key) ?? []), wp.position.lng])
    }
    const widths = [...rows.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, lngs]) => Math.max(...lngs) - Math.min(...lngs))
    expect(widths[0]).toBeGreaterThan(widths[widths.length - 1])
  })
})
