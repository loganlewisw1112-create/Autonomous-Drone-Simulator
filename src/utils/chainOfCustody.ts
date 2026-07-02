import type { MissionEvent, EventType, OperatorRole } from '@/types'

const GENESIS_HASH = '0'.repeat(64)

// SHA-256 via Web Crypto API (async but called at event-log time, not in tight loop)
async function sha256(message: string): Promise<string> {
  const data = new TextEncoder().encode(message)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function buildEvent(
  prevHash: string,
  tick: number,
  droneId: string,
  operatorId: string,
  role: OperatorRole,
  eventType: EventType,
  payload: Record<string, unknown>,
): Promise<MissionEvent> {
  const partial = {
    tick,
    timestamp: Date.now(),
    droneId,
    operatorId,
    role,
    eventType,
    payload,
    prevHash,
  }
  const hash = await sha256(prevHash + JSON.stringify(partial))
  return { ...partial, hash }
}

export function getGenesisHash(): string {
  return GENESIS_HASH
}

// Verify the full chain — returns true if intact
export async function verifyChain(events: MissionEvent[]): Promise<boolean> {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const expectedPrev = i === 0 ? GENESIS_HASH : events[i - 1].hash
    if (e.prevHash !== expectedPrev) return false
    const partial = {
      tick: e.tick,
      timestamp: e.timestamp,
      droneId: e.droneId,
      operatorId: e.operatorId,
      role: e.role,
      eventType: e.eventType,
      payload: e.payload,
      prevHash: e.prevHash,
    }
    const expected = await sha256(e.prevHash + JSON.stringify(partial))
    if (expected !== e.hash) return false
  }
  return true
}

export function exportChainAsJsonl(events: MissionEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n')
}
