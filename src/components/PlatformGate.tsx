import { MOBILE_APP_URL } from '@/platform/appTarget'
import '@/styles/platform-gate.css'

export function DesktopPlatformGate() {
  return (
    <main className="platform-gate" data-testid="desktop-platform-gate">
      <section className="platform-gate-card" role="alert">
        <div className="platform-gate-code">ERROR</div>
        <h1>DESKTOP VERSION ONLY</h1>
        <p>
          This simulator link opens on Windows and Mac computers. Open it again on a desktop
          or laptop, or continue with the mobile version on this device.
        </p>
        <a className="platform-gate-action" href={MOBILE_APP_URL}>
          OPEN MOBILE VERSION
        </a>
        <span className="platform-gate-note">Windows and Mac users can return to the README and choose the Desktop launch link.</span>
      </section>
    </main>
  )
}

/** Classroom sessions are Windows laptop/desktop only — no phones or tablets. */
export function ClassroomWindowsGate() {
  return (
    <main className="platform-gate" data-testid="classroom-windows-gate">
      <section className="platform-gate-card" role="alert">
        <div className="platform-gate-code">ERROR</div>
        <h1>WINDOWS CLASSROOM ONLY</h1>
        <p>
          Classroom training runs on Windows laptops and desktops only. Open this link again on
          a Windows PC. Phones and tablets are not supported for class sessions.
        </p>
        <a className="platform-gate-action" href={MOBILE_APP_URL}>
          OPEN SOLO MOBILE SIMULATOR
        </a>
        <span className="platform-gate-note">
          Use the solo mobile simulator for individual practice — not for live multi-student class.
        </span>
      </section>
    </main>
  )
}
