import { useShallow } from 'zustand/react/shallow'
import App from '@/App'
import { useClassroomStore } from '@/classroom/classroomStore'
import { JoinGate } from '@/components/classroom/JoinGate'
import { ClassSetup } from '@/components/classroom/ClassSetup'
import { CoordinatorConsole } from '@/components/classroom/CoordinatorConsole'
import { MissionScorecard } from '@/components/classroom/MissionScorecard'
import './classroom.css'

// Single lazy entry for the whole classroom feature. main.tsx renders this ONLY
// when the build flag is set AND a classroom URL param is present, so the module
// (and its networking) never ships in a normal load or the mobile/Windows bundles.
export function ClassroomEntry({ mode, initialClassId }: { mode: 'student' | 'instructor'; initialClassId?: string }) {
  const { status, role } = useClassroomStore(useShallow((s) => ({ status: s.status, role: s.role })))

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
  const { classId, beingFocused } = useClassroomStore(useShallow((s) => ({ classId: s.classId, beingFocused: s.beingFocused })))
  return (
    <>
      <div className="cls-banner">CLASS {classId} · streaming{beingFocused ? ' · instructor watching' : ''}</div>
      <App />
      <MissionScorecard />
    </>
  )
}
