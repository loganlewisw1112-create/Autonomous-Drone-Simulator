// Landing page for a classroom-enabled build opened with no role param.
// Choosing a role only changes the URL — ClassroomEntry remounts into ClassSetup or JoinGate.
// No WebSocket, no keys, no class state until the user continues from those screens.

export function ClassroomHome() {
  return (
    <div className="cls-center">
      <div className="cls-card">
        <div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>Classroom</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
            Instructor dashboard or student join — pick a role to continue.
          </div>
        </div>

        <a className="cls-btn" href="?coordinator=1" style={{ textAlign: 'center', textDecoration: 'none' }}>
          Instructor — start a class
        </a>
        <a
          className="cls-btn ghost"
          href="?join="
          style={{ textAlign: 'center', textDecoration: 'none' }}
        >
          Student — join with a code
        </a>

        <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.45 }}>
          Live multi-device sessions need the LAN relay on the instructor machine
          (<code style={{ fontFamily: 'var(--font-mono)' }}>npm run classroom</code>).
          This hosted page is the classroom client; the ordinary Ops Center is at{' '}
          <a href="?app=1" style={{ color: 'inherit' }}>?app=1</a>.
        </div>
      </div>
    </div>
  )
}
