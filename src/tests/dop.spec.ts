import { describe, expect, it } from 'vitest'
import {
  aboveElevationMask,
  computeDop,
  ELEVATION_MASK_DEG,
  lookUnitVector,
  MAX_USABLE_HDOP,
  MIN_FIX_SATELLITES,
  type SatelliteLook,
} from '@/sim/nav/dop'

// REALISM_ROADMAP WP-7 / §18.3.
//
// ON THE ROADMAP'S REFERENCE TABLE. §18.3 tabulates HDOP for six named geometries ("open sky, 8
// satellites" → 0.94, "street canyon N–S, 6" → 5.23, and so on) but does NOT record the
// azimuth/elevation sets that produced them. Those values are therefore not reproducible as
// stated: many geometries answer to a description like "open sky, 8 satellites", and they span a
// wide HDOP range. Tuning a spread parameter until the output happened to read 5.23 would be
// manufacturing agreement with a number whose provenance cannot be checked — the same failure
// mode as WP-6's fabricated 60 m detection radius.
//
// So this spec pins geometries the repo owns and states outright, with the HDOP each actually
// produces, and asserts the BANDS the accept criteria are written in (open sky 0.8–1.5, canyon
// >4, degenerate → refused). The strongest validation is not in this file at all: it is in
// `gnss.spec.ts`, where the committed constellation fixture — real published almanac, real
// orbital propagation — yields open-sky HDOP of 0.85–1.09, inside the literature's band.

/** Even azimuth spread at a single elevation is genuinely singular; a zenith satellite fixes it. */
const OPEN_SKY_8: SatelliteLook[] = [
  { azDeg: 0, elDeg: 90 },
  ...Array.from({ length: 7 }, (_, i) => ({ azDeg: (i * 360) / 7, elDeg: 36 })),
]

const OPEN_SKY_6: SatelliteLook[] = [
  { azDeg: 0, elDeg: 90 },
  ...Array.from({ length: 5 }, (_, i) => ({ azDeg: i * 72, elDeg: 44 })),
]

/** Buildings east and west: satellites survive only in a narrow band about the N–S street axis. */
const CANYON_6: SatelliteLook[] = [
  { azDeg: 349.5, elDeg: 30 }, { azDeg: 0, elDeg: 50 }, { azDeg: 10.5, elDeg: 70 },
  { azDeg: 169.5, elDeg: 30 }, { azDeg: 180, elDeg: 50 }, { azDeg: 190.5, elDeg: 70 },
]

const CANYON_5: SatelliteLook[] = [
  { azDeg: 350, elDeg: 30 }, { azDeg: 0, elDeg: 50 }, { azDeg: 10, elDeg: 70 },
  { azDeg: 170, elDeg: 35 }, { azDeg: 180, elDeg: 60 },
]

/** A slot canyon: everything crammed into a few degrees of azimuth and high elevation. */
const DEEP_CANYON_4: SatelliteLook[] = [
  { azDeg: 357, elDeg: 60 }, { azDeg: 0, elDeg: 75 }, { azDeg: 3, elDeg: 60 }, { azDeg: 180, elDeg: 70 },
]

/** Two tight azimuth clusters — the near-singular case §18.3 warns about explicitly. */
const NEAR_DEGENERATE_4: SatelliteLook[] = [
  { azDeg: 0, elDeg: 60 }, { azDeg: 1, elDeg: 62 }, { azDeg: 180, elDeg: 60 }, { azDeg: 181, elDeg: 62 },
]

