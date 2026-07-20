import { describe, expect, it } from 'vitest'
import { inspectEvidence } from '@/components/rundetail/evidenceStatus'
import { buildEvent, getGenesisHash } from '@/utils/chainOfCustody'
import type { StoredRunDetailV2, StoredRunSummary } from '@/account/types'

function summary(): StoredRunSummary {
  return {
    scenarioId: 'test',
    scenarioVariant: { seed: 1, season: 'summer', weatherSeverity: 0, timeOfDay: 'day', commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0 },
    completedAt: 1,
    durationSec: 10,
    metrics: { totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0, thermalContacts: 0, geofenceBreaches: 0, rtbTriggers: 0, recoveryDispatches: 0, groundUnitDispatch: 0 },
    eventCount: 0,
    firstHash: null,
    lastHash: null,
    chainVerified: true,
    droneOutcomes: [],
  }
}

function detailWithEvents(events: ReturnType<typeof buildEvent>[]): StoredRunDetailV2 {
  return { events, evidence: { eventCount: events.length, firstHash: events[0]?.hash ?? null, lastHash: events.at(-1)?.hash ?? null, verified: true } } as StoredRunDetailV2
}

describe('saved-run evidence states', () => {
  it('never labels an empty chain verified', () => {
    expect(inspectEvidence(summary(), null).state).toBe('no-evidence')
  })

  it('labels a missing detail row incomplete when the summary has evidence', () => {
    const item = summary()
    item.eventCount = 1
    expect(inspectEvidence(item, null).state).toBe('incomplete')
  })

  it('verifies every stored link and reports the first tampered link', () => {
    const first = buildEvent(getGenesisHash(), 1, 'uav-01', 'operator-1', 'pic', 'mission_start', {})
    const second = buildEvent(first.hash, 2, 'uav-01', 'operator-1', 'pic', 'waypoint_reached', { waypointId: 'wp-1' })
    const item = summary()
    item.eventCount = 2
    item.firstHash = first.hash
    item.lastHash = second.hash
    item.chainVerified = true
    expect(inspectEvidence(item, detailWithEvents([first, second])).state).toBe('verified')

    const tampered = { ...second, payload: { waypointId: 'changed' } }
    expect(inspectEvidence(item, detailWithEvents([first, tampered]))).toMatchObject({ state: 'failed', failureIndex: 1 })
  })
})
