import { describe, expect, it } from 'vitest'
import {
  LOOKAHEAD_M,
  MARKER_MAX_PX,
  MARKER_MIN_PX,
  VEHICLE_ASPECT,
  VEHICLE_LENGTH_M,
  avatarFor,
  bearingDeg,
  groundUnitSlots,
  groundUnitVariants,
  headingAt,
  isHidden,
  markerSizePx,
  mpp,
  pointAtDistance,
  recoveryChipOffset,
  routeLengthM,
  vehicleImageUrls,
  type RouteLike,
} from '@/components/vehicleAvatars'

const LAT0 = 37.77
const M_PER_DEG_LAT = 111_320

/** Build a route from a metre grid (x east, y north) so expected geometry is exact. */
function gridRoute(
  metres: ReadonlyArray<readonly [number, number]>,
  hiddenRanges?: Array<[number, number]>,
): RouteLike {
  const points = metres.map(([x, y]) => ({
    lat: LAT0 + y / M_PER_DEG_LAT,
    lng: -122.4 + x / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)),
  }))
  const cumDistM: number[] = [0]
  for (let i = 1; i < metres.length; i += 1) {
    const dx = metres[i][0] - metres[i - 1][0]
    const dy = metres[i][1] - metres[i - 1][1]
    cumDistM.push(cumDistM[i - 1] + Math.hypot(dx, dy))
  }
  return { points, cumDistM, hiddenRanges }
}

// P0 -> 100 m north -> 100 m east -> 50 m north. Total 250 m.
const ROUTE = gridRoute(
  [[0, 0], [0, 100], [100, 100], [100, 150]],
  [[120, 160]],
)

const near = (a: number, b: number, tol = 1e-7) => Math.abs(a - b) <= tol

describe('vehicle variant selection', () => {
  it('exposes the owner-measured aspects and lengths', () => {
    expect(VEHICLE_ASPECT).toEqual({ truck: 0.534, suv: 0.512, pickup: 0.523 })
    expect(VEHICLE_LENGTH_M).toEqual({ truck: 5.6, suv: 5.6, pickup: 5.9 })
  })

  it('recovery always gets the pickup and ignores the index arguments', () => {
    for (const [firstIdx, k] of [[0, 0], [1, 0], [5, 3], [8, 7]] as const) {
      expect(avatarFor('recovery', firstIdx, k)).toBe('pickup')
    }
  })

  it('ground units use (firstIdx + k) % 2 with 0 = truck and 1 = suv', () => {
    expect(avatarFor('ground', 0, 0)).toBe('truck')
    expect(avatarFor('ground', 0, 1)).toBe('suv')
    expect(avatarFor('ground', 1, 0)).toBe('suv')
    expect(avatarFor('ground', 1, 1)).toBe('truck')
    expect(avatarFor('ground', 4, 3)).toBe('suv')
  })

  it('units [A0, B0, A1, B1, A2] resolve to truck, suv, suv, truck, truck', () => {
    const units = [
      { id: 'A0', targetThermalId: 'A' },
      { id: 'B0', targetThermalId: 'B' },
      { id: 'A1', targetThermalId: 'A' },
      { id: 'B1', targetThermalId: 'B' },
      { id: 'A2', targetThermalId: 'A' },
    ]
    const slots = groundUnitSlots(units)
    expect(slots.get('A0')).toEqual({ firstIdx: 0, k: 0 })
    expect(slots.get('B0')).toEqual({ firstIdx: 1, k: 0 })
    expect(slots.get('A1')).toEqual({ firstIdx: 0, k: 1 })
    expect(slots.get('B1')).toEqual({ firstIdx: 1, k: 1 })
    expect(slots.get('A2')).toEqual({ firstIdx: 0, k: 2 })

    const variants = groundUnitVariants(units)
    expect(units.map((u) => variants.get(u.id))).toEqual(['truck', 'suv', 'suv', 'truck', 'truck'])
    expect(variants.get('A0')).not.toBe(variants.get('A1'))
    expect(variants.get('B0')).not.toBe(variants.get('B1'))
  })

  it('is a pure function of array order, so a replayed prefix gives the same answers', () => {
    const units = [
      { id: 'A0', targetThermalId: 'A' },
      { id: 'B0', targetThermalId: 'B' },
      { id: 'A1', targetThermalId: 'A' },
      { id: 'B1', targetThermalId: 'B' },
    ]
    const full = groundUnitVariants(units)
    const prefix = groundUnitVariants(units.slice(0, 3))
    for (const u of units.slice(0, 3)) expect(prefix.get(u.id)).toBe(full.get(u.id))
    expect(groundUnitVariants(units)).toEqual(full)
  })

  it('recovery-role entries get the pickup and consume no k, even when mixed in', () => {
    const units = [
      { id: 'A0', targetThermalId: 'A' },
      { id: 'R', role: 'recovery', targetThermalId: 'A' },
      { id: 'A1', targetThermalId: 'A' },
      { id: 'A2', targetThermalId: 'A' },
    ]
    const variants = groundUnitVariants(units)
    expect(variants.get('R')).toBe('pickup')
    expect(variants.get('A0')).toBe('truck')
    expect(variants.get('A1')).toBe('suv')
    expect(variants.get('A2')).toBe('truck')
    expect(groundUnitSlots(units).has('R')).toBe(false)
  })

  it('groups units without a target together and does not mix them with targeted ones', () => {
    const units = [
      { id: 'N0' },
      { id: 'A0', targetThermalId: 'A' },
      { id: 'N1' },
    ]
    const slots = groundUnitSlots(units)
    expect(slots.get('N0')).toEqual({ firstIdx: 0, k: 0 })
    expect(slots.get('N1')).toEqual({ firstIdx: 0, k: 1 })
    expect(slots.get('A0')).toEqual({ firstIdx: 1, k: 0 })
  })
})

