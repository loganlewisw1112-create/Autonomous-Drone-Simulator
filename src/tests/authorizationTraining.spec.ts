import { describe, expect, it, beforeEach } from 'vitest'
import {
  buildAuthorizationFromProfile,
  evaluateAuthorizationTraining,
  resolveAuthorizationProfile,
  resolveRequiredAuthorizationSteps,
  authorizationStepsFromEvents,
} from '@/sim/mission/authorizationTraining'
import { useDroneStore } from '@/store/droneStore'
import { getScenarioById } from '@/scenarios/registry'
import { buildMissionAssessment } from '@/classroom/missionAssessment'
import type { AuthorizationStepId, DroneState, MissionEvent, MissionMetrics, ScenarioConfig, ScenarioVariantConfig } from '@/types'

const DAY: ScenarioVariantConfig = {
  seed: 42,
  timeOfDay: 'day',
  season: 'summer',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 0,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const NIGHT: ScenarioVariantConfig = { ...DAY, timeOfDay: 'night' }

const METRICS: MissionMetrics = {
  totalFlightDistanceM: 0,
  waypointsReached: 0,
  conflictsDetected: 0,
  thermalContacts: 0,
  geofenceBreaches: 0,
  rtbTriggers: 0,
  recoveryDispatches: 0,
  groundUnitDispatch: 0,
}

describe('authorization training (Phase 4)', () => {
  it('prefers explicit authorizationProfile over regex inference', () => {
    const coastal = getScenarioById('demo_sar_coastal')!.config
    expect(coastal.authorizationProfile?.kind).toBe('simulated_laanc')
    expect(buildAuthorizationFromProfile(coastal).kind).toBe('simulated_laanc')
    expect(buildAuthorizationFromProfile(coastal).label).toBe('Simulated LAANC / USS authorization')

    const overridden: ScenarioConfig = {
      ...coastal,
      // Name would still regex to LAANC, but explicit profile wins.
      authorizationProfile: {
        kind: 'field_incident_command',
        requiredSteps: ['remote_id', 'airspace_request'],
        label: 'Authored IC profile',
        reference: 'Explicit profile wins.',
      },
    }
    expect(resolveAuthorizationProfile(overridden).kind).toBe('field_incident_command')
    expect(buildAuthorizationFromProfile(overridden).label).toBe('Authored IC profile')
  })

  it('is deterministic for the same scenario + variant + seed path', () => {
    const coastal = getScenarioById('demo_sar_coastal')!.config
    const a = resolveRequiredAuthorizationSteps(coastal, DAY)
    const b = resolveRequiredAuthorizationSteps(coastal, DAY)
    expect(a).toEqual(b)
    // Coastal geofence is labeled TFR → conflict ack is required.
    expect(a).toEqual(['remote_id', 'airspace_request', 'ceiling_check', 'tfr_conflict_ack'])

    const night = resolveRequiredAuthorizationSteps(coastal, NIGHT)
    expect(night).toContain('night_ops')
    expect(night).toEqual(resolveRequiredAuthorizationSteps(coastal, NIGHT))
  })

  it('exposes Harvey-class TFR exercise hook on historical Harvey scenario', () => {
    const harvey = getScenarioById('hist_harvey_houston_2017')!.config
    const profile = resolveAuthorizationProfile(harvey)
    expect(profile.tfrExercise?.requireAcknowledgment).toBe(true)
    expect(profile.tfrExercise?.id).toBe('tfr-harvey-houston')
    const steps = resolveRequiredAuthorizationSteps(harvey, DAY)
    expect(steps).toContain('tfr_conflict_ack')
  })

  it('blocks launch until required authorization steps are completed', () => {
    const coastal = getScenarioById('demo_sar_coastal')!.config
    useDroneStore.setState({
      scenario: coastal,
      scenarioVariant: DAY,
      authorizationCompletedSteps: [],
      lifecycle: 'preflight',
      ui: { ...useDroneStore.getState().ui, isRunning: false },
      drones: [parkedDrone('uav-01', coastal)],
      launchPlan: null,
    })

    expect(useDroneStore.getState().isAuthorizationTrainingReady()).toBe(false)
    useDroneStore.getState().beginLaunchSequence()
    expect(useDroneStore.getState().lifecycle).toBe('preflight')

    useDroneStore.getState().completeAuthorizationTraining('test')
    expect(useDroneStore.getState().isAuthorizationTrainingReady()).toBe(true)
    useDroneStore.getState().beginLaunchSequence()
    expect(useDroneStore.getState().lifecycle).toBe('running')
  })

  it('emits authorization evidence events when steps are toggled', () => {
    const coastal = getScenarioById('demo_sar_coastal')!.config
    useDroneStore.setState({
      scenario: coastal,
      scenarioVariant: DAY,
      authorizationCompletedSteps: [],
      events: [],
      lastHash: '0'.repeat(64),
      tick: 0,
    })

    useDroneStore.getState().toggleAuthorizationStep('remote_id')
    const events = useDroneStore.getState().events
    expect(events.some((e) => e.eventType === 'authorization_step_complete' && e.payload.stepId === 'remote_id')).toBe(true)

    useDroneStore.getState().completeAuthorizationTraining('test')
    expect(useDroneStore.getState().events.some((e) => e.eventType === 'authorization_complete')).toBe(true)
  })

  it('scores missed authorization steps in classroom assessment', () => {
    const coastal = getScenarioById('demo_sar_coastal')!.config
    const incomplete = buildMissionAssessment({
      scenario: coastal,
      drones: [parkedDrone('uav-01', coastal)],
      thermalContacts: [],
      events: [],
      metrics: METRICS,
      elapsedSec: 60,
      isFinal: true,
      interventionActorPrefix: 'control:',
      evidenceVerified: true,
      authorizationCompletedSteps: ['remote_id'],
      scenarioVariant: DAY,
    })
    expect(incomplete.authorization.complete).toBe(false)
    expect(incomplete.authorization.missedStepIds.length).toBeGreaterThan(0)
    expect(incomplete.authorization.scoreContribution).toBeLessThan(10)

    const required = resolveRequiredAuthorizationSteps(coastal, DAY)
    const complete = buildMissionAssessment({
      scenario: coastal,
      drones: [parkedDrone('uav-01', coastal)],
      thermalContacts: [],
      events: authEvents(required),
      metrics: METRICS,
      elapsedSec: 60,
      isFinal: true,
      interventionActorPrefix: 'control:',
      evidenceVerified: true,
      scenarioVariant: DAY,
    })
    expect(complete.authorization.complete).toBe(true)
    expect(complete.authorization.missedStepIds).toEqual([])
    expect(complete.authorization.scoreContribution).toBe(10)
    expect(complete.tier2).toBeGreaterThan(incomplete.tier2)
  })

  it('reconstructs completed steps from evidence events deterministically', () => {
    const steps: AuthorizationStepId[] = ['ceiling_check', 'remote_id', 'airspace_request']
    const fromEvents = authorizationStepsFromEvents(authEvents(steps))
    expect(fromEvents).toEqual(['remote_id', 'airspace_request', 'ceiling_check'])
    expect(fromEvents).toEqual(authorizationStepsFromEvents(authEvents(steps)))
  })

  it('reports launch-blocked progress until ready', () => {
    const wildfire = getScenarioById('demo_wildfire')!.config
    const progress = evaluateAuthorizationTraining(wildfire, DAY, [])
    expect(progress.ready).toBe(false)
    expect(progress.disclaimer).toMatch(/SIMULATION ONLY/i)

    const done = evaluateAuthorizationTraining(wildfire, DAY, progress.requiredStepIds)
    expect(done.ready).toBe(true)
    expect(done.missedStepIds).toEqual([])
  })
})

describe('authorization training store reset', () => {
  beforeEach(() => {
    useDroneStore.getState().resetMission()
  })

  it('clears completed auth steps on mission reset', () => {
    useDroneStore.setState({ authorizationCompletedSteps: ['remote_id', 'ceiling_check'] })
    useDroneStore.getState().resetMission()
    expect(useDroneStore.getState().authorizationCompletedSteps).toEqual([])
  })
})

function parkedDrone(id: string, scenario: ScenarioConfig): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 0,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: 100,
    signalDbm: -55,
    missionState: 'idle',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
  }
}

function authEvents(steps: readonly AuthorizationStepId[]): MissionEvent[] {
  return steps.map((stepId, index) => ({
    tick: index,
    timestamp: index,
    droneId: 'system',
    operatorId: 'participant:one',
    role: 'pic' as const,
    eventType: 'authorization_step_complete' as const,
    payload: { stepId, simulationOnly: true },
    prevHash: 'x',
    hash: `y${index}`,
  }))
}
