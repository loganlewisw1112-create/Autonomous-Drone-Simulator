import { useShallow } from 'zustand/react/shallow'
import { useAuthStore } from '@/store/authStore'
import { ClassroomAuthForm } from '@/components/classroom/ClassroomAuthGate'

// Landing page for a classroom-enabled build opened with no role param.
// Sign in or create a student/instructor account here, then continue to the
// live instructor hub or student join. No WebSocket until those screens.

export function ClassroomHome() {
  const { activeAccount, signOut } = useAuthStore(useShallow((s) => ({
    activeAccount: s.activeAccount,
    signOut: s.signOut,
  })))

  if (!activeAccount || (activeAccount.role !== 'instructor' && activeAccount.role !== 'student')) {
    return (
      <div className="cls-center">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 'min(420px, 94vw)' }}>
          <div className="cls-card" data-testid="classroom-home" style={{ marginBottom: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Classroom</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4, lineHeight: 1.45 }}>
              Sign in or create an account. Students can self-register.
              New instructors insert the access code once on Start a training class.
            </div>
          </div>
          <ClassroomAuthForm allowRoleSwitch />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45, padding: '0 4px' }}>
            Live multi-device sessions need the LAN relay
            (<code style={{ fontFamily: 'var(--font-mono)' }}>npm run classroom</code>).
            Ops Center: <a href="?app=1" style={{ color: 'inherit' }}>?app=1</a>.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cls-center">
      <div className="cls-card" data-testid="classroom-home">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Classroom</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Signed in as <strong style={{ color: 'var(--text-primary)' }}>{activeAccount.displayName}</strong>
            {' · '}{activeAccount.role}
          </div>
        </div>

        {activeAccount.role === 'instructor' ? (
          <a className="cls-btn" href="?coordinator=1" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Continue to Start a training class
          </a>
        ) : (
          <a className="cls-btn" href="?join=" style={{ textAlign: 'center', textDecoration: 'none' }}>
            Continue to join a class
          </a>
        )}

        <button type="button" className="cls-btn ghost" onClick={() => signOut()}>
          Sign out
        </button>

        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>
          Live multi-device sessions need the LAN relay
          (<code style={{ fontFamily: 'var(--font-mono)' }}>npm run classroom</code>).
          Ops Center: <a href="?app=1" style={{ color: 'inherit' }}>?app=1</a>.
        </div>
      </div>
    </div>
  )
}
