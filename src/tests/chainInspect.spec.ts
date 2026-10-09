import { describe, expect, it } from 'vitest'
import { firstChainBreak } from '@/utils/chainInspect'
import { buildEvent, getGenesisHash, verifyChain } from '@/utils/chainOfCustody'
import type { MissionEvent } from '@/types'

function chain(length: number): MissionEvent[] {
  const events: MissionEvent[] = []
  let prev = getGenesisHash()
  for (let i = 0; i < length; i++) {
    const event = buildEvent(prev, i + 1, 'uav-01', 'operator-1', 'pic', i === 0 ? 'mission_start' : 'waypoint_reached', { n: i })
    events.push(event)
    prev = event.hash
  }
  return events
}

describe('firstChainBreak', () => {
  it('returns null for an intact chain and for an empty one', () => {
    expect(firstChainBreak(chain(5))).toBeNull()
    expect(firstChainBreak([])).toBeNull()
  })

  it('returns the index of a tampered payload (hash no longer matches)', () => {
    const events = chain(5)
    events[3] = { ...events[3], payload: { n: 999 } }
    expect(firstChainBreak(events)).toBe(3)
    expect(verifyChain(events)).toBe(false)
  })

  it('returns the index of a tampered hash', () => {
    const events = chain(4)
    events[2] = { ...events[2], hash: 'f'.repeat(64) }
    expect(firstChainBreak(events)).toBe(2)
  })

  it('returns the index of a broken prevHash link', () => {
    const events = chain(4)
    events[1] = { ...events[1], prevHash: 'a'.repeat(64) }
    expect(firstChainBreak(events)).toBe(1)
  })

  it('flags a first event that does not start at the genesis hash', () => {
    const events = chain(3)
    events[0] = { ...events[0], prevHash: '1'.repeat(64) }
    expect(firstChainBreak(events)).toBe(0)
  })

  it('reports the FIRST break when several links are bad', () => {
    const events = chain(6)
    events[4] = { ...events[4], payload: { n: -1 } }
    events[2] = { ...events[2], payload: { n: -2 } }
    expect(firstChainBreak(events)).toBe(2)
  })

  it('agrees with verifyChain on every single-link tamper position', () => {
    for (let i = 0; i < 4; i++) {
      const events = chain(4)
      events[i] = { ...events[i], tick: events[i].tick + 100 }
      expect(firstChainBreak(events) === null).toBe(verifyChain(events))
      expect(firstChainBreak(events)).toBe(i)
    }
  })
})
