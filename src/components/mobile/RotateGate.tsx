import '@/styles/mobile.css'

// Full-screen portrait blocker. The mobile shell is landscape-only by design —
// the tactical map + drawer layout needs the wide axis. iOS Safari cannot lock
// orientation from the web, so we gate instead.
export function RotateGate() {
  return (
    <div className="rotate-gate" data-testid="rotate-gate">
      <div className="rotate-gate-phone" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="88" height="88">
          <rect x="20" y="8" width="24" height="48" rx="4" fill="none" stroke="var(--accent-blue)" strokeWidth="2.5" />
          <circle cx="32" cy="50" r="1.8" fill="var(--accent-blue)" />
          <path d="M 50 22 A 22 22 0 0 1 50 42" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" />
          <path d="M 47 39 L 50 42 L 53 39" fill="none" stroke="var(--accent-green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="rotate-gate-title">⬡ DRONE OPS CENTER</div>
      <div className="rotate-gate-msg">ROTATE DEVICE TO LANDSCAPE</div>
      <div className="rotate-gate-sub">The tactical console requires a wide field of view.</div>
    </div>
  )
}