describe('mpp and markerSizePx', () => {
  it('mpp matches the web-mercator ground resolution on 512 px tiles', () => {
    expect(near(mpp(0, 0), 40075016.686 / 512, 1e-6)).toBe(true)
    expect(near(mpp(1, 0), 40075016.686 / 1024, 1e-6)).toBe(true)
    expect(near(mpp(10, 60), mpp(10, 0) * 0.5, 1e-6)).toBe(true)
  })

  it('at latitude 37.77 the truck is 36 px at zoom 14, ~47.5 px at zoom 19 and 112 px at zoom 21', () => {
    const z14 = markerSizePx(14, LAT0, VEHICLE_LENGTH_M.truck, VEHICLE_ASPECT.truck)
    const z19 = markerSizePx(19, LAT0, VEHICLE_LENGTH_M.truck, VEHICLE_ASPECT.truck)
    const z21 = markerSizePx(21, LAT0, VEHICLE_LENGTH_M.truck, VEHICLE_ASPECT.truck)
    expect(z14.lengthPx).toBe(MARKER_MIN_PX)
    expect(MARKER_MIN_PX).toBe(36)
    expect(Math.abs(z19.lengthPx - 47.5)).toBeLessThanOrEqual(1)
    expect(z21.lengthPx).toBe(MARKER_MAX_PX)
    expect(MARKER_MAX_PX).toBe(112)
  })

  it('zooms 14, 16 and 18 all draw the 36 px floor', () => {
    for (const zoom of [14, 16, 18]) {
      expect(markerSizePx(zoom, LAT0, 5.6, VEHICLE_ASPECT.truck).lengthPx).toBe(36)
      expect(markerSizePx(zoom, LAT0, 5.9, VEHICLE_ASPECT.pickup).lengthPx).toBe(36)
    }
  })

  it('width is length times aspect', () => {
    const size = markerSizePx(19, LAT0, 5.9, VEHICLE_ASPECT.pickup)
    expect(near(size.widthPx, size.lengthPx * 0.523)).toBe(true)
    const capped = markerSizePx(21, LAT0, 5.6, VEHICLE_ASPECT.suv)
    expect(near(capped.widthPx, 112 * 0.512)).toBe(true)
  })

  it('is monotonic in zoom between the clamps', () => {
    let prev = 0
    for (let z = 14; z <= 21; z += 0.5) {
      const { lengthPx } = markerSizePx(z, LAT0, 5.6, VEHICLE_ASPECT.truck)
      expect(lengthPx).toBeGreaterThanOrEqual(prev)
      prev = lengthPx
    }
  })

  it('floor holds until about zoom 18.6 for 5.6 m and 18.5 for 5.9 m at latitude 37.77', () => {
    expect(markerSizePx(18.5, LAT0, 5.6, 0.5).lengthPx).toBe(36)
    expect(markerSizePx(18.7, LAT0, 5.6, 0.5).lengthPx).toBeGreaterThan(36)
    expect(markerSizePx(18.4, LAT0, 5.9, 0.5).lengthPx).toBe(36)
    expect(markerSizePx(18.6, LAT0, 5.9, 0.5).lengthPx).toBeGreaterThan(36)
  })

  it('places the recovery chip just above the vehicle', () => {
    expect(recoveryChipOffset(36)).toEqual([0, -(18 + 10)])
    expect(recoveryChipOffset(112)).toEqual([0, -(56 + 10)])
  })
})

