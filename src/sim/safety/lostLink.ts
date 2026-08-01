import type { LostLinkPolicy, ScenarioConfig } from '@/types'

export const DEFAULT_LOST_LINK_HOLD_SEC = 10

export interface ResolvedLostLinkPolicy {
  action: LostLinkPolicy['action']
  holdSec: number
  warning?: string
}

/**
 * Fail-closed doctrine. Continuing the mission is accepted only when the scenario
 * explicitly acknowledges it; malformed or absent policy uses hold -> validated RTB.
 */
export function resolveLostLinkPolicy(scenario: ScenarioConfig): ResolvedLostLinkPolicy {
  const configured = scenario.lostLinkPolicy
  if (configured?.action === 'continue' && configured.explicitlyAcknowledged !== true) {
    return {
      action: 'hold_then_rtb',
      holdSec: DEFAULT_LOST_LINK_HOLD_SEC,
      warning: 'Unacknowledged continue-on-lost-link policy was replaced by the conservative default.',
    }
  }
  const action = configured?.action ?? 'hold_then_rtb'
  const rawHold = configured?.holdSec ?? DEFAULT_LOST_LINK_HOLD_SEC
  const holdSec = Number.isFinite(rawHold) ? Math.max(0, Math.min(120, rawHold)) : DEFAULT_LOST_LINK_HOLD_SEC
  return { action, holdSec }
}
