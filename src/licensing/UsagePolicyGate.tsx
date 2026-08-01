import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { getClassroomDesktopBridge, type DesktopEntitlementState } from '@/licensing/desktopBridge'
import { EntitlementActivation } from '@/components/licensing/EntitlementActivation'
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
const DESKTOP_ENTITLEMENT_CHANNELS = new Set([
  'licensed_windows',
  'windows_evaluation',
  'classroom_pilot',
  'agency_training_pilot',
])

function readPublicDemoClock(now: number): UsageClock {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '') as Partial<UsageClock>
    if (Number.isFinite(value.firstSeenAt) && Number.isFinite(value.lastActivityAt)) {
      return {
        firstSeenAt: value.firstSeenAt as number,
        lastActivityAt: value.lastActivityAt as number,
        debriefStartedAt: Number.isFinite(value.debriefStartedAt) ? value.debriefStartedAt as number : null,
      }
    }
  } catch { /* unavailable or malformed session storage starts a fresh public demo */ }
  return { firstSeenAt: now, lastActivityAt: now, debriefStartedAt: null }
}

function writePublicDemoClock(clock: UsageClock) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(clock)) } catch { /* policy remains in memory */ }
}

function formatRemaining(ms: number | null): string {
  if (ms === null) return ''
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  if (minutes >= 48 * 60) return `${Math.ceil(minutes / (24 * 60))} days remaining`
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} hr remaining`
  return `${minutes} min remaining`
}

function entitlementWarningLabel(state: DesktopEntitlementState): string {
  if (state.status !== 'warning' || state.remainingMs === null) return ''
  if (state.remainingMs <= 15 * 60_000) return '15-MINUTE WARNING · '
  if (state.remainingMs <= 60 * 60_000) return 'ONE-HOUR WARNING · '
  return '24-HOUR WARNING · '
}

function PolicyBanner({ phase, children }: { phase: UsagePhase; children: React.ReactNode }) {
  return (
    <div role={phase === 'active' ? 'status' : 'alert'} style={{
      position: 'fixed', zIndex: 100000, top: 6, left: '50%', transform: 'translateX(-50%)',
      padding: '5px 10px', borderRadius: 4, font: '11px ui-monospace, monospace',
      background: phase === 'active' ? '#102a34ee' : '#431b1bee', color: '#fff',
      border: `1px solid ${phase === 'active' ? '#2b8296' : '#d65c5c'}`,
      maxWidth: 'min(92vw, 760px)', textAlign: 'center',
    }} data-testid="usage-policy-banner">
      {children}
    </div>
  )
}

function EntitlementBannerActions({ state }: { state: DesktopEntitlementState }) {
  const bridge = getClassroomDesktopBridge()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const refreshable = state.status === 'verification_required' || state.status === 'clock_anomaly'
  if (!bridge || (!refreshable && state.status !== 'expired')) return null
  const buttonStyle = { marginLeft: 8, minHeight: 28, border: '1px solid #fff8', borderRadius: 3, background: '#ffffff18', color: '#fff' }
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {refreshable && (
        <button type="button" style={buttonStyle} disabled={busy} onClick={() => {
          setBusy(true)
          setFeedback(null)
          void bridge.refreshEntitlement().then((result) => {
            if (!result.ok) setFeedback(' Verification failed; check Internet access or export diagnostics.')
          }).finally(() => setBusy(false))
        }}>
          {busy ? 'Verifying…' : 'Verify now'}
        </button>
      )}
      <button type="button" style={buttonStyle} disabled={busy} onClick={() => {
        setBusy(true)
        setFeedback(null)
        void bridge.exportEntitlementDiagnostics().then((result) => {
          if (!result.ok && result.error !== 'cancelled') setFeedback(' Diagnostics export failed.')
        }).finally(() => setBusy(false))
      }}>
        Export diagnostics
      </button>
      {feedback && <span role="alert">{feedback}</span>}
    </span>
  )
}

function PublicDemoPolicyGate({ children }: { children: React.ReactNode }) {
  const now = Date.now()
  const clockRef = useRef<UsageClock>(readPublicDemoClock(now))
  const [, render] = useState(0)
  const phase = evaluateUsagePhase(USAGE_POLICY, clockRef.current, now)
  const remainingMs = remainingUsageMs(USAGE_POLICY, clockRef.current, now)

  if (phase === 'debrief' && clockRef.current.debriefStartedAt === null) {
    clockRef.current.debriefStartedAt = now
    writePublicDemoClock(clockRef.current)
  }

  useEffect(() => {
    const activity = () => {
      if (evaluateUsagePhase(USAGE_POLICY, clockRef.current) !== 'active') return
      clockRef.current.lastActivityAt = Date.now()
      writePublicDemoClock(clockRef.current)
    }
    const events = ['pointerdown', 'keydown'] as const
    events.forEach((event) => window.addEventListener(event, activity, { passive: true }))
    const timer = window.setInterval(() => render((value) => value + 1), 15_000)
    writePublicDemoClock(clockRef.current)
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
  const wall = USAGE_POLICY.wallClockMs === null
    ? null
    : Math.max(0, USAGE_POLICY.wallClockMs - (now - clockRef.current.firstSeenAt))
  const idle = USAGE_POLICY.idleMs === null
    ? null
    : Math.max(0, USAGE_POLICY.idleMs - (now - clockRef.current.lastActivityAt))

  return (
    <UsagePolicyContext.Provider value={value}>
      <PolicyBanner phase={phase}>
        {phase === 'active'
          ? `PUBLIC DEMO · session: ${formatRemaining(wall)} · idle timeout: ${formatRemaining(idle)}`
          : phase === 'debrief'
            ? `DEBRIEF ONLY · New missions/classes are disabled · monitoring, recovery and exports remain available · ${formatRemaining(remainingMs)}`
            : 'DEMO WINDOW ENDED · New missions/classes are disabled · existing records are not deleted'}
      </PolicyBanner>
      {children}
    </UsagePolicyContext.Provider>
  )
}

const UNAVAILABLE_ENTITLEMENT: DesktopEntitlementState = {
  status: 'activation_required',
  tier: null,
  activatedAt: null,
  expiresAt: null,
  offlineUntil: null,
  remainingMs: null,
  canBeginNewActivity: false,
  maxStudentsPerClass: 0,
  maxConcurrentClasses: 0,
  lastTrustedAt: null,
  lastError: 'desktop-host-required',
}

function DesktopEntitlementGate({ children }: { children: React.ReactNode }) {
  const bridge = getClassroomDesktopBridge()
  const [entitlement, setEntitlement] = useState<DesktopEntitlementState>(() => {
    try { return bridge?.getEntitlementState() ?? UNAVAILABLE_ENTITLEMENT } catch { return UNAVAILABLE_ENTITLEMENT }
  })

  useEffect(() => {
    if (!bridge) return
    try { setEntitlement(bridge.getEntitlementState()) } catch { setEntitlement(UNAVAILABLE_ENTITLEMENT) }
    return bridge.subscribeEntitlementState(setEntitlement)
  }, [bridge])

  if (['activation_required', 'corrupt', 'revoked', 'unsupported_version'].includes(entitlement.status)) {
    return (
      <UsagePolicyContext.Provider value={{ phase: 'expired', canBeginNewActivity: false, remainingMs: entitlement.remainingMs }}>
        <EntitlementActivation state={entitlement} />
      </UsagePolicyContext.Provider>
    )
  }

  const phase: UsagePhase = entitlement.status === 'debrief'
    ? 'debrief'
    : entitlement.canBeginNewActivity
      ? 'active'
      : 'expired'
  const value = {
    phase,
    canBeginNewActivity: entitlement.canBeginNewActivity,
    remainingMs: entitlement.remainingMs,
  }

  return (
    <UsagePolicyContext.Provider value={value}>
      <PolicyBanner phase={phase}>
        <span>
          {entitlement.status === 'active' || entitlement.status === 'warning'
            ? `${entitlementWarningLabel(entitlement)}${entitlement.tier === 'agency_classroom_pilot' ? 'AGENCY CLASSROOM PILOT' : 'SELECTED EVALUATOR DEMO'} · ${formatRemaining(entitlement.remainingMs)} · up to ${entitlement.maxStudentsPerClass} students`
            : entitlement.status === 'debrief'
              ? `DEBRIEF ONLY · New missions/classes are disabled · recovery and exports remain available · ${formatRemaining(entitlement.remainingMs)}`
              : entitlement.status === 'verification_required'
                ? 'LICENCE VERIFICATION REQUIRED · Connect to the Internet; new missions/classes are disabled · records and exports remain available'
                : entitlement.status === 'clock_anomaly'
                  ? 'WINDOWS CLOCK CHECK REQUIRED · Restore automatic time and verify online · records and exports remain available'
                  : 'EVALUATION ENDED · New missions/classes are disabled · existing records and exports remain available'}
        </span>
        <EntitlementBannerActions state={entitlement} />
      </PolicyBanner>
      {children}
    </UsagePolicyContext.Provider>
  )
}

export function UsagePolicyGate({ children }: { children: React.ReactNode }) {
  if (USAGE_POLICY.channel === 'public_demo') return <PublicDemoPolicyGate>{children}</PublicDemoPolicyGate>
  if (DESKTOP_ENTITLEMENT_CHANNELS.has(USAGE_POLICY.channel)) {
    return <DesktopEntitlementGate>{children}</DesktopEntitlementGate>
  }
  return <UsagePolicyContext.Provider value={{ phase: 'active', canBeginNewActivity: true, remainingMs: null }}>{children}</UsagePolicyContext.Provider>
}

export function useUsagePolicy(): UsagePolicyContextValue {
  return useContext(UsagePolicyContext)
}
