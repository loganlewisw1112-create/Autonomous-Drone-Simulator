import { describe, expect, it } from 'vitest'
import { resolveLostLinkPolicy } from '@/sim/safety/lostLink'
import type { ScenarioConfig } from '@/types'

const scenario = { lostLinkPolicy: undefined } as ScenarioConfig

describe('lost-link doctrine', () => {
  it('defaults to short hold then RTB', () => {
    expect(resolveLostLinkPolicy(scenario)).toMatchObject({ action: 'hold_then_rtb', holdSec: 10 })
  })

  it('refuses an unacknowledged continue-mission doctrine', () => {
    const result = resolveLostLinkPolicy({ ...scenario, lostLinkPolicy: { action: 'continue' } })
    expect(result.action).toBe('hold_then_rtb')
    expect(result.warning).toContain('replaced')
  })

  it('allows explicitly acknowledged continue and clamps hold duration', () => {
    expect(resolveLostLinkPolicy({ ...scenario, lostLinkPolicy: { action: 'continue', explicitlyAcknowledged: true } }).action).toBe('continue')
    expect(resolveLostLinkPolicy({ ...scenario, lostLinkPolicy: { action: 'hold', holdSec: 999 } }).holdSec).toBe(120)
  })
})
