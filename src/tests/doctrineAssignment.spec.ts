import { describe, it, expect } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { PLATFORM_CATALOG, type PlatformId } from '@/sim/drone/platformCatalog'
import { mixedFleet, explicitFleet, droneIdAt } from '@/scenarios/platformAssignments'

const VALID_IDS = new Set(Object.keys(PLATFORM_CATALOG))

function platformsOf(scenarioId: string): Record<string, PlatformId> {
  const scenario = ALL_SCENARIOS.find((s) => s.id === scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  if (!scenario.dronePlatforms) throw new Error(`${scenarioId} has no dronePlatforms`)
  return scenario.dronePlatforms
}

describe('platformAssignments helpers', () => {
  it('mixedFleet assigns the secondary platform on every Nth slot', () => {
    expect(mixedFleet(5, 'skydio_x10', 'parrot_anafi_usa')).toEqual({
      'uav-01': 'skydio_x10',
      'uav-02': 'skydio_x10',
      'uav-03': 'parrot_anafi_usa',
      'uav-04': 'skydio_x10',
      'uav-05': 'skydio_x10',
    })
  })

  it('mixedFleet with no secondary produces a uniform fleet', () => {
    const fleet = mixedFleet(4, 'skydio_x10d')
    expect(Object.values(fleet)).toEqual(Array(4).fill('skydio_x10d'))
  })

  it('explicitFleet maps a per-slot list onto zero-padded ids', () => {
    expect(explicitFleet(['brinc_lemur_2', 'skydio_x10'])).toEqual({
      'uav-01': 'brinc_lemur_2',
      'uav-02': 'skydio_x10',
    })
  })
})

describe('scenario platform doctrine', () => {
  it('covers all 21 catalog scenarios', () => {
    expect(ALL_SCENARIOS).toHaveLength(21)
  })

  it('every scenario assigns a platform to exactly uav-01..uav-NN', () => {
    for (const scenario of ALL_SCENARIOS) {
      expect(scenario.dronePlatforms, `${scenario.id} missing dronePlatforms`).toBeDefined()
      const expectedIds = Array.from({ length: scenario.droneCount }, (_, i) => droneIdAt(i))
      expect(Object.keys(scenario.dronePlatforms!).sort(), scenario.id).toEqual(expectedIds.sort())
    }
  })

  it('every assigned platform id exists in the catalog', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const [droneId, platformId] of Object.entries(scenario.dronePlatforms ?? {})) {
        expect(VALID_IDS.has(platformId), `${scenario.id}/${droneId} → ${platformId}`).toBe(true)
      }
    }
  })

  it('never assigns a federally banned vendor', () => {
    for (const scenario of ALL_SCENARIOS) {
      for (const platformId of Object.values(scenario.dronePlatforms ?? {})) {
        expect(PLATFORM_CATALOG[platformId].vendor.toLowerCase()).not.toContain('dji')
      }
    }
  })

  // ── Doctrine-specific expectations ────────────────────────────────────────
  it('urban scenarios field Skydio X10 primaries', () => {
    const urban = [
      'demo_suspect_search', 'demo_vehicle_pursuit', 'extreme_lapd_hollywood_bowl',
      'extreme_multiagency_sf_pursuit', 'extreme_nypd_times_sq_mci',
      'extreme_lapd_skid_row_welfare', 'extreme_atf_oakland_stash',
    ]
    for (const id of urban) {
      expect(Object.values(platformsOf(id)), id).toContain('skydio_x10')
    }
  })

  it('the HRT compound puts BRINC Lemur 2s on interior entry', () => {
    const fleet = platformsOf('extreme_fbi_hrt_compound')
    expect(fleet['uav-01']).toBe('brinc_lemur_2')
    expect(fleet['uav-02']).toBe('brinc_lemur_2')
    expect(Object.values(fleet)).toContain('skydio_x10')
  })

  it('fire scenarios field thermal-capable Teal 2s', () => {
    for (const id of ['demo_wildfire', 'extreme_cal_fire_dixie']) {
      expect(Object.values(platformsOf(id)), id).toContain('teal_2')
    }
  })

  it('border scenarios fly a uniform weatherproof X10D line', () => {
    for (const id of ['extreme_cbp_eagle_pass', 'extreme_cbp_rio_grande_longrange']) {
      expect(new Set(Object.values(platformsOf(id))), id).toEqual(new Set(['skydio_x10d']))
    }
  })

  it('Rio Grande keeps its tuned battery profile alongside platform assignments', () => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === 'extreme_cbp_rio_grande_longrange')!
    expect(scenario.dronePlatforms).toBeDefined()
    // The explicit fleet battery profile must survive — rechargeStations gives it
    // precedence over the platform endurance multiplier.
    expect(scenario.batteryProfile?.enduranceMultiplier).toBe(1.6)
  })
})