describe('vehicleImageUrls', () => {
  it('uses the 128 file as src and the 256 file at 2x', () => {
    const urls = vehicleImageUrls('pickup', '/')
    expect(urls.src).toBe('/ground-units/recovery-unit-pickup-128.png')
    expect(urls.srcSet).toBe(
      '/ground-units/recovery-unit-pickup-128.png 1x, /ground-units/recovery-unit-pickup-256.png 2x',
    )
    expect(vehicleImageUrls('truck', '/').src).toBe('/ground-units/ground-unit-truck-128.png')
    expect(vehicleImageUrls('suv', '/').srcSet).toContain('/ground-units/ground-unit-suv-256.png 2x')
  })

  it('honours a non-root vite base with or without a trailing slash', () => {
    expect(vehicleImageUrls('truck', '/Autonomous-Drone-Simulator/').src).toBe(
      '/Autonomous-Drone-Simulator/ground-units/ground-unit-truck-128.png',
    )
    expect(vehicleImageUrls('truck', '/Autonomous-Drone-Simulator').src).toBe(
      '/Autonomous-Drone-Simulator/ground-units/ground-unit-truck-128.png',
    )
  })

  it('defaults to import.meta.env.BASE_URL', () => {
    expect(vehicleImageUrls('suv').src).toBe(`${import.meta.env.BASE_URL}ground-units/ground-unit-suv-128.png`)
  })
})

describe('pointAtDistance', () => {
  const [p0, p1, p2, p3] = ROUTE.points

  it('returns the vertices exactly at the cumulative distances', () => {
    expect(pointAtDistance(ROUTE, 0)).toEqual(p0)
    expect(pointAtDistance(ROUTE, ROUTE.cumDistM[1])).toEqual(p1)
    expect(pointAtDistance(ROUTE, ROUTE.cumDistM[2])).toEqual(p2)
    expect(pointAtDistance(ROUTE, ROUTE.cumDistM[3])).toEqual(p3)
  })

  it('interpolates inside a segment', () => {
    const mid1 = pointAtDistance(ROUTE, 50)!
    expect(near(mid1.lat, (p0.lat + p1.lat) / 2)).toBe(true)
    expect(near(mid1.lng, p0.lng)).toBe(true)
    const mid2 = pointAtDistance(ROUTE, 150)!
    expect(near(mid2.lat, p1.lat)).toBe(true)
    expect(near(mid2.lng, (p1.lng + p2.lng) / 2)).toBe(true)
    const quarter3 = pointAtDistance(ROUTE, 212.5)!
    expect(near(quarter3.lat, p2.lat + (p3.lat - p2.lat) * 0.25)).toBe(true)
  })

  it('clamps before the start and after the end', () => {
    expect(pointAtDistance(ROUTE, -25)).toEqual(p0)
    expect(pointAtDistance(ROUTE, Number.NEGATIVE_INFINITY)).toEqual(p0)
    expect(pointAtDistance(ROUTE, 9999)).toEqual(p3)
    expect(pointAtDistance(ROUTE, Number.NaN)).toEqual(p0)
  })

  it('stays on the polyline inside a hidden range (position is unchanged, only visibility)', () => {
    expect(isHidden(ROUTE, 140)).toBe(true)
    const inside = pointAtDistance(ROUTE, 140)!
    expect(near(inside.lat, p1.lat)).toBe(true)
    expect(near(inside.lng, p1.lng + (p2.lng - p1.lng) * 0.4)).toBe(true)
  })

  it('handles single-point, empty and zero-length-segment routes without NaN', () => {
    const single: RouteLike = { points: [p0], cumDistM: [0] }
    expect(pointAtDistance(single, 10)).toEqual(p0)
    expect(pointAtDistance({ points: [], cumDistM: [] }, 5)).toBeNull()
    const dup = gridRoute([[0, 0], [0, 0], [0, 50]])
    const mid = pointAtDistance(dup, 25)!
    expect(Number.isFinite(mid.lat) && Number.isFinite(mid.lng)).toBe(true)
    expect(near(mid.lat, LAT0 + 25 / M_PER_DEG_LAT)).toBe(true)
  })

  it('finds the segment by binary search on a long route', () => {
    const long = gridRoute(Array.from({ length: 2001 }, (_, i) => [0, i * 10] as const))
    expect(routeLengthM(long)).toBe(20000)
    const hit = pointAtDistance(long, 12345)!
    expect(near(hit.lat, LAT0 + 12345 / M_PER_DEG_LAT, 1e-9)).toBe(true)
  })
})

