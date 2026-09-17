import { describe, expect, it } from 'vitest'
import { evaluateGnss } from '@/sim/nav/gnss'
import {
  constellationAt,
  constellationFor,
  scenariosWithConstellation,
} from '@/scenarios/constellationFixtures'
import {
  occlusionServiceFor,
  prepareScenarioTerrain,
  scenariosWithTerrain,
} from '@/scenarios/terrainFixtures'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'

// REALISM_ROADMAP WP-7 coverage extension. GNSS is only meaningful where the sky can actually
// be occluded, so every AO that carries a committed constellation must also carry the committed
// terrain the occlusion service masks against — and, across the set, that masking must really
// happen rather than every AO reporting a permanent open-sky fix.

const CONSTELLATION_IDS = scenariosWithConstellation()

/** Sky visible in every direction — isolates "what the constellation alone can see". */
const openSky: OcclusionService = {
  groundElevation: () => 0,
  surfaceHeight: () => 0,
  hasLineOfSight: () => ({ clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 100 }),
  skyVisibility: () => true,
}

describe('GNSS AO coverage (WP-7)', () => {
  it('every AO with a constellation also has committed terrain to occlude it', () => {
    const withTerrain = new Set(scenariosWithTerrain())
    for (const id of CONSTELLATION_IDS) {
      expect(withTerrain.has(id), `${id} has a constellation but no terrain package`).toBe(true)
    }
  })

  // Preparing and decoding the DEM for all 14 constellation AOs in one test comfortably exceeds
  // vitest's 5 s default on a CI runner (it is well under a second locally). Give it a wide
  // explicit budget, the same way the real-PBKDF2 tests do, rather than thinning the coverage.
  it('produces a real, terrain-masked fix at every AO — and masking genuinely occurs somewhere', async () => {
    let totalMaskedLowAltitude = 0

    for (const id of CONSTELLATION_IDS) {
      const prep = await prepareScenarioTerrain(id)
      expect(prep.ok, `${id}: ${prep.ok ? '' : prep.reason}`).toBe(true)

      const fixture = constellationFor(id)!
      const looks = constellationAt(fixture, 0)
      // A real published almanac over any AO puts well over four satellites above the horizon.
      expect(looks.length, `${id} constellation is too sparse`).toBeGreaterThanOrEqual(4)

      const occlusion = occlusionServiceFor(id)
      expect(occlusion, `${id} has no occlusion service`).toBeDefined()

      const ref = fixture.reference
      const ground = occlusion!.groundElevation(ref.lat, ref.lng)

      // 30 m AGL: low enough that surrounding relief and structures can rise into the sightline.
      const common = {
        droneId: 'uav-01',
        position: ref,
        altMslM: ground + 30,
        constellation: looks,
        seed: fixture.startUtc.length,
        tick: 40,
        elapsedSec: 0,
        lastReported: undefined,
      }
      const real = evaluateGnss({ ...common, occlusion: occlusion! })
      const open = evaluateGnss({ ...common, occlusion: openSky })

      // The reported position is a real solution, and truth is never mutated to it.
      expect(Number.isFinite(real.hdop), `${id} produced a non-finite HDOP`).toBe(true)
      // Terrain/structures can only remove satellites, never invent them.
      expect(real.satsVisible, `${id} terrain added satellites`).toBeLessThanOrEqual(open.satsVisible)

      totalMaskedLowAltitude += open.satsVisible - real.satsVisible
    }

    // Flat AOs correctly mask nothing; the AOs with real relief (Oso's landslide valley,
    // the Asheville and Kīlauea slopes) must. Asserting the sum keeps the test robust to which
    // specific AO does the masking while still proving the pairing is not decorative.
    expect(totalMaskedLowAltitude, 'no AO masked any satellite — occlusion is inert').toBeGreaterThan(0)
  }, 30_000)
})
