// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { buildRunSummary, recordRun } from '@/account/runRecorder'
import { listRuns } from '@/account/accountDb'
import { decryptJson } from '@/account/crypto'
import { useAuthStore } from '@/store/authStore'
import type { MissionReplaySession } from '@/types'
import type { StoredRunSummary } from '@/account/types'

function makeSession(): MissionReplaySession {
  return {
    scenarioId: 'wildfire',
    scenarioVariant: { seed: 42, timeOfDay: 'day', season: 'summer', weatherSeverity: 1, commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 1 },
    launchPlan: null,
    frames: [
      { tick: 10, elapsedSec: 20, drones: [], thermalContacts: [], groundUnits: [], recoveryTeams: [], weatherState: { activeHazards: [] }, activeEventIds: [] },
      { tick: 90, elapsedSec: 180, drones: [], thermalContacts: [], groundUnits: [], recoveryTeams: [], weatherState: { activeHazards: [] }, activeEventIds: [] },
    ],
    events: [],
    metrics: {
      totalFlightDistanceM: 5200, waypointsReached: 8, conflictsDetected: 1, thermalContacts: 3,
      geofenceBreaches: 0, rtbTriggers: 1, recoveryDispatches: 0, groundUnitDispatch: 1,
    },
    completedAt: 1_752_900_000_000,
    finalDrones: [
      { id: 'drone-1', missionState: 'landed', batteryPct: 61.4 },
      { id: 'drone-2', missionState: 'landed', batteryPct: 58.9 },
    ],
    finalThermalContacts: [], finalGroundUnits: [], finalRecoveryTeams: [],
    finalWeatherState: { activeHazards: [] },
  } as unknown as MissionReplaySession
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({ activeAccount: null, sessionKey: null })
})

describe('runRecorder', () => {
  it('builds a trimmed summary — no frames, but duration/metrics/outcomes intact', () => {
    const summary = buildRunSummary(makeSession())
    expect('frames' in summary).toBe(false)
    expect(summary.durationSec).toBe(180)
    expect(summary.metrics.totalFlightDistanceM).toBe(5200)
    expect(summary.eventCount).toBe(0)
    expect(summary.chainVerified).toBe(false)
    expect(summary.droneOutcomes).toEqual([
      { id: 'drone-1', missionState: 'landed', batteryPct: 61 },
      { id: 'drone-2', missionState: 'landed', batteryPct: 59 },
    ])
  })

  it('does not record when signed out', async () => {
    expect(await recordRun(makeSession())).toBe(false)
  })

  it('records an encrypted run for the signed-in profile', async () => {
    await useAuthStore.getState().signUp('recorder', '', 'password123', false)
    expect(await recordRun(makeSession())).toBe(true)

    const { activeAccount, sessionKey } = useAuthStore.getState()
    const runs = await listRuns(activeAccount!.id)
    expect(runs).toHaveLength(1)
    // stored blob is ciphertext, not plaintext JSON
    expect(runs[0].blob.ct).not.toContain('wildfire')
    const decrypted = decryptJson<StoredRunSummary>(sessionKey!, runs[0].blob)
    expect(decrypted.scenarioId).toBe('wildfire')
  })
})
