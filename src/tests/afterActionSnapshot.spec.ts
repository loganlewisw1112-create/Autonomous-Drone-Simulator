/**
 * Export-during-scrub fix (audit M1). Scrubbing overwrites the live store's drones/thermal
 * state with an old frame; an after-action exported at that moment must still describe the
 * mission's FINAL state via the replaySession snapshot.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { buildAfterActionPackage } from '@/sim/demo/missionReport'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { DroneState, FullMissionFrame, ThermalContactState } from '@/types'

const scenario = ALL_SCENARIOS[0]

function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { ...scenario.startPosition },
    altitudeFt: 120,
    headingDeg: 0,
    speedMs: 8,
    batteryPct: 74,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 2,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...patch,
  }
}

function makeContact(sourceId: string): ThermalContactState {
  return {
    sourceId,
    class: 'generic-person',
    position: { lat: scenario.startPosition.lat + 0.001, lng: scenario.startPosition.lng },
    confidence: 0.8,
    weatherAdjustedConfidence: 0.8,
    tick: 500,
    selected: false,
  }
}

describe('after-action export during replay scrub', () => {
  beforeEach(() => {
    // Mission "ended" with two drones and one contact...
    const earlyFrame: FullMissionFrame = {
      tick: 40,
      elapsedSec: 2,
      drones: [makeDrone('uav-01', { batteryPct: 99, missionState: 'launch' })], // only 1 drone early
      thermalContacts: [],
      groundUnits: [],
      recoveryTeams: [],
      weatherState: getDefaultWeatherState(scenario.seed),
      activeEventIds: [],
    }
    useDroneStore.setState({
      scenario,
      scenarioVariant: { seed: 1, timeOfDay: 'day', season: 'spring', weatherSeverity: 0, commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 0 },
      drones: [makeDrone('uav-01'), makeDrone('uav-02')],
      thermalContacts: [makeContact('hs-final')],
      groundUnits: [],
      recoveryTeams: [],
      weatherState: getDefaultWeatherState(scenario.seed),
      replayFrames: [earlyFrame],
      replaySession: null,
      replayIndex: 0,
      events: [],
    })
    useDroneStore.getState().finalizeReplaySession()
  })

  it('snapshots final fleet state onto the session', () => {
    const session = useDroneStore.getState().replaySession!
    expect(session.finalDrones.map((d) => d.id)).toEqual(['uav-01', 'uav-02'])
    expect(session.finalThermalContacts.map((c) => c.sourceId)).toEqual(['hs-final'])
  })

  it('exports the FINAL mission state even while scrubbed to an early frame', () => {
    // Scrub to the early frame — this overwrites live drones/thermalContacts.
    useDroneStore.getState().setReplayIndex(0)
    const live = useDroneStore.getState()
    expect(live.drones).toHaveLength(1) // proof the live store is now the old frame

    const pkg = buildAfterActionPackage({
      scenario: live.scenario,
      scenarioVariant: live.scenarioVariant,
      drones: live.drones,                    // scrub-contaminated
      metrics: live.metrics,
      thermalContacts: live.thermalContacts,  // scrub-contaminated
      events: live.events,
      elapsedSec: live.elapsedSec,
      replayFrameCount: live.replaySession?.frames.length ?? 0,
      positionHistory: live.positionHistory,
      replaySession: live.replaySession,      // carries the finals
    })

    expect(pkg.evidence.droneCount).toBe(2)
    expect(pkg.outcome.detectedContacts).toBe(1)
  })

  it('falls back to live state when no session exists (mid-mission export)', () => {
    useDroneStore.setState({ replaySession: null })
    const live = useDroneStore.getState()
    const pkg = buildAfterActionPackage({
      scenario: live.scenario,
      scenarioVariant: live.scenarioVariant,
      drones: live.drones,
      metrics: live.metrics,
      thermalContacts: live.thermalContacts,
      events: live.events,
      elapsedSec: live.elapsedSec,
      replayFrameCount: 0,
      positionHistory: live.positionHistory,
      replaySession: live.replaySession,
    })
    expect(pkg.evidence.droneCount).toBe(2)
  })
})
