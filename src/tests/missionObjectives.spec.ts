import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import {
  buildMissionProgress,
  resolveMissionObjectives,
} from '@/sim/mission/missionObjectives'
import type { DroneState, MissionEvent, ScenarioConfig, ThermalContactState } from '@/types'

const origin = { lat: 37, lng: -122 }

function scenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'objective-test',
    name: 'Objective Test',
    description: 'Objective test fixture',
    seed: 1,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    ...overrides,
  }
}

function drone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01',
    label: 'UAV-01',
    color: '#fff',
    position: origin,
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
    sortieCount: 1,
    launchTimeSec: 0,
    ...overrides,
  }
}

function contact(sourceId: string, resolved: boolean): ThermalContactState {
  return {
    sourceId,
    class: 'generic-person',
    position: origin,
    confidence: 0.9,
    weatherAdjustedConfidence: 0.9,
    tick: 1,
    selected: false,
    ...(resolved ? { action: 'resolve' as const, resolvedAt: 2 } : {}),
  }
}

function operatorEvent(objectiveId: string): MissionEvent {
  return {
    tick: 2,
    timestamp: 2,
    droneId: 'uav-01',
    operatorId: 'operator',
    role: 'pic',
    eventType: 'operator_command',
    payload: { objectiveId },
    prevHash: '0',
    hash: '1',
  }
}

describe('mission objectives', () => {
  it('derives a normalized objective set for all 21 catalog scenarios', () => {
    expect(ALL_SCENARIOS).toHaveLength(21)
    for (const item of ALL_SCENARIOS) {
      const objectives = resolveMissionObjectives(item)
      expect(objectives.length).toBeGreaterThan(0)
      expect(objectives.some((objective) => objective.kind === 'fleet_recovery')).toBe(true)
      expect(objectives.reduce((sum, objective) => sum + objective.weight, 0)).toBeCloseTo(1, 10)
      if (item.heatSources.length > 0) {
        expect(objectives.some((objective) => objective.kind === 'contact_resolution')).toBe(true)
      }
      if ((item.searchArea?.length ?? 0) >= 3) {
        expect(objectives.some((objective) => objective.kind === 'sector_coverage')).toBe(true)
      }
    }
  })

  it('uses declared objectives as a deterministic override', () => {
    const item = scenario({
      heatSources: [{ id: 'person', class: 'generic-person', position: origin, tempC: 37, radiusM: 1 }],
      missionObjectives: [
        { id: 'recovery', kind: 'fleet_recovery', label: 'Recover', weight: 1 },
        { id: 'priority-contact', kind: 'contact_resolution', label: 'Find person', weight: 3, sourceIds: ['z', 'person', 'person'] },
      ],
    })
    expect(resolveMissionObjectives(item)).toEqual([
      { id: 'priority-contact', kind: 'contact_resolution', label: 'Find person', weight: 0.75, sourceIds: ['person', 'z'], target: undefined },
      { id: 'recovery', kind: 'fleet_recovery', label: 'Recover', weight: 0.25, sourceIds: undefined, target: undefined },
    ])
  })

  it('computes weighted objective progress independent of route replacement', () => {
    const item = scenario({
      heatSources: [{ id: 'person', class: 'generic-person', position: origin, tempC: 37, radiusM: 1 }],
      missionObjectives: [
        { id: 'contact', kind: 'contact_resolution', label: 'Resolve', weight: 3 },
        { id: 'recovery', kind: 'fleet_recovery', label: 'Recover', weight: 1 },
      ],
    })
    const progress = buildMissionProgress({
      scenario: item,
      drones: [drone()],
      thermalContacts: [contact('person', true)],
      positionHistory: { 'uav-01': [origin, { lat: 37.001, lng: -122 }] },
    })
    expect(progress.percent).toBe(75)
  })

  it('tracks due task service and containment visits deterministically', () => {
    const item = scenario({
      dispatchTimeline: [
        { id: 'now', timeSec: 10, source: 'OPS', priority: 'urgent', category: 'operator_task', message: 'Now' },
        { id: 'later', timeSec: 100, source: 'OPS', priority: 'urgent', category: 'operator_task', message: 'Later' },
      ],
      operationalFeatures: [{ id: 'gate-a', type: 'gate', label: 'Gate A', points: [{ lat: 37.0001, lng: -122 }] }],
    })
    const progress = buildMissionProgress({
      scenario: item,
      elapsedSec: 50,
      events: [operatorEvent('dispatch:now')],
      positionHistory: { 'uav-01': [origin] },
    })
    expect(progress.objectives.find((objective) => objective.kind === 'tasking_compliance')?.completion).toBe(1)
    expect(progress.objectives.find((objective) => objective.kind === 'containment')?.completion).toBe(1)
  })

  it('converts track effort inside a search polygon into bounded POD progress', () => {
    const item = scenario({
      searchArea: [
        { lat: 36.999, lng: -122.001 },
        { lat: 36.999, lng: -121.999 },
        { lat: 37.001, lng: -121.999 },
        { lat: 37.001, lng: -122.001 },
      ],
    })
    const progress = buildMissionProgress({
      scenario: item,
      drones: [drone()],
      positionHistory: { 'uav-01': [{ lat: 37, lng: -122.0009 }, { lat: 37, lng: -121.9991 }] },
    })
    const coverage = progress.objectives.find((objective) => objective.kind === 'sector_coverage')
    expect(coverage?.completion).toBeGreaterThan(0)
    expect(coverage?.completion).toBeLessThanOrEqual(1)
  })
})
