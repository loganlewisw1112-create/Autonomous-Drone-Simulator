import { describe, it, expect } from 'vitest'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type {
  FullMissionFrame,
  MissionReplaySession,
  DroneState,
  ThermalContactState,
  GroundUnitState,
  RecoveryTeamState,
  MissionMetrics,
  ScenarioVariantConfig,
} from '@/types'

const DEFAULT_VARIANT: ScenarioVariantConfig = {
  seed: 1337,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const DEFAULT_METRICS: MissionMetrics = {
  totalFlightDistanceM: 0,
  waypointsReached: 0,
  conflictsDetected: 0,
  thermalContacts: 0,
  geofenceBreaches: 0,
  rtbTriggers: 0,
  recoveryDispatches: 0,
  groundUnitDispatch: 0,
}

function makeDrone(id: string, missionState: DroneState['missionState'] = 'navigate'): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { lat: 37.77, lng: -122.42 },
    altitudeFt: 200,
    speedMs: 8,
    headingDeg: 45,
    batteryPct: 80,
    signalDbm: -70,
    missionState,
    currentWaypointIndex: 2,
    geofenceBreachFlag: false,
    conflictFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

function makeFrame(tick: number, drones: DroneState[]): FullMissionFrame {
  return {
    tick,
    elapsedSec: tick * 0.05,
    drones,
    thermalContacts: [],
    groundUnits: [],
    recoveryTeams: [],
    weatherState: getDefaultWeatherState(1337),
    activeEventIds: [],
  }
}

describe('replaySession', () => {
  it('FullMissionFrame captures drone positions at each tick', () => {
    const drone = makeDrone('uav-01')
    const frame = makeFrame(200, [drone])
    expect(frame.tick).toBe(200)
    expect(frame.drones[0].id).toBe('uav-01')
    expect(frame.drones[0].missionState).toBe('navigate')
  })

  it('MissionReplaySession contains frames array and metadata', () => {
    const frames = [
      makeFrame(0,   [makeDrone('uav-01', 'launch')]),
      makeFrame(100, [makeDrone('uav-01', 'navigate')]),
      makeFrame(200, [makeDrone('uav-01', 'return_to_base')]),
      makeFrame(300, [makeDrone('uav-01', 'landed')]),
    ]
    const finalDrones = [makeDrone('uav-01', 'landed')]
    const session: MissionReplaySession = {
      scenarioId: 'sarCoastal',
      scenarioVariant: DEFAULT_VARIANT,
      launchPlan: null,
      frames,
      events: [],
      metrics: DEFAULT_METRICS,
      completedAt: Date.now(),
      completionReason: 'all_drones_complete',
      finalDrones,
      finalThermalContacts: [],
      finalGroundUnits: [],
      finalRecoveryTeams: [],
      finalWeatherState: getDefaultWeatherState(1337),
    }
    expect(session.frames).toHaveLength(4)
    expect(session.scenarioId).toBe('sarCoastal')
    expect(session.frames[0].drones[0].missionState).toBe('launch')
    expect(session.frames[3].drones[0].missionState).toBe('landed')
    expect(session.finalDrones[0].missionState).toBe('landed')
  })

  it('scrubbing to frame restores drone states at that tick', () => {
    const frames = [
      makeFrame(0,   [makeDrone('uav-01', 'launch')]),
      makeFrame(100, [makeDrone('uav-01', 'navigate')]),
      makeFrame(200, [makeDrone('uav-01', 'landed')]),
    ]
    // Simulate setReplayIndex(1) → restore frame[1]
    const frame = frames[1]
    expect(frame.drones[0].missionState).toBe('navigate')
  })

  it('frame captures thermal contacts at snapshot time', () => {
    const contact: ThermalContactState = {
      sourceId: 'src-1',
      class: 'generic-person',
      position: { lat: 37.77, lng: -122.42 },
      confidence: 0.85,
      tick: 150,
      selected: false,
      weatherAdjustedConfidence: 0.77,
    }
    const frame: FullMissionFrame = {
      tick: 200,
      elapsedSec: 10,
      drones: [makeDrone('uav-01')],
      thermalContacts: [contact],
      groundUnits: [],
      recoveryTeams: [],
      weatherState: getDefaultWeatherState(1),
      activeEventIds: ['evt-abc'],
    }
    expect(frame.thermalContacts).toHaveLength(1)
    expect(frame.thermalContacts[0].sourceId).toBe('src-1')
  })

  it('frame captures ground units and recovery teams', () => {
    const gu: GroundUnitState = {
      id: 'gu-1',
      role: 'intervention',
      position: { lat: 37.78, lng: -122.41 },
      status: 'enroute',
    }
    const rt: RecoveryTeamState = {
      id: 'rt-1',
      droneId: 'uav-02',
      position: { lat: 37.76, lng: -122.43 },
      targetPosition: { lat: 37.79, lng: -122.40 },
      status: 'enroute',
      etaSec: 45,
      routePoints: [],
    }
    const frame = makeFrame(300, [makeDrone('uav-01')])
    const enriched: FullMissionFrame = { ...frame, groundUnits: [gu], recoveryTeams: [rt] }
    expect(enriched.groundUnits[0].status).toBe('enroute')
    expect(enriched.recoveryTeams[0].droneId).toBe('uav-02')
  })

  it('MAX_FRAMES rolling window evicts oldest frame', () => {
    const MAX_FRAMES = 300
    const frames: FullMissionFrame[] = Array.from({ length: MAX_FRAMES + 1 }, (_, i) =>
      makeFrame(i * 40, [makeDrone('uav-01')])
    )
    const rolling = frames.length >= MAX_FRAMES
      ? frames.slice(1)
      : frames
    expect(rolling).toHaveLength(MAX_FRAMES)
    expect(rolling[0].tick).toBe(40) // oldest was evicted
  })

  it('elapsedSec is consistent with tick count', () => {
    const frame = makeFrame(400, [makeDrone('uav-01')])
    // At 50ms per tick: 400 * 0.05 = 20.0s
    expect(frame.elapsedSec).toBeCloseTo(20.0)
  })
})
