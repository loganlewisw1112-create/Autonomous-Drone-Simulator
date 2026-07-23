import { describe, expect, it } from 'vitest'
import {
  bandLimitedNoise,
  DEFAULT_UERE_M,
  DEGRADED_HDOP,
  evaluateGnss,
  visibleSatellites,
  type GnssInput,
} from '@/sim/nav/gnss'
import { computeDop, MAX_USABLE_HDOP, type SatelliteLook } from '@/sim/nav/dop'
import { constellationAt, constellationFor } from '@/scenarios/constellationFixtures'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import { haversineDistanceM } from '@/utils/geometry'

// REALISM_ROADMAP WP-7 §7.2 / §18.3. Occlusion → DOP → reported position.

const AO = { lat: 37.8992, lng: -122.2432 }

const OPEN_SKY: SatelliteLook[] = [
  { azDeg: 0, elDeg: 90 },
  ...Array.from({ length: 7 }, (_, i) => ({ azDeg: (i * 360) / 7, elDeg: 36 })),
]

/** Sky visible everywhere — isolates the DOP term from the occlusion term. */
const openOcclusion: OcclusionService = {
  groundElevation: () => 0,
  surfaceHeight: () => 0,
  hasLineOfSight: () => ({ clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 100 }),
  skyVisibility: () => true,
}

/** A N–S street canyon: only satellites within ±12° of the street axis survive. */
const canyonOcclusion: OcclusionService = {
  ...openOcclusion,
  skyVisibility: (_from, azDeg) => {
    const offAxis = Math.min(
      Math.abs(((azDeg % 360) + 360) % 360),
      Math.abs((((azDeg % 360) + 360) % 360) - 180),
      360 - Math.abs(((azDeg % 360) + 360) % 360),
    )
    return offAxis <= 12
  },
}

/** Total sky blockage — under a structure, or in a slot too deep for any satellite. */
const blockedOcclusion: OcclusionService = { ...openOcclusion, skyVisibility: () => false }

function input(overrides: Partial<GnssInput> = {}): GnssInput {
  return {
    droneId: 'uav-01',
    position: AO,
    altMslM: 400,
    constellation: OPEN_SKY,
    occlusion: openOcclusion,
    seed: 5005,
    tick: 100,
    elapsedSec: 120,
    ...overrides,
  }
}

