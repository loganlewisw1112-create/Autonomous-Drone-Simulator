import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import App from '@/App'
import { useClassroomStore } from '@/classroom/classroomStore'
import { useAuthStore } from '@/store/authStore'
import { JoinGate } from '@/components/classroom/JoinGate'
import { ClassSetup } from '@/components/classroom/ClassSetup'
import { ClassroomHome } from '@/components/classroom/ClassroomHome'
import { ClassroomAuthGate } from '@/components/classroom/ClassroomAuthGate'
import { InstructorHub } from '@/components/classroom/InstructorHub'
import { CoordinatorConsole } from '@/components/classroom/CoordinatorConsole'
import { MissionScorecard } from '@/components/classroom/MissionScorecard'
import './classroom.css'

// Single lazy entry for the whole classroom feature. main.tsx renders this ONLY
// when the build flag is set, so the module (and its networking) never ships in the
// mobile/Windows bundles. Bare `/` opens ClassroomHome; role params open setup/join
// behind ClassroomAuthGate so the live ClassSetup / JoinGate / console stay intact.
export function ClassroomEntry({
  mode, initialClassId,
}: {
  mode: 'home' | 'student' | 'instructor'
  initialClassId?: string
}) {
  const { status, role } = useClassroomStore(useShallow((s) => ({ status: s.status, role: s.role })))

  if (mode === 'home') return <ClassroomHome />

  if (mode === 'instructor') {
    return (
      <ClassroomAuthGate requiredRole="instructor">
        <InstructorFlow status={status} role={role} />
      </ClassroomAuthGate>
    )
  }

  return (
    <ClassroomAuthGate requiredRole="student">
      <StudentFlow initialClassId={initialClassId} status={status} role={role} />
    </ClassroomAuthGate>
  )
}

function InstructorFlow({
  status,
  role,
}: {
  status: ReturnType<typeof useClassroomStore.getState>['status']
  role: ReturnType<typeof useClassroomStore.getState>['role']
}) {
  const closedError = useClassroomStore((s) => s.error)
  const [view, setView] = useState<'setup' | 'saved'>('setup')

  if (status === 'live' && role === 'instructor') return <CoordinatorConsole />

  if (status === 'closed') {
    return (
      <div className="cls-center">
        <div className="cls-card">
          <div style={{ fontWeight: 700 }}>Class ended</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            {closedError === 'archive-failed'
              ? 'Class closed, but the session archive could not be saved to this device. Check storage and try ending a class again after the next session.'
              : 'Session archive saved to this instructor account when a classroom was selected.'}
          </div>
          <button
            type="button"
            className="cls-btn"
            onClick={() => {
              setView('setup')
              useClassroomStore.getState().setStatus('idle')
            }}
          >
            Back to Start a training class
          </button>
        </div>
      </div>
    )
  }

  // Default instructor landing is ClassSetup (unlock + create). Saved list is opt-in.
  if (view === 'saved') {
    return (
      <InstructorHub
        onStartLive={() => setView('setup')}
        onBackToSetup={() => setView('setup')}
      />
    )
  }

  return (
    <ClassSetup
      onOpenSaved={() => setView('saved')}
    />
  )
}

function StudentFlow({
  initialClassId,
  status,
  role,
}: {
  initialClassId?: string
  status: ReturnType<typeof useClassroomStore.getState>['status']
  role: ReturnType<typeof useClassroomStore.getState>['role']
}) {
  if (status === 'closed') {
    return (
      <div className="cls-center">
        <div className="cls-card">
          <div style={{ fontWeight: 700 }}>Class ended</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Your instructor closed the class. You can close this tab.</div>
        </div>
      </div>
    )
  }
  if (status === 'live' && role === 'student') return <StudentLive />
  return <JoinGate initialClassId={initialClassId} />
}

function StudentLive() {
  const { classId, beingFocused, takeoverNotice, clearTakeover } = useClassroomStore(useShallow((s) => ({
    classId: s.classId,
    beingFocused: s.beingFocused,
    takeoverNotice: s.takeoverNotice,
    clearTakeover: s.clearTakeover,
  })))
  const displayName = useAuthStore((s) => s.activeAccount?.displayName)

  useEffect(() => {
    if (!takeoverNotice) return
    const remainingMs = Math.max(3_000, takeoverNotice.expiresAt - Date.now())
    const timer = window.setTimeout(() => clearTakeover(takeoverNotice.commandId), remainingMs)
    return () => window.clearTimeout(timer)
  }, [clearTakeover, takeoverNotice])

  return (
    <>
      <div
        className={`cls-banner${takeoverNotice ? ' cls-takeover-banner' : ''}`}
        role={takeoverNotice ? 'alert' : undefined}
        aria-live="assertive"
      >
        CLASS {classId} · streaming
        {displayName ? ` · ${displayName}` : ''}
        {takeoverNotice
          ? ` · ● INSTRUCTOR CONTROL — "${takeoverNotice.label}" · ${takeoverNotice.actorId}`
          : beingFocused ? ' · instructor watching' : ''}
      </div>
      <App />
      <MissionScorecard />
    </>
  )
}
