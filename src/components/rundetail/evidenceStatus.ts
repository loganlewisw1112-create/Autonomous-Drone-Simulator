import { getGenesisHash, hashEvent } from '@/utils/chainOfCustody'
import type { StoredRunDetailV2, StoredRunSummary } from '@/account/types'
import type { MissionEvent } from '@/types'

export type EvidenceStatus =
  | { state: 'verified'; label: string }
  | { state: 'failed'; label: string; failureIndex: number }
  | { state: 'no-evidence'; label: string }
  | { state: 'incomplete'; label: string }

function rehash(event: MissionEvent): string {
  return hashEvent(event.prevHash, {
    tick: event.tick,
    timestamp: event.timestamp,
    droneId: event.droneId,
    operatorId: event.operatorId,
    role: event.role,
    eventType: event.eventType,
    payload: event.payload,
    prevHash: event.prevHash,
  })
}

export function inspectEvidence(summary: StoredRunSummary, detail: StoredRunDetailV2 | null): EvidenceStatus {
  if (summary.eventCount === 0) return { state: 'no-evidence', label: 'No evidence events recorded' }
  if (!detail) return { state: 'incomplete', label: summary.detailState === 'quota-limited' ? 'Detail not saved — device storage was full' : 'Legacy summary only' }
  const events = detail.events
  if (events.length === 0) return { state: 'no-evidence', label: 'No evidence events recorded' }
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const expectedPrevious = index === 0 ? getGenesisHash() : events[index - 1].hash
    if (event.prevHash !== expectedPrevious || event.hash !== rehash(event)) {
      return { state: 'failed', label: `Evidence link ${index + 1} failed verification`, failureIndex: index }
    }
  }
  const first = events[0]?.hash ?? null
  const last = events.at(-1)?.hash ?? null
  if (events.length !== summary.eventCount || first !== summary.firstHash || last !== summary.lastHash || last !== detail.evidence.lastHash) {
    return { state: 'failed', label: 'Evidence metadata does not match the stored chain', failureIndex: Math.max(0, events.length - 1) }
  }
  return { state: 'verified', label: `${events.length} evidence links verified` }
}