describe('GNSS occlusion → DOP → reported position (WP-7)', () => {
  it('open sky yields a good fix and a metres-scale error', () => {
    const state = evaluateGnss(input())
    expect(state.fixQuality).toBe('fix')
    expect(state.satsVisible).toBe(8)
    expect(state.satsInView).toBe(8)
    expect(state.hdop!).toBeGreaterThanOrEqual(0.8)
    expect(state.hdop!).toBeLessThanOrEqual(1.5)
    // σ_H = HDOP × σ_UERE
    expect(state.horizontalErrorM).toBeCloseTo(state.hdop! * DEFAULT_UERE_M, 9)
    expect(state.horizontalErrorM!).toBeLessThan(10)
    expect(state.lossReason).toBeNull()
  })

  it('a street canyon exceeds HDOP 4 and 10 m of horizontal error', () => {
    // The canyon must not be so tight that the fix is refused outright — that is a different
    // test. Six satellites survive the ±12° mask here.
    const canyonSats: SatelliteLook[] = [
      { azDeg: 352, elDeg: 30 }, { azDeg: 0, elDeg: 50 }, { azDeg: 8, elDeg: 70 },
      { azDeg: 172, elDeg: 30 }, { azDeg: 180, elDeg: 50 }, { azDeg: 188, elDeg: 70 },
      // These are outside the canyon's ±12° and must be culled by the occlusion service.
      { azDeg: 90, elDeg: 40 }, { azDeg: 270, elDeg: 40 },
    ]
    const state = evaluateGnss(input({ constellation: canyonSats, occlusion: canyonOcclusion }))

    expect(state.satsInView).toBe(8)
    expect(state.satsVisible).toBe(6)
    expect(state.hdop!).toBeGreaterThan(4)
    expect(state.horizontalErrorM!).toBeGreaterThan(10)
    expect(state.fixQuality).toBe('degraded')
    expect(state.hdop!).toBeGreaterThanOrEqual(DEGRADED_HDOP)
  })

  it('total sky blockage is loss of fix, not a wild position', () => {
    const state = evaluateGnss(input({ occlusion: blockedOcclusion }))
    expect(state.fixQuality).toBe('no_fix')
    expect(state.satsVisible).toBe(0)
    expect(state.lossReason).toBe('insufficient_satellites')
    expect(state.hdop).toBeNull()
    expect(state.horizontalErrorM).toBeNull()
    // Position hold: the reported position is what the receiver last vouched for.
    expect(state.reportedPosition).toEqual(AO)
  })

  it('a degenerate geometry produces loss-of-fix rather than a 9 km error', () => {
    // Two tight azimuth clusters: §18.3 computes ~2448 HDOP for this, which taken at face value
    // would place the aircraft ~9.8 km away. The accept criterion is that it is refused.
    const degenerate: SatelliteLook[] = [
      { azDeg: 0, elDeg: 60 }, { azDeg: 1, elDeg: 62 },
      { azDeg: 180, elDeg: 60 }, { azDeg: 181, elDeg: 62 },
    ]
    expect(computeDop(degenerate)!.hdop).toBeGreaterThan(MAX_USABLE_HDOP)

    const state = evaluateGnss(input({ constellation: degenerate }))
    expect(state.fixQuality).toBe('no_fix')
    expect(state.lossReason).toBe('degenerate_geometry')
    expect(state.horizontalErrorM).toBeNull()
    // Four satellites WERE visible — the refusal is about geometry, not count.
    expect(state.satsVisible).toBe(4)
    expect(haversineDistanceM(state.reportedPosition, AO)).toBe(0)
  })

  it('holds the last reported position through a fix outage', () => {
    const held = { lat: 37.9, lng: -122.244 }
    const state = evaluateGnss(input({ occlusion: blockedOcclusion, lastReported: held }))
    expect(state.reportedPosition).toEqual(held)
    expect(state.fixQuality).toBe('no_fix')
  })

  it('never moves the ground truth', () => {
    const truth = { ...AO }
    const state = evaluateGnss(input({ position: truth }))
    expect(truth).toEqual(AO)
    expect(state.reportedPosition).not.toBe(truth)
  })

  it('reported position stays within 3σ and never jumps more than 3σ between fixes', () => {
    // The accept criterion. Walk a full mission's worth of consecutive 1 Hz evaluations.
    let previous = evaluateGnss(input({ elapsedSec: 0 }))
    const sigma = previous.horizontalErrorM!
    for (let t = 1; t <= 600; t += 1) {
      const state = evaluateGnss(input({ elapsedSec: t }))
      expect(haversineDistanceM(state.reportedPosition, AO)).toBeLessThanOrEqual(sigma * 3 + 1e-6)
      expect(haversineDistanceM(state.reportedPosition, previous.reportedPosition))
        .toBeLessThanOrEqual(sigma * 3 + 1e-6)
      previous = state
    }
  })

  it('the error signal is continuous, zero-mean and free of persistent state', () => {
    // Continuity: adjacent sim times give adjacent values. A per-tick RNG draw would not.
    for (let t = 0; t < 200; t += 1) {
      const a = bandLimitedNoise(1337, 'uav-01', 'E', t)
      const b = bandLimitedNoise(1337, 'uav-01', 'E', t + 0.05)
      expect(Math.abs(b - a)).toBeLessThan(0.05)
      expect(Math.abs(a)).toBeLessThanOrEqual(1)
    }
    // Zero-mean over a long window, so the error wanders rather than biasing the track.
    let sum = 0
    for (let t = 0; t < 4000; t += 1) sum += bandLimitedNoise(1337, 'uav-01', 'E', t)
    expect(Math.abs(sum / 4000)).toBeLessThan(0.05)

    // Purely a function of its arguments — evaluation order cannot matter.
    expect(bandLimitedNoise(1337, 'uav-01', 'E', 55)).toBe(bandLimitedNoise(1337, 'uav-01', 'E', 55))
    // Independent per drone and per axis.
    expect(bandLimitedNoise(1337, 'uav-01', 'E', 55)).not.toBe(bandLimitedNoise(1337, 'uav-02', 'E', 55))
    expect(bandLimitedNoise(1337, 'uav-01', 'E', 55)).not.toBe(bandLimitedNoise(1337, 'uav-01', 'N', 55))
  })

  it('is deterministic across repeated evaluation and reachable order', () => {
    const first = evaluateGnss(input({ elapsedSec: 331 }))
    const second = evaluateGnss(input({ elapsedSec: 331 }))
    expect(second).toEqual(first)
    // Reaching t=331 via a different tick number must not change the answer: the error is a
    // function of SIM TIME, which is what keeps sub-stepped replay byte-identical.
    expect(evaluateGnss(input({ elapsedSec: 331, tick: 9999 }))).toEqual(first)
  })

  it('applies the elevation mask before occlusion', () => {
    const withLow: SatelliteLook[] = [...OPEN_SKY, { azDeg: 45, elDeg: 2 }]
    const { inView, visible } = visibleSatellites(AO, 400, withLow, openOcclusion)
    expect(withLow).toHaveLength(9)
    expect(inView).toHaveLength(8)
    expect(visible).toHaveLength(8)
  })

  it('treats an absent occlusion service as open sky, not as obstruction', () => {
    const state = evaluateGnss(input({ occlusion: undefined }))
    // No terrain fixture is honest ignorance. Inventing a GNSS penalty from missing data would
    // be the same error as inventing a detection radius.
    expect(state.satsVisible).toBe(state.satsInView)
    expect(state.fixQuality).toBe('fix')
  })
})

