import { describe, expect, it } from 'vitest'
import { BAY_SPACING_M } from '@/sim/mission/LaunchCoordinator'
import {
  buildAutoLaunchDoctrinePlan,
  buildLaunchBayPlan,
  buildLaunchDoctrineSituation,
  effectiveSiteCapacity,
  evaluateLaunchCandidate,
  weatherGateForSite,
} from '@/sim/mission/launchDoctrine'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { haversineDistanceM } from '@/utils/geometry'
import type { LaunchRecoverySite, ScenarioConfig, WeatherVariantState } from '@/types'

const origin = { lat: 37, lng: -122 }

describe('launch doctrine', () => {
  it('normalizes legacy record keys into stable site ids without mutating input', () => {
    const scenario = makeScenario()
    delete scenario.launchSites!['site-a'].id
    const original = structuredClone(scenario)

    const situation = buildLaunchDoctrineSituation({ scenario, weather: weather() })

    expect(situation.launchSites['site-a'].id).toBe('site-a')
    expect(scenario).toEqual(original)
  })

  it('uses per-site exposure thresholds at exact boundaries', () => {
    const baseSite = makeSite('weather-site', 'semi')
    expect(weatherGateForSite(baseSite, weather({ gustKts: 30, ceilingFt: 200 }))).toBeNull()
    expect(weatherGateForSite(baseSite, weather({ gustKts: 30.01, ceilingFt: 200 }))).toBe('weather_exposure')
    expect(weatherGateForSite(baseSite, weather({ gustKts: 30, ceilingFt: 199 }))).toBe('weather_exposure')
    expect(weatherGateForSite(makeSite('sheltered', 'sheltered'), weather({ gustKts: 35, ceilingFt: 150 }))).toBeNull()
    expect(weatherGateForSite(makeSite('exposed', 'exposed'), weather({ gustKts: 25, ceilingFt: 300 }))).toBeNull()
    expect(weatherGateForSite(baseSite, weather({ activeHazards: ['snow_ice'] }))).toBe('weather_exposure')
  })

  it('is deterministic across reversed site and drone-route record construction', () => {
    const scenario = makeScenario()
    const reversed: ScenarioConfig = {
      ...scenario,
      launchSites: reverseRecord(scenario.launchSites!),
      recoverySites: reverseRecord(scenario.recoverySites!),
      perDroneWaypoints: reverseRecord(scenario.perDroneWaypoints!),
      perDroneMissionRoles: reverseRecord(scenario.perDroneMissionRoles!),
    }

    expect(buildAutoLaunchDoctrinePlan(reversed, weather())).toEqual(buildAutoLaunchDoctrinePlan(scenario, weather()))
  })

  it('rejects unreachable round trips and includes weather speed and drain multipliers', () => {
    const scenario = makeScenario({ batteryStartPct: 26, batteryDrainRatePerSec: 0.05 })
    const normal = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario, weather: weather() }), 'uav-01', 'site-a',
    )
    const adverse = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario, weather: weather({ speedCapMultiplier: 0.5, batteryDrainMultiplier: 2 }) }),
      'uav-01',
      'site-a',
    )

    expect(adverse.batteryRequiredPct).toBeGreaterThan(normal.batteryRequiredPct)
    expect(adverse.rejectedBy).toContain('unreachable')
  })

  it('does not double-count recovery when the route already ends there', () => {
    const recovery = { lat: 37.002, lng: -122 }
    const scenario = makeScenario({
      droneCount: 1,
      perDroneWaypoints: {
        'uav-01': [{ id: 'rtb', position: recovery, altitudeFt: 120 }],
      },
      recoverySites: { recovery: { ...makeSite('recovery'), position: recovery } },
      defaultRecoveryAssignments: { 'uav-01': 'recovery' },
    })
    const candidate = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario, weather: weather() }), 'uav-01', 'site-a',
    )

    expect(candidate.routeDistanceM).toBeCloseTo(haversineDistanceM(scenario.launchSites!['site-a'].position, recovery), 3)
  })

  it('rejects launch points and climb-out corridors that breach active geofences', () => {
    const pointScenario = makeScenario({
      geofences: [{
        id: 'launch-zone', label: 'Launch Zone', type: 'no_fly', maxAltitudeFt: 400,
        polygon: boxAround(origin, 0.0002),
      }],
    })
    const pointCandidate = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario: pointScenario, weather: weather() }), 'uav-01', 'site-a',
    )
    expect(pointCandidate.rejectedBy).toContain('launch_geofence')

    const corridorScenario = makeScenario({
      geofences: [{
        id: 'corridor-zone', label: 'Corridor Zone', type: 'no_fly', maxAltitudeFt: 400,
        polygon: [
          { lat: 37.0004, lng: -122.0002 }, { lat: 37.0006, lng: -122.0002 },
          { lat: 37.0006, lng: -121.9998 }, { lat: 37.0004, lng: -121.9998 },
        ],
      }],
    })
    const corridorCandidate = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario: corridorScenario, weather: weather() }), 'uav-01', 'site-a',
    )
    expect(corridorCandidate.rejectedBy).toContain('climbout_geofence')
  })

  it('surfaces capacity, footprint, and weather reasons on manual assignments', () => {
    const scenario = makeScenario({
      launchSites: {
        constrained: {
          ...makeSite('constrained', 'exposed'), capacityDrones: 1, padFootprintM: 0,
        },
      },
    })
    const plan = buildLaunchBayPlan(scenario, weather({ gustKts: 26 }), {
      'uav-01': 'constrained',
      'uav-02': 'constrained',
    })

    expect(plan.readyToLaunch).toBe(false)
    expect(plan.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining('capacity'),
      expect.stringContaining('pad_footprint'),
      expect.stringContaining('weather_exposure'),
    ]))
    expect(effectiveSiteCapacity(scenario.launchSites!.constrained)).toBe(1)
  })

  it('uses structured preferred assignments without bypassing hard gates', () => {
    const scenario = makeScenario({
      defaultLaunchAssignments: { 'uav-01': 'site-b' },
    })
    const situation = buildLaunchDoctrineSituation({ scenario, weather: weather() })
    const preferred = evaluateLaunchCandidate(situation, 'uav-01', 'site-b')
    const other = evaluateLaunchCandidate(situation, 'uav-01', 'site-a')
    expect(preferred.score.authoredIntent).toBe(15)
    expect(other.score.authoredIntent).toBe(0)

    const closed = evaluateLaunchCandidate(
      buildLaunchDoctrineSituation({ scenario, weather: weather({ activeHazards: ['snow_ice'] }) }),
      'uav-01',
      'site-b',
    )
    expect(closed.rejectedBy).toContain('weather_exposure')
  })

  it('matches relay and rapid-response roles to deterministic doctrine sites', () => {
    const scenario = makeScenario({
      launchSites: {
        rooftop: { ...makeSite('rooftop'), kind: 'police_rooftop', position: { lat: 37, lng: -122.0001 } },
        mobile: { ...makeSite('mobile'), kind: 'mobile_command', position: { lat: 37, lng: -122.0001 } },
      },
      perDroneMissionRoles: {
        'uav-01': 'C2 Relay Overwatch',
        'uav-02': 'Rapid Response Intercept',
      },
    })

    expect(buildAutoLaunchDoctrinePlan(scenario, weather()).assignments).toEqual({
      'uav-01': 'rooftop',
      'uav-02': 'mobile',
    })
  })

  it('fans shared-site assignments at the separation minimum and stays serializable', () => {
    const scenario = makeScenario({
      launchSites: {
        shared: { ...makeSite('shared'), capacityDrones: 2, padFootprintM: BAY_SPACING_M },
      },
    })
    const plan = buildLaunchBayPlan(scenario, weather(), { 'uav-01': 'shared', 'uav-02': 'shared' })
    const left = plan.assignmentDetails!['uav-01'].bay
    const right = plan.assignmentDetails!['uav-02'].bay

    expect(plan.readyToLaunch).toBe(true)
    expect(haversineDistanceM(left, right)).toBeCloseTo(BAY_SPACING_M, 1)
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('uses stable candidate ids to break otherwise equal assignment ties', () => {
    const scenario = makeScenario({
      droneCount: 1,
      launchSites: {
        alpha: makeSite('alpha'),
        bravo: makeSite('bravo'),
      },
    })
    expect(buildAutoLaunchDoctrinePlan(scenario, weather()).assignments['uav-01']).toBe('alpha')
  })
})

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'launch-doctrine-test',
    name: 'Launch Doctrine Test',
    description: 'Deterministic launch doctrine fixture',
    seed: 7,
    droneCount: 2,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [{ id: 'task', position: { lat: 37.001, lng: -122 }, altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 'task-a', position: { lat: 37.001, lng: -122 }, altitudeFt: 120 }],
      'uav-02': [{ id: 'task-b', position: { lat: 37.001, lng: -122 }, altitudeFt: 120 }],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.002,
    commsLossWindows: [],
    launchSites: {
      'site-a': makeSite('site-a'),
      'site-b': makeSite('site-b'),
    },
    recoverySites: {
      'uav-01': { ...makeSite('uav-01'), position: { lat: 37.002, lng: -122 } },
      'uav-02': { ...makeSite('uav-02'), position: { lat: 37.002, lng: -122 } },
    },
    perDroneMissionRoles: { 'uav-01': 'Primary sector', 'uav-02': 'Secondary sector' },
    ...overrides,
  }
}

function makeSite(id: string, exposure: LaunchRecoverySite['exposure'] = 'semi'): LaunchRecoverySite {
  return {
    id,
    kind: 'field_icp',
    label: id,
    agency: 'UAS OPS',
    position: origin,
    surfaceNote: 'Test pad',
    capacityDrones: 2,
    exposure,
    padFootprintM: BAY_SPACING_M,
  }
}

function weather(overrides: Partial<WeatherVariantState> = {}): WeatherVariantState {
  return {
    ...getDefaultWeatherState(7),
    activeHazards: [],
    windKts: 0,
    gustKts: 0,
    ceilingFt: 1_000,
    batteryDrainMultiplier: 1,
    speedCapMultiplier: 1,
    ...overrides,
  }
}

function reverseRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).reverse())
}

function boxAround(center: typeof origin, delta: number) {
  return [
    { lat: center.lat - delta, lng: center.lng - delta },
    { lat: center.lat + delta, lng: center.lng - delta },
    { lat: center.lat + delta, lng: center.lng + delta },
    { lat: center.lat - delta, lng: center.lng + delta },
  ]
}
