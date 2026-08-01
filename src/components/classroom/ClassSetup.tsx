import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getScenarioOptions } from '@/scenarios/registry'
import { startClass } from '@/classroom/classroomClient'
import { useClassroomStore } from '@/classroom/classroomStore'
import { useAuthStore } from '@/store/authStore'
import { createClassroom, touchClassroomOpened } from '@/account/classroomArchive'
import { fetchInstructorAccessStatus } from '@/account/instructorAccessRemote'
import { getClassroomDesktopBridge } from '@/classroom/desktopBridge'
import type { ClassConfig } from '@/classroom/protocol'
import type { ScenarioVariantConfig } from '@/types'
import { useUsagePolicy } from '@/licensing/UsagePolicyGate'
import { USAGE_POLICY } from '@/licensing/usagePolicy'
import { assuranceForScenario } from '@/assurance/trainingAssurance'

function defaultVariant(seed: number): ScenarioVariantConfig {
  return {
    seed, timeOfDay: 'day', season: 'summer',
    weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  }
}

/**
 * Instructor pre-class screen (the "Start a training class" card).
 * New instructors finish the supervised access code here once; then the same
 * card reveals scenario / seed / Create class plus Access saved class(es).
 */
export function ClassSetup({
  onOpenSaved,
}: {
  onOpenSaved?: () => void
}) {
  const usagePolicy = useUsagePolicy()
  const options = useMemo(() => getScenarioOptions(), [])
  const [scenarioId, setScenarioId] = useState(options[0]?.id ?? '')
  const scenario = options.find((o) => o.id === scenarioId)?.config
  const assurance = useMemo(() => assuranceForScenario(scenario ?? null), [scenario])
  const [seed, setSeed] = useState(scenario?.seed ?? 1)
  const [durationMinutes, setDurationMinutes] = useState(USAGE_POLICY.defaultClassDurationMin)
  const [graded, setGraded] = useState(true)
  const [accessCode, setAccessCode] = useState('')
  const [relayAccessConfigured, setRelayAccessConfigured] = useState<boolean | null>(null)
  const [relayAuthenticated, setRelayAuthenticated] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const { status, error, activeClassroomId, setActiveClassroomId } = useClassroomStore(useShallow((s) => ({
    status: s.status,
    error: s.error,
    activeClassroomId: s.activeClassroomId,
    setActiveClassroomId: s.setActiveClassroomId,
  })))
  const {
    activeAccount, sessionKey, unlockInstructor, authError, clearAuthError, signOut,
  } = useAuthStore(useShallow((s) => ({
    activeAccount: s.activeAccount,
    sessionKey: s.sessionKey,
    unlockInstructor: s.unlockInstructor,
    authError: s.authError,
    clearAuthError: s.clearAuthError,
    signOut: s.signOut,
  })))

  const unlocked = activeAccount?.instructorUnlocked === true
  const sessionReady = unlocked && relayAuthenticated === true
  const desktopBridge = getClassroomDesktopBridge()
  let desktopOwnsRelay = false
  try {
    desktopOwnsRelay = desktopBridge?.getState().serverOwned === true
  } catch { /* unavailable bridge state behaves like a browser/external relay */ }
  const accessConfigured = relayAccessConfigured === true

  useEffect(() => {
    let cancelled = false
    void fetchInstructorAccessStatus().then((status) => {
      if (cancelled) return
      setRelayAccessConfigured(status?.configured ?? null)
      setRelayAuthenticated(status?.authenticated ?? false)
    })
    return () => { cancelled = true }
  }, [activeAccount?.id])

  useEffect(() => {
    if (error === 'instructor-session-required') setRelayAuthenticated(false)
  }, [error])

  function pick(id: string) {
    setScenarioId(id)
    const s = options.find((o) => o.id === id)?.config
    if (s) setSeed(s.seed)
  }

  async function handleUnlock() {
    if (busy) return
    setBusy(true)
    setLocalError(null)
    clearAuthError()
    try {
      let ok = await unlockInstructor(accessCode)
      if (!ok && desktopBridge) {
        const remote = await fetchInstructorAccessStatus()
        if (remote && !remote.configured) {
          const provisioned = await desktopBridge.provisionInstructorAccess(accessCode)
          if (provisioned.ok) {
            clearAuthError()
            ok = await unlockInstructor(accessCode)
          } else if (provisioned.error !== 'cancelled') {
            setLocalError(
              provisioned.error === 'relay-not-owned'
                ? 'This relay was started outside the desktop host. Provision it from the process that owns its administrator token.'
                : 'The local classroom relay could not provision the instructor access code.',
            )
          }
        }
      }
      if (ok) {
        setAccessCode('')
        setRelayAccessConfigured(true)
        setRelayAuthenticated(true)
      }
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    if (!scenario || !sessionReady || !activeAccount || !sessionKey || busy) return
    if (!usagePolicy.canBeginNewActivity) {
      setLocalError('The pilot/demo window is in debrief-only mode. New classes are disabled; saved records remain available.')
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      let classroomId = activeClassroomId
      if (!classroomId) {
        const meta = await createClassroom(
          activeAccount.id,
          sessionKey,
          options.find((o) => o.id === scenarioId)?.label || 'Training class',
        )
        if (!meta) {
          setLocalError('Could not create classroom on this device')
          return
        }
        classroomId = meta.classroomId
        setActiveClassroomId(classroomId)
      }
      await touchClassroomOpened(activeAccount.id, sessionKey, classroomId)
      const config: ClassConfig = { kind: 'catalog', scenarioId, variant: defaultVariant(seed), durationMinutes }
      startClass(config, graded)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cls-center">
      <div className="cls-card" data-testid="class-setup">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Start a training class</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            {sessionReady
              ? 'Students join from their own device with a 6-character code.'
              : unlocked
                ? 'Re-authenticate this relay session with the supervised access code.'
                : 'Finish instructor setup with the supervised access code, then create the class.'}
          </div>
        </div>

        {!sessionReady && (
          <div
            data-testid="instructor-unlock-section"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--border, #26303f)',
              background: 'rgba(57, 217, 138, 0.06)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>Insert access code here</div>
            <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>
              {accessConfigured
                ? 'Enter the school access code for this classroom. Relay sessions expire after eight hours and after logout, rotation, or reset.'
                : desktopOwnsRelay
                  ? 'Type the code you want for this school. The Windows host will ask for confirmation before provisioning its local relay.'
                  : 'The local classroom relay administrator must provision an access code before instructor accounts can unlock.'}
            </div>
            <input
              className="cls-input"
              type="text"
              placeholder="Insert access code here"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleUnlock()}
              data-testid="instructor-access-code"
            />
            <button
              type="button"
              className="cls-btn"
              disabled={busy || !accessCode.trim()}
              onClick={() => void handleUnlock()}
            >
              {busy ? 'Authenticating…' : unlocked ? 'Authenticate instructor' : 'Finish account setup'}
            </button>
            {(localError || authError) && (
              <div style={{ color: '#ff8080', fontSize: 12 }} data-testid="auth-error">
                {localError || authError}
              </div>
            )}
          </div>
        )}

        {sessionReady && (
          <>
            <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Scenario
              <select className="cls-select" style={{ marginTop: 4 }} value={scenarioId} onChange={(e) => pick(e.target.value)}>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Seed</div>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{seed}</code>
              <button className="cls-btn ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => setSeed(Math.floor(Math.random() * 1_000_000_000))}
                disabled={graded}
              >
                Reroll
              </button>
              <label style={{ fontSize: 12, marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={graded} onChange={(e) => setGraded(e.target.checked)} />
                Graded (lock seed)
              </label>
            </div>

            <label style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              Class time limit (minutes)
              <input
                className="cls-input"
                type="number"
                min={USAGE_POLICY.classDurationRangeMin[0]}
                max={USAGE_POLICY.classDurationRangeMin[1]}
                step={5}
                value={durationMinutes}
                onChange={(event) => setDurationMinutes(Math.max(
                  USAGE_POLICY.classDurationRangeMin[0],
                  Math.min(USAGE_POLICY.classDurationRangeMin[1], Number(event.target.value)),
                ))}
              />
              <span style={{ display: 'block', marginTop: 4 }}>
                30-180 minutes; default 60. Expiry blocks new mission starts but never deletes records or interrupts recovery/export.
              </span>
            </label>

            <div role="status" style={{ border: '1px solid var(--border-color)', padding: 10, fontSize: 11, color: 'var(--text-dim)' }}>
              <strong style={{ display: 'block', color: assurance.trainingRunAllowed ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                TRAINING ASSURANCE: {assurance.launchDisposition.replaceAll('_', ' ').toUpperCase()}
              </strong>
              {assurance.disclaimer}
              {assurance.blockers.length > 0 && <div>{assurance.blockers.length} required training input(s) are missing, stale, or invalid.</div>}
            </div>

            <button
              type="button"
              className="cls-btn"
              data-testid="create-new-class"
              disabled={!scenario || busy || status === 'connecting' || !usagePolicy.canBeginNewActivity}
              onClick={() => void create()}
            >
              {status === 'connecting' || busy ? 'Creating…' : 'Create class'}
            </button>

            {onOpenSaved && (
              <button
                type="button"
                className="cls-btn ghost"
                data-testid="access-saved-classes"
                onClick={onOpenSaved}
              >
                Access saved class(es)
              </button>
            )}

            {localError && (
              <div style={{ color: '#ff8080', fontSize: 12 }}>{localError}</div>
            )}

            {status === 'error' && (
              <div style={{ color: '#ff8080', fontSize: 12 }}>
                {error === 'not-instructor' ? 'That code is already running on this relay. Reroll and create again.'
                  : error === 'server-full' ? 'This relay is already hosting its maximum number of classes.'
                    : error === 'invalid-class-duration' ? 'Class duration must be between 30 and 180 minutes.'
                    : error === 'secure-transport-required' ? 'Trusted HTTPS/WSS is required for graded classroom sessions.'
                      : error === 'instructor-session-required' ? 'Your relay instructor session expired. Enter the school access code again.'
                    : 'Could not reach the classroom relay. Is the server running on this machine?'}
              </div>
            )}
          </>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          End-to-end encrypted to a key only this browser holds. If you lose this tab’s session,
          the class’s data is unrecoverable — that is real E2EE, not a defect.
          Ending the class archives results to your instructor account.
        </div>

        <button type="button" className="cls-btn ghost" onClick={() => signOut()}>Sign out</button>
        <a className="cls-btn ghost" href="?" style={{ textAlign: 'center', textDecoration: 'none' }}>Home</a>
      </div>
    </div>
  )
}
