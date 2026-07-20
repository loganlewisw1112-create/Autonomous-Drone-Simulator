// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { recordRun } from '@/account/runRecorder'
import { listRuns, listRunDetails } from '@/account/accountDb'
import { decryptJson } from '@/account/crypto'
import { useAuthStore } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'
import type { MissionReplaySession, ScenarioConfig } from '@/types'
import type { StoredRunSummary } from '@/account/types'

// When the device rejects the heavy detail write with a QuotaExceededError the
// recorder must still persist the compact summary, flagged `detailState:
// 'quota-limited'` so the UI can badge the run as summary-only.

function makeScenario(): ScenarioConfig {
  return {
    id: 'wildfire',
    name: 'Wildfire Response',
    description: 'test scenario',
    seed: 1,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: { lat: 37.77, lng: -122.42 },
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.1,
    commsLossWindows: [],
  }
}

function makeSession(): MissionReplaySession {
  const drone = {
    id: 'drone-1', label: 'D1', color: '#00d4ff',
    position: { lat: 37.77, lng: -122.42 }, altitudeFt: 200, headingDeg: 0,
    speedMs: 5, batteryPct: 60, signalDbm: -60, missionState: 'landed',
    currentWaypointIndex: 0, conflictFlag: false, geofenceBreachFlag: false,
    bvlosFlag: false, sortieCount: 0,
  }
  return {
    scenarioId: 'wildfire',
    scenarioVariant: { seed: 42, timeOfDay: 'day', season: 'summer', weatherSeverity: 1, commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 1 },
    launchPlan: null,
    frames: [
      { tick: 10, elapsedSec: 20, drones: [drone], thermalContacts: [], groundUnits: [], recoveryTeams: [], weatherState: { activeHazards: [] }, activeEventIds: [] },
      { tick: 90, elapsedSec: 180, drones: [drone], thermalContacts: [], groundUnits: [], recoveryTeams: [], weatherState: { activeHazards: [] }, activeEventIds: [] },
    ],
    events: [],
    metrics: { totalFlightDistanceM: 5200, waypointsReached: 8, conflictsDetected: 1, thermalContacts: 3, geofenceBreaches: 0, rtbTriggers: 1, recoveryDispatches: 0, groundUnitDispatch: 1 },
    completedAt: 1_752_900_000_000,
    finalDrones: [drone],
    finalThermalContacts: [], finalGroundUnits: [], finalRecoveryTeams: [],
    finalWeatherState: { activeHazards: [] },
  } as unknown as MissionReplaySession
}

const originalPut = IDBObjectStore.prototype.put

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({ activeAccount: null, sessionKey: null })
  useDroneStore.setState({ scenario: makeScenario(), droneWaypoints: {}, positionHistory: {}, telemetryHistory: {} })
})

afterEach(() => {
  IDBObjectStore.prototype.put = originalPut
})

describe('runRecorder quota fallback', () => {
  it('keeps the summary (flagged quota-limited) when the detail write hits quota', async () => {
    await useAuthStore.getState().signUp('recorder', '', 'password123', false)

    // Force ONLY the runDetails write to fail with a quota error; the summary
    // write targets the `runs` store and stays untouched.
    IDBObjectStore.prototype.put = function put(
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ): IDBRequest<IDBValidKey> {
      if (this.name === 'runDetails') {
        throw new DOMException('Quota exceeded (test)', 'QuotaExceededError')
      }
      return originalPut.apply(this, args)
    }

    expect(await recordRun(makeSession())).toBe(true)

    const { activeAccount, sessionKey } = useAuthStore.getState()
    const runs = await listRuns(activeAccount!.id)
    expect(runs).toHaveLength(1)
    const summary = decryptJson<StoredRunSummary>(sessionKey!, runs[0].blob)
    expect(summary.scenarioId).toBe('wildfire')
    expect(summary.detailState).toBe('quota-limited')

    // The detail row was rejected — nothing persisted in runDetails.
    expect(await listRunDetails(activeAccount!.id)).toHaveLength(0)
  })

  it('flags the summary saved and writes the detail when storage accepts it', async () => {
    await useAuthStore.getState().signUp('recorder', '', 'password123', false)

    expect(await recordRun(makeSession())).toBe(true)

    const { activeAccount, sessionKey } = useAuthStore.getState()
    const runs = await listRuns(activeAccount!.id)
    const summary = decryptJson<StoredRunSummary>(sessionKey!, runs[0].blob)
    expect(summary.detailState).toBe('saved')
    // Detail row persisted under the same id as the summary.
    const details = await listRunDetails(activeAccount!.id)
    expect(details).toHaveLength(1)
    expect(details[0].id).toBe(runs[0].id)
  })
})
