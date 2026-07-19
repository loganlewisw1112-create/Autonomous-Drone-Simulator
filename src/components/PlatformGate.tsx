import { MOBILE_APP_URL } from '@/platform/appTarget'
import '@/styles/platform-gate.css'

export function WindowsPlatformGate() {
  return (
    <main className="platform-gate" data-testid="windows-platform-gate">
      <section className="platform-gate-card" role="alert">
        <div className="platform-gate-code">ERROR</div>
        <h1>WINDOWS VERSION ONLY</h1>
        <p>
          This simulator link can only open on a Windows computer. Open it again on Windows,
          or continue with the mobile version on this device.
        </p>
        <a className="platform-gate-action" href={MOBILE_APP_URL}>
          OPEN MOBILE VERSION
        </a>
        <span className="platform-gate-note">Windows users can return to the README and choose the Windows launch link.</span>
      </section>
    </main>
  )
}
