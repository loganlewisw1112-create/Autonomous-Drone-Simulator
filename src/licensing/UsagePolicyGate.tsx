import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  evaluateUsagePhase,
  remainingUsageMs,
  usageAllowsNewActivity,
  USAGE_POLICY,
  type UsageClock,
  type UsagePhase,
} from './usagePolicy'

interface UsagePolicyContextValue {
  phase: UsagePhase
  canBeginNewActivity: boolean
  remainingMs: number | null
}

const UsagePolicyContext = createContext<UsagePolicyContextValue>({
  phase: 'active',
  canBeginNewActivity: true,
  remainingMs: null,
})

const STORAGE_KEY = `drone-sim-usage-clock-v1:${USAGE_POLICY.channel}:${USAGE_POLICY.buildExpiresAt ?? 'rolling'}`

function policyStorage(): Storage {
  return USAGE_POLICY.channel === 'public_demo' ? sessionStorage : localStorage
}

function readClock(now: number): UsageClock {
  try {
    const value = JSON.parse(policyStorage().getItem(STORAGE_KEY) ?? '') as Partial<UsageClock>
    if (Number.isFinite(value.firstSeenAt) && Number.isFinite(value.lastActivityAt)) {
      return {
        firstSeenAt: value.firstSeenAt as number,
        lastActivityAt: value.lastActivityAt as number,
        debriefStartedAt: Number.isFinite(value.debriefStartedAt) ? value.debriefStartedAt as number : null,
      }
    }
  } catch { /* unavailable or malformed storage starts a fresh non-destructive clock */ }
  return { firstSeenAt: now, lastActivityAt: now, debriefStartedAt: null }
}

function writeClock(clock: UsageClock) {
  try { policyStorage().setItem(STORAGE_KEY, JSON.stringify(clock)) } catch { /* policy remains in memory */ }
}

function formatRemaining(ms: number | null): string {
  if (ms === null) return ''
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes >= 48 * 60) return `${Math.ceil(minutes / (24 * 60))} days remaining`
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} hr remaining`
  return `${minutes} min remaining`
}

function activeCountdown(clock: UsageClock, now: number): string {
  if (USAGE_POLICY.channel === 'public_demo') {
    const wall = USAGE_POLICY.wallClockMs === null
      ? null
      : Math.max(0, USAGE_POLICY.wallClockMs - (now - clock.firstSeenAt))
    const idle = USAGE_POLICY.idleMs === null
      ? null
      : Math.max(0, USAGE_POLICY.idleMs - (now - clock.lastActivityAt))
    return `session: ${formatRemaining(wall)} · idle timeout: ${formatRemaining(idle)}`
  }
  return formatRemaining(remainingUsageMs(USAGE_POLICY, clock, now))
}

export function UsagePolicyGate({ children }: { children: React.ReactNode }) {
  const now = Date.now()
  const clockRef = useRef<UsageClock>(readClock(now))
  const [, render] = useState(0)
  const phase = evaluateUsagePhase(USAGE_POLICY, clockRef.current, now)
  const remainingMs = remainingUsageMs(USAGE_POLICY, clockRef.current, now)

  if (phase === 'debrief' && clockRef.current.debriefStartedAt === null) {
    clockRef.current.debriefStartedAt = now
    writeClock(clockRef.current)
  }

  useEffect(() => {
    if (USAGE_POLICY.channel === 'development') return
    const activity = () => {
      if (evaluateUsagePhase(USAGE_POLICY, clockRef.current) !== 'active') return
      clockRef.current.lastActivityAt = Date.now()
      writeClock(clockRef.current)
    }
    const events = ['pointerdown', 'keydown'] as const
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }))
    const timer = window.setInterval(() => render((value) => value + 1), 15_000)
    writeClock(clockRef.current)
    return () => {
      events.forEach((event) => window.removeEventListener(event, activity))
      window.clearInterval(timer)
    }
  }, [])

  const value = useMemo<UsagePolicyContextValue>(() => ({
    phase,
    canBeginNewActivity: usageAllowsNewActivity(phase),
    remainingMs,
  }), [phase, remainingMs])

  return (
    <UsagePolicyContext.Provider value={value}>
      {USAGE_POLICY.channel !== 'development' && (
        <div role={phase === 'active' ? 'status' : 'alert'} style={{
          position: 'fixed', zIndex: 100000, top: 6, left: '50%', transform: 'translateX(-50%)',
          padding: '5px 10px', borderRadius: 4, font: '11px ui-monospace, monospace',
          background: phase === 'active' ? '#102a34ee' : '#431b1bee', color: '#fff',
          border: `1px solid ${phase === 'active' ? '#2b8296' : '#d65c5c'}`,
          maxWidth: 'min(92vw, 760px)', textAlign: 'center',
        }} data-testid="usage-policy-banner">
          {phase === 'active'
            ? `${USAGE_POLICY.channel.replaceAll('_', ' ').toUpperCase()} · ${activeCountdown(clockRef.current, now)}`
            : phase === 'debrief'
              ? `DEBRIEF ONLY · New missions/classes are disabled · monitoring, recovery and exports remain available · ${formatRemaining(remainingMs)}`
              : 'LICENSE / DEMO WINDOW ENDED · New missions/classes are disabled · existing records are not deleted'}
        </div>
      )}
      {children}
    </UsagePolicyContext.Provider>
  )
}

export function useUsagePolicy(): UsagePolicyContextValue {
  return useContext(UsagePolicyContext)
}
