import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildMissionAssessment, type MissionAssessmentInput } from '@/classroom/missionAssessment'
import type { DroneState, EventType, MissionEvent, MissionMetrics, ScenarioConfig, ThermalContactState } from '@/types'

const origin = { lat: 37, lng: -122 }
const metrics: MissionMetrics = {
  totalFlightDistanceM: 1_000,
  waypointsReached: 5,
  conflictsDetected: 0,
  thermalContacts: 1,
  geofenceBreaches: 0,
  rtbTriggers: 0,
  recoveryDispatches: 0,
  groundUnitDispatch: 0,
}

function scenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'assessment-test', name: 'Assessment Test', description: 'Fixture', seed: 1,
    droneCount: 1, missionType: 'waypoint', startPosition: origin, waypoints: [],
    geofences: [], heatSources: [], batteryStartPct: 100, batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    missionObjectives: [{ id: 'recover', kind: 'fleet_recovery', label: 'Recover', weight: 1 }],
    ...overrides,
  }
}

function drone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#fff', position: origin, altitudeFt: 0,
    headingDeg: 0, speedMs: 0, batteryPct: 80, signalDbm: -60, missionState: 'landed',
    currentWaypointIndex: 0, conflictFlag: false, geofenceBreachFlag: false,
    bvlosFlag: false, sortieCount: 1, launchTimeSec: 0, ...overrides,
  }
}

function event(
  eventType: EventType,
  tick: number,
  payload: Record<string, unknown> = {},
  operatorId = 'participant:one',
): MissionEvent {
  return {
    tick, timestamp: tick, droneId: 'uav-01', operatorId, role: 'pic', eventType, payload,
    prevHash: 'x', hash: 'y',
  }
}

function contact(action: ThermalContactState['action']): ThermalContactState {
  return {
    sourceId: 'person-1', class: 'generic-person', position: origin, confidence: 0.9,
    weatherAdjustedConfidence: 0.9, tick: 0, selected: false,
    ...(action ? { action, resolvedAt: 1 } : {}),
  }
}

function input(overrides: Partial<MissionAssessmentInput> = {}): MissionAssessmentInput {
  return {
    scenario: scenario(), drones: [drone()], thermalContacts: [], events: [], metrics,
    elapsedSec: 600, isFinal: true, interventionActorPrefix: 'control:', evidenceVerified: true,
    ...overrides,
  }
}

describe('classroom mission assessment', () => {
  it('applies life-safety caps lexicographically after otherwise perfect scoring', () => {
    const minor = buildMissionAssessment(input({
      events: [
        event('ground_unit_dispatched', 0, { thermalId: 'person-1' }),
        event('ground_unit_on_scene', 4_000, { thermalId: 'person-1' }),
      ],
    }))
    expect(minor.uncappedTotal).toBeGreaterThan(79)
    expect(minor.lifeSafety).toMatchObject({ severity: 'minor', cap: 79, status: 'fail' })
    expect(minor.total).toBe(79)

    const major = buildMissionAssessment(input({
      thermalContacts: [contact('resolve')],
      events: [event('operator_command', 2_500, { command: 'thermal_action', sourceId: 'person-1' })],
    }))
    expect(major.lifeSafety).toMatchObject({ severity: 'major', cap: 59 })
    expect(major.total).toBe(59)

    const criticalScenario = scenario({
      geofences: [{
        id: 'school', label: 'School', polygon: [origin, origin, origin], maxAltitudeFt: 400,
        type: 'no_fly', lifeCritical: true,
      }],
    })
    const critical = buildMissionAssessment(input({
      scenario: criticalScenario,
      metrics: { ...metrics, geofenceBreaches: 0 },
      events: [event('geofence_breach', 1, { geofenceId: 'school' })],
    }))
    expect(critical.lifeSafety).toMatchObject({ severity: 'critical', cap: 39 })
    expect(critical.total).toBe(39)
    expect(critical.band).toBe('F')
  })

  it('excludes prefixed interventions from participant credit and reports them separately', () => {
    const contactScenario = scenario({
      heatSources: [{ id: 'person-1', class: 'generic-person', position: origin, tempC: 37, radiusM: 1 }],
      missionObjectives: [
        { id: 'contact', kind: 'contact_resolution', label: 'Resolve contact', weight: 1 },
      ],
    })
    const remote = buildMissionAssessment(input({
      scenario: contactScenario,
      thermalContacts: [contact('resolve')],
      events: [event('operator_command', 10, { command: 'thermal_action', sourceId: 'person-1' }, 'control:teacher-7')],
    }))
    expect(remote.progressPercent).toBe(0)
    expect(remote.lifeSafety.findings.map((finding) => finding.code)).toContain('CONTACT_UNACTIONED')
    expect(remote.interventions).toHaveLength(1)
    expect(remote.interventions[0].actorId).toBe('control:teacher-7')

    const participant = buildMissionAssessment(input({
      scenario: contactScenario,
      thermalContacts: [contact('resolve')],
      events: [event('operator_command', 10, { command: 'thermal_action', sourceId: 'person-1' })],
    }))
    expect(participant.progressPercent).toBe(100)
    expect(participant.lifeSafety.findings.map((finding) => finding.code)).not.toContain('CONTACT_UNACTIONED')
    expect(participant.interventions).toEqual([])
  })

  it('flags abandoning thermal hold before action as critical', () => {
    const assessment = buildMissionAssessment(input({
      thermalContacts: [contact(undefined)],
      events: [
        event('state_change', 10, { from: 'inspect', to: 'thermal_hold' }),
        event('operator_command', 20, { command: 'rtb' }),
      ],
      isFinal: false,
      elapsedSec: 2,
    }))
    expect(assessment.lifeSafety.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HOLD_ABANDONED', severity: 'critical', sourceId: 'person-1' }),
    ]))
    expect(assessment.lifeSafety.cap).toBe(39)
  })

  it('flags property work performed while a life objective remains open', () => {
    const item = scenario({
      heatSources: [{ id: 'person-1', class: 'generic-person', position: origin, tempC: 37, radiusM: 1 }],
      operationalFeatures: [{ id: 'relay-a', type: 'relay', label: 'Relay A', points: [origin] }],
    })
    const assessment = buildMissionAssessment(input({
      scenario: item,
      thermalContacts: [contact(undefined)],
      events: [event('operator_command', 20, { command: 'set_route', objectiveId: 'feature:relay-a' })],
      isFinal: false,
      elapsedSec: 2,
    }))
    expect(assessment.lifeSafety.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PROPERTY_BEFORE_LIFE', severity: 'major' }),
    ]))
    expect(assessment.lifeSafety.cap).toBe(59)
  })

  it('derives and assesses objectives for every catalog scenario', () => {
    expect(ALL_SCENARIOS).toHaveLength(21)
    for (const item of ALL_SCENARIOS) {
      const assessment = buildMissionAssessment(input({
        scenario: item,
        drones: [],
        thermalContacts: [],
        events: [],
        elapsedSec: 0,
        isFinal: false,
      }))
      expect(assessment.objectives.length).toBeGreaterThan(0)
      expect(assessment.progressPercent).toBeGreaterThanOrEqual(0)
      expect(assessment.progressPercent).toBeLessThanOrEqual(100)
      expect(assessment.tier1).toBeGreaterThanOrEqual(0)
      expect(assessment.tier1).toBeLessThanOrEqual(60)
      expect(assessment.tier2).toBeGreaterThanOrEqual(0)
      expect(assessment.tier2).toBeLessThanOrEqual(40)
    }
  })
})
