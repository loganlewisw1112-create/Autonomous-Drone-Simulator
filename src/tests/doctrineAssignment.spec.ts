import { describe, it, expect } from 'vitest'
import { INCIDENT_MISSION_COUNT, INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import { PLATFORM_CATALOG, type PlatformId } from '@/sim/drone/platformCatalog'
import { mixedFleet, explicitFleet, droneIdAt } from '@/scenarios/platformAssignments'

const VALID_IDS = new Set(Object.keys(PLATFORM_CATALOG))

function platformsOf(scenarioId: string): Record<string, PlatformId> {
  const scenario = INCIDENT_SCENARIOS.find((s) => s.id === scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  if (!scenario.dronePlatforms) throw new Error(`${scenario.id} has no dronePlatforms`)
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
  it('covers all incident catalog scenarios', () => {
    expect(INCIDENT_SCENARIOS).toHaveLength(INCIDENT_MISSION_COUNT)
  })

  it('every scenario assigns a platform to exactly uav-01..uav-NN', () => {
    for (const scenario of INCIDENT_SCENARIOS) {
      expect(scenario.dronePlatforms, `${scenario.id} missing dronePlatforms`).toBeDefined()
      const expectedIds = Array.from({ length: scenario.droneCount }, (_, i) => droneIdAt(i))
      expect(Object.keys(scenario.dronePlatforms!).sort(), scenario.id).toEqual(expectedIds.sort())
    }
  })

  it('every assigned platform id exists in the catalog', () => {
    for (const scenario of INCIDENT_SCENARIOS) {
      for (const [droneId, platformId] of Object.entries(scenario.dronePlatforms ?? {})) {
        expect(VALID_IDS.has(platformId), `${scenario.id}/${droneId} → ${platformId}`).toBe(true)
      }
    }
  })

  it('never assigns a federally banned vendor', () => {
    for (const scenario of INCIDENT_SCENARIOS) {
      for (const platformId of Object.values(scenario.dronePlatforms ?? {})) {
        expect(PLATFORM_CATALOG[platformId].vendor.toLowerCase()).not.toContain('dji')
      }
    }
  })

  it('urban/welfare scenarios field Skydio X10-family primaries', () => {
    expect(Object.values(platformsOf('train_welfare_grid')), 'train_welfare_grid').toContain('skydio_x10')
    expect(Object.values(platformsOf('train_night_relay_sar')), 'train_night_relay_sar').toContain('skydio_x10d')
    expect(Object.values(platformsOf('train_urban_usar')), 'train_urban_usar').toContain('skydio_x10d')
  })

  it('maritime SAR fields weatherproof X10D search ships', () => {
    expect(Object.values(platformsOf('train_uscg_maritime_sar'))).toContain('skydio_x10d')
  })

  it('fire scenarios field thermal-capable Teal 2s', () => {
    for (const id of ['demo_wildfire', 'train_wildfire_flank']) {
      expect(Object.values(platformsOf(id)), id).toContain('teal_2')
    }
  })

  it('historical flood scenario carries TFR authorization profile', () => {
    const harvey = INCIDENT_SCENARIOS.find((s) => s.id === 'hist_harvey_houston_2017')!
    expect(harvey.authorizationProfile?.tfrExercise).toBeTruthy()
  })
})
