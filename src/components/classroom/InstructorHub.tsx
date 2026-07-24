import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'
import { useClassroomStore } from '@/classroom/classroomStore'
import {
  createClassroom,
  listDecryptedClassrooms,
  listDecryptedSessionsForClassroom,
  touchClassroomOpened,
} from '@/account/classroomArchive'
import { exportClassroomSync } from '@/account/syncPort'
import type { ClassroomMeta, ClassroomSessionArchive } from '@/account/classroomTypes'
import { configuredInstructorAccessHash } from '@/account/instructorAccess'
import { ClassResultsTable } from '@/components/classroom/ClassResults'

type HubView =
  | { kind: 'home' }
  | { kind: 'create' }
  | { kind: 'saved' }
  | { kind: 'history'; classroom: ClassroomMeta }
  | { kind: 'session'; classroom: ClassroomMeta; archive: ClassroomSessionArchive }

/**
 * Instructor landing after sign-in — same "Start a training class" card students
 * recognize from the old ClassSetup entry. New instructors finish unlock here once;
 * then they create a new class or open saved classrooms.
 */
export function InstructorHub({ onStartLive }: { onStartLive: () => void }) {
  const {
    activeAccount, sessionKey, signOut, unlockInstructor, authError, clearAuthError,
  } = useAuthStore(useShallow((s) => ({
    activeAccount: s.activeAccount,
    sessionKey: s.sessionKey,
    signOut: s.signOut,
    unlockInstructor: s.unlockInstructor,
    authError: s.authError,
    clearAuthError: s.clearAuthError,
  })))
  const setActiveClassroomId = useClassroomStore((s) => s.setActiveClassroomId)

  const [classrooms, setClassrooms] = useState<ClassroomMeta[]>([])
  const [name, setName] = useState('')
  const [accessCode, setAccessCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<HubView>({ kind: 'home' })
  const [sessions, setSessions] = useState<ClassroomSessionArchive[]>([])

  const unlocked = Boolean(activeAccount?.instructorUnlocked)
  const unlockConfigured = useMemo(() => configuredInstructorAccessHash() !== null, [])

  const reload = useCallback(async () => {
    if (!activeAccount || !sessionKey) return
    const list = await listDecryptedClassrooms(activeAccount.id, sessionKey)
    setClassrooms(list)
  }, [activeAccount, sessionKey])

  useEffect(() => { void reload() }, [reload])

  async function handleUnlock() {
    if (busy) return
    setBusy(true)
    setError(null)
    clearAuthError()
    try {
      const ok = await unlockInstructor(accessCode)
      if (ok) setAccessCode('')
    } finally {
      setBusy(false)
    }
  }

  async function handleCreate() {
    if (!activeAccount || !sessionKey || busy) return
    setBusy(true)
    setError(null)
    try {
      const meta = await createClassroom(activeAccount.id, sessionKey, name)
      if (!meta) { setError('Could not create classroom'); return }
      setName('')
      await touchClassroomOpened(activeAccount.id, sessionKey, meta.classroomId)
      setActiveClassroomId(meta.classroomId)
      onStartLive()
    } finally {
      setBusy(false)
    }
  }

  async function openLive(classroom: ClassroomMeta) {
    if (!activeAccount || !sessionKey) return
    await touchClassroomOpened(activeAccount.id, sessionKey, classroom.classroomId)
    setActiveClassroomId(classroom.classroomId)
    onStartLive()
  }

  async function openHistory(classroom: ClassroomMeta) {
    if (!activeAccount || !sessionKey) return
    const list = await listDecryptedSessionsForClassroom(activeAccount.id, sessionKey, classroom.classroomId)
    setSessions(list)
    setView({ kind: 'history', classroom })
  }

  async function downloadSync() {
    if (!activeAccount) return
    const envelope = await exportClassroomSync(activeAccount.id)
    if (!envelope) return
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `classroom-sync-${activeAccount.username}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (view.kind === 'session') {
    return (
      <div className="cls-center">
        <div className="cls-card" style={{ maxWidth: 720, width: 'min(720px, 96vw)' }} data-testid="classroom-session-detail">
          <div style={{ fontWeight: 700 }}>
            {view.classroom.name} · session {view.archive.classId}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {new Date(view.archive.startedAt).toLocaleString()} → {new Date(view.archive.endedAt).toLocaleString()}
            {' · '}{view.archive.students.length} students
          </div>
          <ClassResultsTable
            classId={view.archive.classId}
            runs={view.archive.students.filter((s) => s.assessment && s.summary).map((s) => ({
              studentId: s.studentId,
              displayName: s.displayName,
              accountId: s.accountId,
              summary: s.summary!,
              assessment: s.assessment as unknown as import('@/classroom/missionAssessment').MissionAssessment,
              receivedAt: s.leftAt ?? view.archive.endedAt,
              incomplete: s.incomplete,
            }))}
          />
          <button type="button" className="cls-btn ghost" onClick={() => setView({ kind: 'history', classroom: view.classroom })}>
            Back to sessions
          </button>
        </div>
      </div>
    )
  }

  if (view.kind === 'history') {
    return (
      <div className="cls-center">
        <div className="cls-card" data-testid="classroom-history">
          <div style={{ fontSize: 18, fontWeight: 700 }}>{view.classroom.name} — sessions</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Archives are encrypted on this device under your instructor password.
          </div>
          {sessions.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>No archived sessions yet. End a live class to save one.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sessions.map((s) => (
                <button
                  key={s.sessionId}
                  type="button"
                  className="cls-btn ghost"
                  style={{ textAlign: 'left' }}
                  onClick={() => setView({ kind: 'session', classroom: view.classroom, archive: s })}
                >
                  Code {s.classId} · {new Date(s.endedAt).toLocaleString()} · {s.students.length} students
                </button>
              ))}
            </div>
          )}
          <button type="button" className="cls-btn" onClick={() => void openLive(view.classroom)}>
            Start live session
          </button>
          <button type="button" className="cls-btn ghost" onClick={() => setView({ kind: 'saved' })}>
            Back to saved classes
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cls-center">
      <div className="cls-card" data-testid="instructor-hub">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Start a training class</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            {unlocked
              ? 'Students join from their own device with a 6-character code.'
              : 'Finish instructor account setup with the supervised access code, then create or open a class.'}
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
              One-time unlock for this instructor account. After it succeeds, this field
              will not appear again on sign-in or when returning to this page — only when
              creating a brand-new instructor account.
            </div>
            {!unlockConfigured && (
              <div style={{ color: '#ff8080', fontSize: 12 }} data-testid="instructor-hash-missing">
                Instructor unlock is not enabled on this build. Contact the administrator who
                provisions instructor unlocks.
              </div>
            )}
            <input
              className="cls-input"
              type="password"
              placeholder="Insert access code here"
              autoComplete="off"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && void handleUnlock()}
              data-testid="instructor-access-code"
            />
            <button
              type="button"
              className="cls-btn"
              disabled={busy || !unlockConfigured || !accessCode.trim()}
              onClick={() => void handleUnlock()}
            >
              {busy ? 'Unlocking…' : 'Finish account setup'}
            </button>
            {(error || authError) && (
              <div style={{ color: '#ff8080', fontSize: 12 }} data-testid="auth-error">
                {error || authError}
              </div>
            )}
          </div>
        )}

        {unlocked && view.kind === 'home' && (
          <>
            <button
              type="button"
              className="cls-btn"
              data-testid="create-new-class"
              onClick={() => { setView({ kind: 'create' }); setError(null) }}
            >
              Create new class
            </button>
            <button
              type="button"
              className="cls-btn ghost"
              data-testid="access-saved-classes"
              onClick={() => { setView({ kind: 'saved' }); void reload() }}
            >
              Access saved class(es)
            </button>
          </>
        )}

        {unlocked && view.kind === 'create' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="create-class-form">
            <div style={{ fontSize: 12, fontWeight: 600 }}>Name this classroom</div>
            <input
              className="cls-input"
              placeholder="Class name (e.g. SAR Cohort A)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            />
            <button type="button" className="cls-btn" disabled={busy || !name.trim()} onClick={() => void handleCreate()}>
              {busy ? 'Creating…' : 'Continue to scenario'}
            </button>
            {error && <div style={{ color: '#ff8080', fontSize: 12 }}>{error}</div>}
            <button type="button" className="cls-btn ghost" onClick={() => setView({ kind: 'home' })}>
              Back
            </button>
          </div>
        )}

        {unlocked && view.kind === 'saved' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="saved-classes">
            <div style={{ fontSize: 12, fontWeight: 600 }}>Saved classrooms</div>
            {classrooms.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                No saved classrooms yet. Create a new class to start one.
              </div>
            ) : (
              classrooms.map((c) => (
                <div key={c.classroomId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" className="cls-btn" style={{ flex: 1 }} onClick={() => void openLive(c)}>
                    Open live — {c.name}
                  </button>
                  <button type="button" className="cls-btn ghost" onClick={() => void openHistory(c)}>
                    History
                  </button>
                </div>
              ))
            )}
            <button type="button" className="cls-btn ghost" onClick={() => setView({ kind: 'home' })}>
              Back
            </button>
          </div>
        )}

        {unlocked && (
          <>
            <button type="button" className="cls-btn ghost" onClick={() => void downloadSync()}>
              Export sync envelope (cloud seam)
            </button>
            <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
              End-to-end encrypted to a key only this browser holds. If you lose this tab’s session,
              the class’s data is unrecoverable — that is real E2EE, not a defect.
              Ending the class archives results to your instructor account.
            </div>
          </>
        )}

        <button type="button" className="cls-btn ghost" onClick={() => signOut()}>Sign out</button>
        <a className="cls-btn ghost" href="?" style={{ textAlign: 'center', textDecoration: 'none' }}>Home</a>
      </div>
    </div>
  )
}
