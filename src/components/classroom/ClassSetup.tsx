import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getScenarioOptions } from '@/scenarios/registry'
import { startClass } from '@/classroom/classroomClient'
import { useClassroomStore } from '@/classroom/classroomStore'
import { useAuthStore } from '@/store/authStore'
import { createClassroom, touchClassroomOpened } from '@/account/classroomArchive'
import { instructorAccessIsConfigured } from '@/account/instructorAccess'
import type { ClassConfig } from '@/classroom/protocol'
import type { ScenarioVariantConfig } from '@/types'

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
  const options = useMemo(() => getScenarioOptions(), [])
  const [scenarioId, setScenarioId] = useState(options[0]?.id ?? '')
  const scenario = options.find((o) => o.id === scenarioId)?.config
  const [seed, setSeed] = useState(scenario?.seed ?? 1)
  const [graded, setGraded] = useState(true)
  const [accessCode, setAccessCode] = useState('')
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
  const schoolUnlockConfigured = instructorAccessIsConfigured()

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
      const ok = await unlockInstructor(accessCode)
      if (ok) setAccessCode('')
    } finally {
      setBusy(false)
    }
  }

  async function create() {
    if (!scenario || !unlocked || !activeAccount || !sessionKey || busy) return
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
      const config: ClassConfig = { kind: 'catalog', scenarioId, variant: defaultVariant(seed) }
      startClass(config)
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
            {unlocked
              ? 'Students join from their own device with a 6-character code.'
              : 'Finish instructor setup with the supervised access code, then create the class.'}
          </div>
        </div>

        {!unlocked && (
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
              {schoolUnlockConfigured
                ? 'Enter the school access code for this classroom. One-time per instructor account — after it succeeds, this field will not appear again.'
                : 'Type the access code you want for this school. The first code entered here becomes the unlock code automatically — you do not create folders or hex digests.'}
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
              {busy ? 'Unlocking…' : 'Finish account setup'}
            </button>
            {(localError || authError) && (
              <div style={{ color: '#ff8080', fontSize: 12 }} data-testid="auth-error">
                {localError || authError}
              </div>
            )}
          </div>
        )}

        {unlocked && (
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

            <button
              type="button"
              className="cls-btn"
              data-testid="create-new-class"
              disabled={!scenario || busy || status === 'connecting'}
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
