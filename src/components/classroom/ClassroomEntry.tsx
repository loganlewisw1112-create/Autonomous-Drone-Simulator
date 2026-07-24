import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import App from '@/App'
import { useClassroomStore } from '@/classroom/classroomStore'
import { JoinGate } from '@/components/classroom/JoinGate'
import { ClassSetup } from '@/components/classroom/ClassSetup'
import { ClassroomHome } from '@/components/classroom/ClassroomHome'
import { CoordinatorConsole } from '@/components/classroom/CoordinatorConsole'
import { MissionScorecard } from '@/components/classroom/MissionScorecard'
import './classroom.css'

// Single lazy entry for the whole classroom feature. main.tsx renders this ONLY
// when the build flag is set, so the module (and its networking) never ships in the
// mobile/Windows bundles. Bare `/` opens ClassroomHome; role params open setup/join.
export function ClassroomEntry({
  mode, initialClassId,
}: {
  mode: 'home' | 'student' | 'instructor'
  initialClassId?: string
}) {
  const { status, role } = useClassroomStore(useShallow((s) => ({ status: s.status, role: s.role })))

  if (mode === 'home') return <ClassroomHome />

  if (mode === 'instructor') {
    return status === 'live' && role === 'instructor' ? <CoordinatorConsole /> : <ClassSetup />
  }

  // Student: join → then hand off to the normal simulator; the publisher streams
  // from the background while they fly the assigned mission.
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
        {takeoverNotice
          ? ` · ● INSTRUCTOR CONTROL — "${takeoverNotice.label}" · ${takeoverNotice.actorId}`
          : beingFocused ? ' · instructor watching' : ''}
      </div>
      <App />
      <MissionScorecard />
    </>
  )
}
