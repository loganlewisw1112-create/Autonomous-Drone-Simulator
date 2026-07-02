import { describe, it, expect } from 'vitest'
import { haversineDistanceM, bearingDeg, offsetLatLng, angleDiffDeg, pointInPolygon } from '@/utils/geometry'

describe('geometry', () => {
  it('haversine: same point = 0m', () => {
    const p = { lat: 37.7695, lng: -122.4862 }
    expect(haversineDistanceM(p, p)).toBeCloseTo(0, 3)
  })

  it('haversine: ~1km offset', () => {
    const a = { lat: 37.0000, lng: -122.0000 }
    const b = { lat: 37.0090, lng: -122.0000 } // ~1km north
    const d = haversineDistanceM(a, b)
    expect(d).toBeGreaterThan(900)
    expect(d).toBeLessThan(1100)
  })

  it('bearingDeg: north = 0°', () => {
    const a = { lat: 37.0, lng: -122.0 }
    const b = { lat: 37.1, lng: -122.0 }
    expect(bearingDeg(a, b)).toBeCloseTo(0, 0)
  })

  it('bearingDeg: east = 90°', () => {
    const a = { lat: 37.0, lng: -122.0 }
    const b = { lat: 37.0, lng: -121.9 }
    expect(bearingDeg(a, b)).toBeCloseTo(90, 0)
  })

  it('offsetLatLng: moves expected distance', () => {
    const origin = { lat: 37.0, lng: -122.0 }
    const result = offsetLatLng(origin, 0, 1000) // 1km north
    const dist = haversineDistanceM(origin, result)
    expect(dist).toBeCloseTo(1000, 0)
  })

  it('angleDiffDeg: shortest path', () => {
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20, 1)   // wraps correctly
    expect(angleDiffDeg(10, 350)).toBeCloseTo(-20, 1)
    expect(angleDiffDeg(0, 90)).toBeCloseTo(90, 1)
  })

  it('pointInPolygon: inside square', () => {
    const poly = [
      { lat: 0, lng: 0 },
      { lat: 1, lng: 0 },
      { lat: 1, lng: 1 },
      { lat: 0, lng: 1 },
    ]
    expect(pointInPolygon({ lat: 0.5, lng: 0.5 }, poly)).toBe(true)
    expect(pointInPolygon({ lat: 2, lng: 2 }, poly)).toBe(false)
  })
})
