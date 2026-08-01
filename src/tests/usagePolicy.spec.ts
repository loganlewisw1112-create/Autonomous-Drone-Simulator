import { describe, expect, it } from 'vitest'
import { buildUsagePolicy, evaluateUsagePhase, remainingUsageMs } from '@/licensing/usagePolicy'

describe('usage policy clock', () => {
  it('moves the public demo to debrief after 30 wall-clock minutes', () => {
    const policy = buildUsagePolicy('public_demo')
    const clock = { firstSeenAt: 0, lastActivityAt: 29 * 60_000, debriefStartedAt: null }
    expect(evaluateUsagePhase(policy, clock, 30 * 60_000)).toBe('debrief')
  })

  it('moves the public demo to debrief after 10 idle minutes', () => {
    const policy = buildUsagePolicy('public_demo')
    const clock = { firstSeenAt: 0, lastActivityAt: 0, debriefStartedAt: null }
    expect(evaluateUsagePhase(policy, clock, 10 * 60_000)).toBe('debrief')
  })

  it('keeps a 15-minute debrief window and then expires', () => {
    const policy = buildUsagePolicy('public_demo')
    const clock = { firstSeenAt: 0, lastActivityAt: 0, debriefStartedAt: 30 * 60_000 }
    expect(evaluateUsagePhase(policy, clock, 44 * 60_000)).toBe('debrief')
    expect(remainingUsageMs(policy, clock, 44 * 60_000)).toBe(60_000)
    expect(evaluateUsagePhase(policy, clock, 45 * 60_000)).toBe('expired')
  })

  it('enforces an explicit pilot build expiry', () => {
    const policy = buildUsagePolicy('classroom_pilot', '2026-09-01T00:00:00.000Z')
    const clock = { firstSeenAt: 0, lastActivityAt: 0, debriefStartedAt: null }
    expect(evaluateUsagePhase(policy, clock, Date.parse('2026-09-01T00:00:00.000Z'))).toBe('expired')
  })
})
