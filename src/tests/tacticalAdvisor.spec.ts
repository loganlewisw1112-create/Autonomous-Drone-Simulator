import { describe, expect, it } from 'vitest'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { getMissionSafetyOverride } from '@/sim/mission/MissionManager'
import { validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import {
  buildMissionSituation,
  planFleetRetask,
  type MissionSituationInput,
} from '@/sim/mission/tacticalAdvisor'
import type {
  DispatchFeedEntry,
  DroneState,
  ScenarioConfig,
  WeatherVariantState,
} from '@/types'

const origin = { lat: 37, lng: -122 }

function makeScenario(): ScenarioConfig {
  return {
    id: 'advisor-test',
    name: 'Advisor Test',
    description: 'Deterministic tactical planning fixture',
    seed: 7,
    droneCount: 2,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [{ id: 'base-route', position: { lat: 37.001, lng: -121.999 }, altitudeFt: 120 }],
    perDroneWaypoints: {
      'uav-01': [{ id: 'uav-01-route', position: { lat: 37.001, lng: -121.999 }, altitudeFt: 120 }],
      'uav-02': [{ id: 'uav-02-route', position: { lat: 37.0012, lng: -121.999 }, altitudeFt: 120 }],
    },
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.002,
    commsLossWindows: [],
    operationalFeatures: [
      { id: 'street', type: 'street', label: 'Main Street', points: [{ lat: 37.001, lng: -121.998 }], priority: 'routine' },
      { id: 'perimeter', type: 'perimeter', label: 'Outer Perimeter', points: [{ lat: 37.002, lng: -121.998 }] },
      { id: 'relay', type: 'relay', label: 'Relay Ridge', points: [{ lat: 37.0015, lng: -122.001 }] },
      { id: 'last-known', type: 'last_known', label: 'Last Known', points: [{ lat: 37.002, lng: -122.001 }], priority: 'urgent' },
      { id: 'sector', type: 'search_sector', label: 'Search Sector', points: [{ lat: 37.0025, lng: -122 }] },
      { id: 'hazard', type: 'hazard', label: 'Hazard', points: [{ lat: 37.001, lng: -122.002 }] },
    ],
    rechargeStations: [{
      id: 'station-a',
      label: 'Station A',
      position: { lat: 37.0002, lng: -122.0002 },
      road: 'Access Road',
      agency: 'UAS OPS',
    }],
    perDroneRechargeStationIds: {
      'uav-01': ['station-a'],
      'uav-02': ['station-a'],
    },
  }
}

function makeDrone(id: string, overrides: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#fff',
    position: { ...origin, lng: origin.lng + (id === 'uav-02' ? 0.0001 : 0) },
    altitudeFt: 120,
    headingDeg: 0,
    speedMs: 8,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...overrides,
  }
}

function situationInput(overrides: Partial<MissionSituationInput> = {}): MissionSituationInput {
  const scenario = makeScenario()
  return {
    scenario,
    drones: [makeDrone('uav-01'), makeDrone('uav-02')],
    droneWaypoints: scenario.perDroneWaypoints,
    tick: 1_000,
    elapsedSec: 50,
    unresolvedContacts: [
      { sourceId: 'contact-a', class: 'generic-person', position: { lat: 37.003, lng: -121.999 }, confidence: 0.9, tick: 980 },
      { sourceId: 'contact-b', class: 'vehicle', position: { lat: 37.002, lng: -122.002 }, confidence: 0.7, tick: 900 },
      { sourceId: 'contact-c', class: 'heat-source', position: { lat: 37.004, lng: -122 }, confidence: 0.6, tick: 800 },
    ],
    dispatchEntries: [makeDispatch('active', 40), makeDispatch('future', 80)],
    weather: getDefaultWeatherState(scenario.seed),
    positionHistory: {
      'uav-01': [origin, { lat: 37.0005, lng: -122 }],
      'uav-02': [origin, { lat: 37, lng: -121.9995 }],
    },
    ...overrides,
  }
}

function makeDispatch(id: string, timeSec: number): DispatchFeedEntry {
  return {
    id,
    timeSec,
    source: 'DISPATCH',
    priority: 'urgent',
    message: `Dispatch ${id}`,
    kind: 'authored',
    category: 'operator_task',
  }
}

