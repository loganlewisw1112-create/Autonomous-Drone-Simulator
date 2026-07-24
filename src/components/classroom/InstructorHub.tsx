import { useCallback, useEffect, useState } from 'react'
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
import { ClassResultsTable } from '@/components/classroom/ClassResults'

type HubView =
  | { kind: 'list' }
  | { kind: 'history'; classroom: ClassroomMeta }
  | { kind: 'session'; classroom: ClassroomMeta; archive: ClassroomSessionArchive }

/**
 * Instructor picks or creates a durable classroom, then ClassSetup starts a live session.
 * Session history is encrypted under the instructor account key only.
 */
export function InstructorHub({ onStartLive }: { onStartLive: () => void }) {
  const { activeAccount, sessionKey, signOut } = useAuthStore(useShallow((s) => ({
    activeAccount: s.activeAccount,
    sessionKey: s.sessionKey,
    signOut: s.signOut,
  })))
  const setActiveClassroomId = useClassroomStore((s) => s.setActiveClassroomId)

  const [classrooms, setClassrooms] = useState<ClassroomMeta[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<HubView>({ kind: 'list' })
  const [sessions, setSessions] = useState<ClassroomSessionArchive[]>([])

  const reload = useCallback(async () => {
    if (!activeAccount || !sessionKey) return
    const list = await listDecryptedClassrooms(activeAccount.id, sessionKey)
    setClassrooms(list)
  }, [activeAccount, sessionKey])

  useEffect(() => { void reload() }, [reload])

  async function handleCreate() {
    if (!activeAccount || !sessionKey || busy) return
    setBusy(true)
    setError(null)
    try {
      const meta = await createClassroom(activeAccount.id, sessionKey, name)
      if (!meta) { setError('Could not create classroom'); return }
      setName('')
      await reload()
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
          <button type="button" className="cls-btn ghost" onClick={() => setView({ kind: 'list' })}>
            Back to classrooms
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="cls-center">
      <div className="cls-card" data-testid="instructor-hub">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>My classrooms</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Signed in as {activeAccount?.displayName}. Choose a classroom, then start a live LAN session.
          </div>
        </div>

        {classrooms.map((c) => (
          <div key={c.classroomId} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="cls-btn" style={{ flex: 1 }} onClick={() => void openLive(c)}>
              Open live — {c.name}
            </button>
            <button type="button" className="cls-btn ghost" onClick={() => void openHistory(c)}>
              History
            </button>
          </div>
        ))}

        <div style={{ borderTop: '1px solid var(--border, #26303f)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Create classroom</div>
          <input
            className="cls-input"
            placeholder="Class name (e.g. SAR Cohort A)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          />
          <button type="button" className="cls-btn" disabled={busy || !name.trim()} onClick={() => void handleCreate()}>
            {busy ? 'Creating…' : 'Create classroom'}
          </button>
          {error && <div style={{ color: '#ff8080', fontSize: 12 }}>{error}</div>}
        </div>

        <button type="button" className="cls-btn ghost" onClick={() => void downloadSync()}>
          Export sync envelope (cloud seam)
        </button>
        <button type="button" className="cls-btn ghost" onClick={() => signOut()}>Sign out</button>
        <a className="cls-btn ghost" href="?" style={{ textAlign: 'center', textDecoration: 'none' }}>Home</a>
      </div>
    </div>
  )
}