describe('GNSS dilution of precision (WP-7 §18.3)', () => {
  it('builds east-north-up unit vectors from azimuth and elevation', () => {
    const zenith = lookUnitVector({ azDeg: 0, elDeg: 90 })
    expect(zenith[0]).toBeCloseTo(0, 12)
    expect(zenith[1]).toBeCloseTo(0, 12)
    expect(zenith[2]).toBeCloseTo(1, 12)

    // Due east on the horizon is the +E axis.
    const east = lookUnitVector({ azDeg: 90, elDeg: 0 })
    expect(east[0]).toBeCloseTo(1, 12)
    expect(east[1]).toBeCloseTo(0, 12)

    // Azimuth is clockwise from NORTH, so 0° is +N — the convention error that would silently
    // mirror every canyon geometry.
    const north = lookUnitVector({ azDeg: 0, elDeg: 0 })
    expect(north[1]).toBeCloseTo(1, 12)
    expect(north[0]).toBeCloseTo(0, 12)

    // Always unit length.
    for (const look of [...OPEN_SKY_8, ...CANYON_6]) {
      const [e, n, u] = lookUnitVector(look)
      expect(Math.hypot(e, n, u)).toBeCloseTo(1, 12)
    }
  })

  it('open sky produces HDOP in the 0.8–1.5 band the accept criterion names', () => {
    const eight = computeDop(OPEN_SKY_8)
    const six = computeDop(OPEN_SKY_6)
    expect(eight).not.toBeNull()
    expect(six).not.toBeNull()

    expect(eight!.hdop).toBeGreaterThanOrEqual(0.8)
    expect(eight!.hdop).toBeLessThanOrEqual(1.5)
    expect(six!.hdop).toBeGreaterThanOrEqual(0.8)
    expect(six!.hdop).toBeLessThanOrEqual(1.5)

    // Exact values for these specific geometries, pinned so a regression in the maths is caught
    // rather than absorbed by the band.
    expect(eight!.hdop).toBeCloseTo(0.9344, 3)
    expect(six!.hdop).toBeCloseTo(1.2434, 3)

    // More satellites in an otherwise similar spread cannot worsen horizontal geometry.
    expect(eight!.hdop).toBeLessThan(six!.hdop)
    expect(eight!.satellites).toBe(8)
  })

  it('a street canyon drives HDOP past 4 — the literature dense-urban regime', () => {
    const six = computeDop(CANYON_6)!
    const five = computeDop(CANYON_5)!

    expect(six.hdop).toBeGreaterThan(4)
    expect(five.hdop).toBeGreaterThan(4)
    // Losing a satellite from an already-poor geometry makes it worse, never better.
    expect(five.hdop).toBeGreaterThan(six.hdop)

    // σ_H = HDOP × 4 m must exceed the 10 m the roadmap cites for dense urban canyons.
    expect(six.hdop * 4).toBeGreaterThan(10)
  })

  it('DOP ordering holds: PDOP ≥ HDOP and GDOP ≥ PDOP', () => {
    for (const geometry of [OPEN_SKY_8, OPEN_SKY_6, CANYON_6, CANYON_5]) {
      const dop = computeDop(geometry)!
      expect(dop.pdop).toBeGreaterThanOrEqual(dop.hdop)
      expect(dop.gdop).toBeGreaterThanOrEqual(dop.pdop)
      expect(dop.pdop).toBeCloseTo(Math.hypot(dop.hdop, dop.vdop), 9)
    }
  })

  it('refuses a fix below four satellites', () => {
    expect(MIN_FIX_SATELLITES).toBe(4)
    expect(computeDop(OPEN_SKY_8.slice(0, 3))).toBeNull()
    expect(computeDop([])).toBeNull()
    expect(computeDop(OPEN_SKY_8.slice(0, 4))).not.toBeNull()
  })

  it('reports degenerate geometries as huge rather than plausible, so the caller can refuse them', () => {
    // §18.3's implementation trap: these are mathematically correct and operationally
    // catastrophic. The maths must NOT quietly clamp — the refusal belongs to the caller, which
    // is what `gnss.spec.ts` verifies. What matters here is that the number is unmistakably bad.
    const deep = computeDop(DEEP_CANYON_4)!
    const degenerate = computeDop(NEAR_DEGENERATE_4)!

    expect(deep.hdop).toBeGreaterThan(MAX_USABLE_HDOP)
    expect(degenerate.hdop).toBeGreaterThan(MAX_USABLE_HDOP)
    expect(degenerate.hdop).toBeGreaterThan(deep.hdop)
    // Taken at face value these would place the aircraft hundreds of metres to kilometres away.
    expect(degenerate.hdop * 4).toBeGreaterThan(400)
  })

  it('satellites in a single plane give no vertical information and are refused', () => {
    // All on the horizon: the geometry matrix loses its up column entirely.
    const coplanar = Array.from({ length: 6 }, (_, i) => ({ azDeg: i * 60, elDeg: 0 }))
    expect(computeDop(coplanar)).toBeNull()
  })

  it('applies the 5° elevation mask before anything else', () => {
    expect(ELEVATION_MASK_DEG).toBe(5)
    const mixed: SatelliteLook[] = [
      { azDeg: 0, elDeg: 4.9 }, { azDeg: 90, elDeg: 5 },
      { azDeg: 180, elDeg: 45 }, { azDeg: 270, elDeg: 0 },
    ]
    const kept = aboveElevationMask(mixed)
    expect(kept.map((s) => s.elDeg)).toEqual([5, 45])
    // Exactly at the mask is kept; below it is not.
    expect(aboveElevationMask([{ azDeg: 0, elDeg: 5 }])).toHaveLength(1)
    expect(aboveElevationMask([{ azDeg: 0, elDeg: 4.999 }])).toHaveLength(0)
  })

  it('is deterministic and independent of satellite ordering', () => {
    const forward = computeDop(OPEN_SKY_8)!
    const reversed = computeDop([...OPEN_SKY_8].reverse())!
    // Bit-identical, not merely close: replay depends on it.
    expect(reversed.hdop).toBeCloseTo(forward.hdop, 12)
    expect(computeDop(OPEN_SKY_8)).toEqual(forward)
  })
})
