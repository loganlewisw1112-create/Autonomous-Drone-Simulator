export type DistributionChannel =
  | 'development'
  | 'public_demo'
  | 'licensed_windows'
  | 'windows_evaluation'
  | 'classroom_pilot'
  | 'agency_training_pilot'

export interface UsagePolicy {
  channel: DistributionChannel
  wallClockMs: number | null
  idleMs: number | null
  debriefMs: number
  buildExpiresAt: number | null
  defaultClassDurationMin: number
  classDurationRangeMin: readonly [number, number]
}

export type UsagePhase = 'active' | 'debrief' | 'expired'

export interface UsageClock {
  firstSeenAt: number
  lastActivityAt: number
  debriefStartedAt: number | null
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

export function resolveDistributionChannel(value: unknown): DistributionChannel {
  return value === 'public_demo'
    || value === 'windows_evaluation'
    || value === 'licensed_windows'
    || value === 'classroom_pilot'
    || value === 'agency_training_pilot'
    ? value
    : 'development'
}

export function buildUsagePolicy(
  channel: DistributionChannel,
  expiresAt?: string,
): UsagePolicy {
  const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
  const buildExpiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : null
  switch (channel) {
    case 'public_demo':
      return { channel, wallClockMs: 30 * MINUTE, idleMs: 10 * MINUTE, debriefMs: 15 * MINUTE, buildExpiresAt, defaultClassDurationMin: 60, classDurationRangeMin: [30, 180] }
    case 'windows_evaluation':
      return { channel, wallClockMs: 14 * DAY, idleMs: null, debriefMs: 15 * MINUTE, buildExpiresAt, defaultClassDurationMin: 60, classDurationRangeMin: [30, 180] }
    case 'licensed_windows':
      return { channel, wallClockMs: null, idleMs: null, debriefMs: 15 * MINUTE, buildExpiresAt: null, defaultClassDurationMin: 60, classDurationRangeMin: [30, 180] }
    case 'classroom_pilot':
    case 'agency_training_pilot':
      return { channel, wallClockMs: 90 * DAY, idleMs: null, debriefMs: 15 * MINUTE, buildExpiresAt, defaultClassDurationMin: 60, classDurationRangeMin: [30, 180] }
    default:
      return { channel, wallClockMs: null, idleMs: null, debriefMs: 15 * MINUTE, buildExpiresAt, defaultClassDurationMin: 60, classDurationRangeMin: [30, 180] }
  }
}

export function evaluateUsagePhase(policy: UsagePolicy, clock: UsageClock, now = Date.now()): UsagePhase {
  if (policy.buildExpiresAt !== null && now >= policy.buildExpiresAt) return 'expired'
  if (clock.debriefStartedAt !== null) {
    return now - clock.debriefStartedAt >= policy.debriefMs ? 'expired' : 'debrief'
  }
  const wallExpired = policy.wallClockMs !== null && now - clock.firstSeenAt >= policy.wallClockMs
  const idleExpired = policy.idleMs !== null && now - clock.lastActivityAt >= policy.idleMs
  return wallExpired || idleExpired ? 'debrief' : 'active'
}

export function remainingUsageMs(policy: UsagePolicy, clock: UsageClock, now = Date.now()): number | null {
  if (clock.debriefStartedAt !== null) return Math.max(0, policy.debriefMs - (now - clock.debriefStartedAt))
  const candidates = [
    policy.wallClockMs === null ? null : policy.wallClockMs - (now - clock.firstSeenAt),
    policy.idleMs === null ? null : policy.idleMs - (now - clock.lastActivityAt),
    policy.buildExpiresAt === null ? null : policy.buildExpiresAt - now,
  ].filter((value): value is number => value !== null)
  return candidates.length ? Math.max(0, Math.min(...candidates)) : null
}

export function usageAllowsNewActivity(phase: UsagePhase): boolean {
  return phase === 'active'
}

export const USAGE_POLICY = buildUsagePolicy(
  resolveDistributionChannel(import.meta.env.VITE_DISTRIBUTION_CHANNEL),
  import.meta.env.VITE_LICENSE_EXPIRES_AT,
)