describe('bearingDeg', () => {
  it('is degrees clockwise from north', () => {
    const o = { lat: LAT0, lng: -122.4 }
    expect(near(bearingDeg(o, { lat: LAT0 + 0.001, lng: o.lng }), 0, 1e-6)).toBe(true)
    expect(near(bearingDeg(o, { lat: LAT0, lng: o.lng + 0.001 }), 90, 1e-6)).toBe(true)
    expect(near(bearingDeg(o, { lat: LAT0 - 0.001, lng: o.lng }), 180, 1e-6)).toBe(true)
    expect(near(bearingDeg(o, { lat: LAT0, lng: o.lng - 0.001 }), 270, 1e-6)).toBe(true)
  })

  it('weights longitude by cos(lat) so a 45 degree metre offset reads 45', () => {
    const [a] = ROUTE.points
    const b = gridRoute([[0, 0], [30, 30]]).points[1]
    expect(Math.abs(bearingDeg(a, b) - 45)).toBeLessThan(0.05)
  })
})

describe('headingAt', () => {
  it('uses the segment bearing away from vertices', () => {
    expect(Math.abs(headingAt(ROUTE, 50))).toBeLessThan(0.05)
    expect(Math.abs(headingAt(ROUTE, 150) - 90)).toBeLessThan(0.05)
    expect(Math.abs(headingAt(ROUTE, 220))).toBeLessThan(0.05)
  })

  it('looks ahead 6 m so the marker does not snap at a vertex', () => {
    expect(LOOKAHEAD_M).toBe(6)
    // 3 m before the corner: chord to 3 m past it is 3 m north and 3 m east.
    expect(Math.abs(headingAt(ROUTE, 97) - 45)).toBeLessThan(0.5)
    // 1 m before the corner: 1 m north, 5 m east.
    expect(Math.abs(headingAt(ROUTE, 99) - 78.69)).toBeLessThan(0.5)
    // exactly at the corner the lookahead is wholly on the new segment.
    expect(Math.abs(headingAt(ROUTE, 100) - 90)).toBeLessThan(0.05)
  })

  it('keeps the last segment bearing at and past the route end', () => {
    expect(Math.abs(headingAt(ROUTE, 250))).toBeLessThan(0.05)
    expect(Math.abs(headingAt(ROUTE, 400))).toBeLessThan(0.05)
    expect(Math.abs(headingAt(ROUTE, 248))).toBeLessThan(0.05)
  })

  it('returns a value in [0, 360) and 0 for a degenerate route', () => {
    const west = gridRoute([[0, 0], [-80, 0]])
    const h = headingAt(west, 10)
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThan(360)
    expect(Math.abs(h - 270)).toBeLessThan(0.05)
    expect(headingAt({ points: [ROUTE.points[0]], cumDistM: [0] }, 0)).toBe(0)
    expect(headingAt({ points: [], cumDistM: [] }, 0)).toBe(0)
  })

  it('skips a trailing zero-length segment when it takes the end bearing', () => {
    const trail = gridRoute([[0, 0], [50, 0], [50, 0]])
    expect(Math.abs(headingAt(trail, 50) - 90)).toBeLessThan(0.05)
  })
})

describe('isHidden', () => {
  it('is true strictly inside a hidden range and false outside or at the portals', () => {
    expect(isHidden(ROUTE, 121)).toBe(true)
    expect(isHidden(ROUTE, 140)).toBe(true)
    expect(isHidden(ROUTE, 159.5)).toBe(true)
    expect(isHidden(ROUTE, 119)).toBe(false)
    expect(isHidden(ROUTE, 161)).toBe(false)
    expect(isHidden(ROUTE, 120)).toBe(false)
    expect(isHidden(ROUTE, 160)).toBe(false)
  })

  it('is false when the route has no hidden ranges', () => {
    expect(isHidden(gridRoute([[0, 0], [0, 10]]), 5)).toBe(false)
    expect(isHidden({ points: [], cumDistM: [], hiddenRanges: [] }, 5)).toBe(false)
  })

  it('checks every range', () => {
    const multi = gridRoute([[0, 0], [0, 300]], [[10, 20], [100, 150]])
    expect(isHidden(multi, 15)).toBe(true)
    expect(isHidden(multi, 60)).toBe(false)
    expect(isHidden(multi, 120)).toBe(true)
  })
})