describe('tactical advisor core', () => {
  it('is deterministic across repeated calls and input-order permutations', () => {
    const input = situationInput()
    const reversedScenario = {
      ...input.scenario,
      operationalFeatures: [...(input.scenario.operationalFeatures ?? [])].reverse(),
      rechargeStations: [...(input.scenario.rechargeStations ?? [])].reverse(),
    }
    const reversed = situationInput({
      scenario: reversedScenario,
      drones: [...input.drones].reverse(),
      droneWaypoints: Object.fromEntries(Object.entries(input.droneWaypoints ?? {}).reverse()),
      unresolvedContacts: [...(input.unresolvedContacts ?? [])].reverse(),
      dispatchEntries: [...(input.dispatchEntries ?? [])].reverse(),
      positionHistory: Object.fromEntries(Object.entries(input.positionHistory ?? {}).reverse()),
    })

    const first = planFleetRetask(buildMissionSituation(input))
    expect(planFleetRetask(buildMissionSituation(input))).toEqual(first)
    expect(planFleetRetask(buildMissionSituation(reversed))).toEqual(first)
  })

  it('reserves stable candidate slots and never exceeds eight per drone', () => {
    const plan = planFleetRetask(buildMissionSituation(situationInput({ drones: [makeDrone('uav-01')] })))
    const candidates = plan.candidatesByDrone['uav-01']

    expect(candidates).toHaveLength(8)
    expect(candidates.slice(0, 3).map((candidate) => candidate.action)).toEqual([
      'hold_station',
      'route_recharge',
      'rtb_now',
    ])
    expect(candidates.filter((candidate) => candidate.action === 'deep_scan').slice(0, 2)).toHaveLength(2)
  })

  it('uses a true no-op hold and positive, subtractive score terms', () => {
    const plan = planFleetRetask(buildMissionSituation(situationInput({ drones: [makeDrone('uav-01')] })))
    const hold = plan.candidatesByDrone['uav-01'][0]

    expect(hold.action).toBe('hold_station')
    expect(hold.route).toEqual([])
    expect(hold.requiredBatteryPct).toBe(0)
    expect(hold.score).toEqual(expect.objectContaining({
      valueGain: expect.any(Number),
      transitCost: expect.any(Number),
      riskPenalty: expect.any(Number),
      continuityPenalty: expect.any(Number),
      redundancyPenalty: 0,
    }))
    expect(hold.score.total).toBeCloseTo(
      hold.score.valueGain - hold.score.transitCost - hold.score.riskPenalty - hold.score.continuityPenalty,
      4,
    )
  })

  it('skips non-retaskable and reserve, geofence-flag, and weather-overridden drones', () => {
    const weather = {
      ...getDefaultWeatherState(7),
      gustKts: 30,
    } satisfies WeatherVariantState
    const cases: Array<{
      drone: DroneState
      weather?: WeatherVariantState
      reason: 'not_retaskable' | 'critical_battery' | 'battery_reserve' | 'geofence_breach' | 'weather'
    }> = [
      { drone: makeDrone('uav-01', { missionState: 'landed' }), reason: 'not_retaskable' },
      { drone: makeDrone('uav-01', { batteryPct: 5 }), reason: 'critical_battery' },
      { drone: makeDrone('uav-01', { batteryPct: 20 }), reason: 'battery_reserve' },
      { drone: makeDrone('uav-01', { geofenceBreachFlag: true }), reason: 'geofence_breach' },
      { drone: makeDrone('uav-01'), weather, reason: 'weather' },
    ]

    for (const item of cases) {
      const plan = planFleetRetask(buildMissionSituation(situationInput({
        drones: [item.drone],
        weather: item.weather ?? getDefaultWeatherState(7),
      })))
      expect(plan.candidatesByDrone['uav-01']).toEqual([])
      expect(plan.skippedDrones).toEqual([{ droneId: 'uav-01', reason: item.reason }])
    }
  })

  it('matches the mission safety override at the exact 25 percent reserve boundary', () => {
    for (const batteryPct of [24.99, 25]) {
      const drone = makeDrone('uav-01', { batteryPct })
      const override = getMissionSafetyOverride(drone, { batteryReservePct: 25, weatherForceRtb: false })
      const plan = planFleetRetask(buildMissionSituation(situationInput({ drones: [drone] })))
      const advisorSkipped = plan.skippedDrones.some((item) => item.droneId === drone.id)

      expect(advisorSkipped).toBe(override !== null)
      if (batteryPct === 25) expect(plan.candidatesByDrone[drone.id][0].action).toBe('hold_station')
    }
  })

  it('hard-gates routed candidates that cannot pass the live-position geofence audit', () => {
    const scenario = makeScenario()
    scenario.geofences = [{
      id: 'occupied-zone',
      label: 'Occupied Zone',
      type: 'no_fly',
      maxAltitudeFt: 400,
      polygon: [
        { lat: 36.999, lng: -122.001 },
        { lat: 36.999, lng: -121.999 },
        { lat: 37.001, lng: -121.999 },
        { lat: 37.001, lng: -122.001 },
      ],
    }]
    const plan = planFleetRetask(buildMissionSituation(situationInput({ scenario, drones: [makeDrone('uav-01')] })))

    expect(plan.candidatesByDrone['uav-01'].map((candidate) => candidate.action)).toEqual(['hold_station'])
  })

  it('hard-gates objectives that cannot meet reserve after task and recovery energy', () => {
    const scenario = makeScenario()
    scenario.batteryDrainRatePerSec = 0.02
    const farContact = {
      sourceId: 'far',
      class: 'generic-person' as const,
      position: { lat: 37.1, lng: -122 },
      confidence: 1,
      tick: 1_000,
    }
    const plan = planFleetRetask(buildMissionSituation(situationInput({
      scenario,
      drones: [makeDrone('uav-01', { batteryPct: 26 })],
      unresolvedContacts: [farContact],
    })))

    expect(plan.candidatesByDrone['uav-01'].some((candidate) => candidate.objectiveId === 'contact:far')).toBe(false)
    expect(plan.candidatesByDrone['uav-01'][0].action).toBe('hold_station')
  })

  it('builds and audits routed candidates from the live aircraft position', () => {
    const scenario = makeScenario()
    scenario.geofences = [{
      id: 'live-leg-blocker',
      label: 'Live Leg Blocker',
      type: 'no_fly',
      maxAltitudeFt: 400,
      polygon: [
        { lat: 36.999, lng: -121.996 },
        { lat: 36.999, lng: -121.994 },
        { lat: 37.001, lng: -121.994 },
        { lat: 37.001, lng: -121.996 },
      ],
    }]
    const live = makeDrone('uav-01')
    const plan = planFleetRetask(buildMissionSituation(situationInput({
      scenario,
      drones: [live],
      unresolvedContacts: [{
        sourceId: 'east',
        class: 'generic-person',
        position: { lat: 37, lng: -121.99 },
        confidence: 1,
        tick: 1_000,
      }],
    })))
    const contact = plan.candidatesByDrone['uav-01'].find((candidate) => candidate.objectiveId === 'contact:east')

    expect(contact).toBeDefined()
    expect(contact!.route.length).toBeGreaterThan(5)
    expect(validateOperatorRoute(scenario, live.id, contact!.route, live.position).accepted).toBe(true)
  })

  it('uses elapsed-time dispatch filtering and deterministic contact recency', () => {
    const scenario = makeScenario()
    scenario.dispatchTimeline = [
      { id: 'authored-now', timeSec: 10, source: 'IC', priority: 'urgent', category: 'operator_task', message: 'Act now' },
      { id: 'authored-later', timeSec: 100, source: 'IC', priority: 'critical', category: 'operator_task', message: 'Future' },
    ]
    const situation = buildMissionSituation(situationInput({
      scenario,
      dispatchEntries: undefined,
      unresolvedContacts: [
        { sourceId: 'new', class: 'generic-person', position: origin, confidence: 0.8, tick: 999 },
        { sourceId: 'old', class: 'generic-person', position: origin, confidence: 0.8, tick: 0 },
      ],
    }))

    expect(situation.objectives.some((objective) => objective.id === 'dispatch:authored-now')).toBe(true)
    expect(situation.objectives.some((objective) => objective.id === 'dispatch:authored-later')).toBe(false)
    expect(situation.objectives.find((objective) => objective.id === 'contact:new')!.value)
      .toBeGreaterThan(situation.objectives.find((objective) => objective.id === 'contact:old')!.value)
  })

  it('applies a documented redundancy penalty under a single dominant objective', () => {
    const scenario = makeScenario()
    scenario.operationalFeatures = []
    const plan = planFleetRetask(buildMissionSituation(situationInput({
      scenario,
      dispatchEntries: [],
      unresolvedContacts: [{
        sourceId: 'only',
        class: 'generic-person',
        position: { lat: 37.001, lng: -122 },
        confidence: 1,
        tick: 1_000,
      }],
    })))

    expect(plan.assignments).toHaveLength(2)
    expect(plan.assignments.every((assignment) => assignment.objectiveId === 'contact:only')).toBe(true)
    expect(plan.assignments.every((assignment) => assignment.score.redundancyPenalty > 0)).toBe(true)
  })

  it('selects distinct equal-value objectives when the redundancy cost makes that beneficial', () => {
    const scenario = makeScenario()
    scenario.operationalFeatures = []
    scenario.rechargeStations = []
    scenario.perDroneRechargeStationIds = {}
    const west = makeDrone('uav-01', { position: { lat: 37, lng: -122.01 } })
    const east = makeDrone('uav-02', { position: { lat: 37, lng: -121.99 } })
    const plan = planFleetRetask(buildMissionSituation(situationInput({
      scenario,
      drones: [west, east],
      dispatchEntries: [],
      unresolvedContacts: [
        { sourceId: 'west', class: 'generic-person', position: west.position, confidence: 1, tick: 1_000 },
        { sourceId: 'east', class: 'generic-person', position: east.position, confidence: 1, tick: 1_000 },
      ],
    })))

    expect(new Set(plan.assignments.map((assignment) => assignment.objectiveId))).toEqual(
      new Set(['contact:west', 'contact:east']),
    )
    expect(plan.assignments.every((assignment) => assignment.score.redundancyPenalty === 0)).toBe(true)
  })

  it('breaks equal-score assignment ties by stable drone and candidate identifiers', () => {
    const scenario = makeScenario()
    scenario.geofences = [{
      id: 'tie-zone',
      label: 'Tie Zone',
      type: 'no_fly',
      maxAltitudeFt: 400,
      polygon: [
        { lat: 36.999, lng: -122.001 },
        { lat: 36.999, lng: -121.999 },
        { lat: 37.001, lng: -121.999 },
        { lat: 37.001, lng: -122.001 },
      ],
    }]
    const drones = [makeDrone('uav-02', { position: origin }), makeDrone('uav-01', { position: origin })]
    const plan = planFleetRetask(buildMissionSituation(situationInput({ scenario, drones })))

    expect(plan.assignments.map(({ droneId, id }) => [droneId, id])).toEqual([
      ['uav-01', 'uav-01|hold_station|hold:uav-01'],
      ['uav-02', 'uav-02|hold_station|hold:uav-02'],
    ])
  })

  it('chooses the lowest candidate id when one drone has equal-scoring objectives', () => {
    const scenario = makeScenario()
    scenario.operationalFeatures = []
    scenario.rechargeStations = []
    scenario.perDroneRechargeStationIds = {}
    const plan = planFleetRetask(buildMissionSituation(situationInput({
      scenario,
      drones: [makeDrone('uav-01')],
      dispatchEntries: [],
      unresolvedContacts: [
        { sourceId: 'b', class: 'generic-person', position: { lat: 37.001, lng: -122 }, confidence: 1, tick: 1_000 },
        { sourceId: 'a', class: 'generic-person', position: { lat: 37.001, lng: -122 }, confidence: 1, tick: 1_000 },
      ],
    })))

    expect(plan.assignments[0].objectiveId).toBe('contact:a')
  })

  it('does not mutate deeply frozen mission inputs', () => {
    const input = situationInput()
    deepFreeze(input)

    expect(() => planFleetRetask(buildMissionSituation(input))).not.toThrow()
  })
})

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  }
  return value
}