describe('committed constellation fixture (WP-7 §7.2 step 1)', () => {
  const fixture = constellationFor('demo_wildfire')

  it('is present and physically plausible for the demo_wildfire AO', () => {
    expect(fixture).toBeDefined()
    expect(fixture!.stepSec).toBe(300)
    expect(fixture!.epochs.length).toBeGreaterThan(1)
    expect(fixture!.reference.lat).toBeCloseTo(AO.lat, 3)

    for (const epoch of fixture!.epochs) {
      // A real GPS constellation puts roughly 8–14 satellites above the horizon at any instant.
      expect(epoch.length).toBeGreaterThanOrEqual(6)
      expect(epoch.length).toBeLessThanOrEqual(16)
      for (const [prn, az, el] of epoch) {
        expect(prn).toBeGreaterThanOrEqual(1)
        expect(prn).toBeLessThanOrEqual(32)
        expect(az).toBeGreaterThanOrEqual(0)
        expect(az).toBeLessThan(360)
        expect(el).toBeGreaterThanOrEqual(0)
        expect(el).toBeLessThanOrEqual(90)
      }
    }
  })

  it('yields open-sky HDOP in the literature band across the whole mission window', () => {
    // The real validation of both the orbital propagation and the DOP maths: a published US
    // Space Force almanac, propagated to this AO, must land in the 0.8–1.5 open-sky band the
    // accept criterion names. Nothing here is tuned to make that true.
    const span = (fixture!.epochs.length - 1) * fixture!.stepSec
    for (let t = 0; t <= span; t += 60) {
      const looks = constellationAt(fixture, t)
      const state = evaluateGnss(input({ constellation: looks, elapsedSec: t }))
      expect(state.fixQuality).toBe('fix')
      expect(state.hdop!).toBeGreaterThanOrEqual(0.8)
      expect(state.hdop!).toBeLessThanOrEqual(1.5)
      expect(state.satsVisible).toBeGreaterThanOrEqual(6)
    }
  })

  it('interpolates between epochs without sweeping azimuth the long way round', () => {
    const atEpoch = constellationAt(fixture, 0)
    const midway = constellationAt(fixture, fixture!.stepSec / 2)
    const nextEpoch = constellationAt(fixture, fixture!.stepSec)
    expect(midway).toHaveLength(atEpoch.length)

    for (const sat of midway) {
      const from = atEpoch.find((s) => s.prn === sat.prn)
      const to = nextEpoch.find((s) => s.prn === sat.prn)
      if (!from || !to) continue
      // Satellites move ~0.5°/min, so 2.5 minutes can never move one more than a few degrees.
      const shortWay = Math.abs(((sat.azDeg - from.azDeg + 540) % 360) - 180)
      expect(shortWay).toBeLessThan(10)
      expect(sat.elDeg).toBeGreaterThanOrEqual(Math.min(from.elDeg, to.elDeg) - 1e-9)
      expect(sat.elDeg).toBeLessThanOrEqual(Math.max(from.elDeg, to.elDeg) + 1e-9)
    }
  })

  it('clamps past the end of the window rather than extrapolating', () => {
    const span = (fixture!.epochs.length - 1) * fixture!.stepSec
    expect(constellationAt(fixture, span + 100_000)).toEqual(constellationAt(fixture, span))
  })

  it('returns nothing for a scenario with no committed constellation', () => {
    expect(constellationFor('demo_basic')).toBeUndefined()
    expect(constellationAt(undefined, 0)).toEqual([])
  })

  it('degrades against the real demo_wildfire terrain when flown low', () => {
    // The end-to-end WP-4 → WP-7 path over real committed geodata. Down at ground level in the
    // East Bay hills, real terrain must cull real satellites relative to altitude.
    const terrain = occlusionServiceFor('demo_wildfire')
    expect(terrain).toBeDefined()
    const looks = constellationAt(fixture, 0)
    const ground = terrain!.groundElevation(AO.lat, AO.lng)

    const high = evaluateGnss(input({ constellation: looks, occlusion: terrain, altMslM: ground + 120 }))
    const low = evaluateGnss(input({ constellation: looks, occlusion: terrain, altMslM: ground + 1 }))

    expect(high.satsInView).toBe(low.satsInView)
    expect(low.satsVisible).toBeLessThanOrEqual(high.satsVisible)
    // Whatever the terrain does, the reported state stays internally consistent.
    for (const state of [high, low]) {
      if (state.fixQuality === 'no_fix') {
        expect(state.hdop).toBeNull()
      } else {
        expect(state.hdop!).toBeLessThanOrEqual(MAX_USABLE_HDOP)
        expect(state.horizontalErrorM).toBeCloseTo(state.hdop! * DEFAULT_UERE_M, 9)
      }
    }
  })
})
