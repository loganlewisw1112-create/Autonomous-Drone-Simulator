import { getGenesisHash, hashEvent } from '@/utils/chainOfCustody'
import type { MissionEvent } from '@/types'

/**
 * Read-only companion to `verifyChain` (chainOfCustody.ts): same link checks, but it reports WHERE
 * the chain first fails instead of only whether it does. Returns the zero-based index of the first
 * event whose prevHash or hash does not check out, or null for an intact chain (including an empty one).
 *
 * It only verifies. Events are still created exclusively through the store's emitEvent; this
 * helper never builds or mutates one.
 */
export function firstChainBreak(events: readonly MissionEvent[]): number | null {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const expectedPrev = i === 0 ? getGenesisHash() : events[i - 1].hash
    if (e.prevHash !== expectedPrev) return i
    const recomputed = hashEvent(e.prevHash, {
      tick: e.tick,
      timestamp: e.timestamp,
      droneId: e.droneId,
      operatorId: e.operatorId,
      role: e.role,
      eventType: e.eventType,
      payload: e.payload,
      prevHash: e.prevHash,
    })
    if (recomputed !== e.hash) return i
  }
  return null
}
