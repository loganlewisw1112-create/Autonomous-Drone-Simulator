import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import type { MissionEvent, EventType, OperatorRole } from '@/types'

const GENESIS_HASH = '0'.repeat(64)

// Synchronous SHA-256 (audited @noble/hashes implementation).
//
// Hashing MUST be synchronous here: events are appended inside the Zustand reducer so that
// reading `lastHash` and committing the next link is one atomic step. The previous
// crypto.subtle-based implementation was async, which let every event emitted within a single
// sim tick capture the same stale prevHash and fork the chain.
function sha256Hex(message: string): string {
  return bytesToHex(sha256(message))
}

type MissionEventPartial = Omit<MissionEvent, 'hash'>

/** Hash one chain link. Preimage format is prevHash + JSON(partial-including-prevHash). */
export function hashEvent(prevHash: string, partial: MissionEventPartial): string {
  return sha256Hex(prevHash + JSON.stringify(partial))
}

/** Build a fully-hashed event from explicit fields. Prefer the store's emitEvent action,
 *  which reads prevHash atomically; this exists for tests and offline tooling. */
export function buildEvent(
  prevHash: string,
  tick: number,
  droneId: string,
  operatorId: string,
  role: OperatorRole,
  eventType: EventType,
  payload: Record<string, unknown>,
): MissionEvent {
  const partial: MissionEventPartial = {
    tick,
    timestamp: Date.now(),
    droneId,
    operatorId,
    role,
    eventType,
    payload,
    prevHash,
  }
  return { ...partial, hash: hashEvent(prevHash, partial) }
}

export function getGenesisHash(): string {
  return GENESIS_HASH
}

/** Verify the full chain — true only if every link's prevHash and hash check out. */
export function verifyChain(events: MissionEvent[]): boolean {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const expectedPrev = i === 0 ? GENESIS_HASH : events[i - 1].hash
    if (e.prevHash !== expectedPrev) return false
    const partial: MissionEventPartial = {
      tick: e.tick,
      timestamp: e.timestamp,
      droneId: e.droneId,
      operatorId: e.operatorId,
      role: e.role,
      eventType: e.eventType,
      payload: e.payload,
      prevHash: e.prevHash,
    }
    if (hashEvent(e.prevHash, partial) !== e.hash) return false
  }
  return true
}

/** Export the chain as JSONL. Line 1 is a header stamped with the verification result so a
 *  recipient can immediately see whether the log verified at export time — and re-check it. */
export function exportChainAsJsonl(events: MissionEvent[]): string {
  const header = {
    kind: 'chain_of_custody_export',
    eventCount: events.length,
    genesisHash: GENESIS_HASH,
    chainVerified: verifyChain(events),
    exportedAt: new Date().toISOString(),
  }
  return [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n')
}
