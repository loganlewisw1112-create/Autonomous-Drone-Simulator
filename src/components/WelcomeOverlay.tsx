import { useEffect, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import { runQuickDemo } from '@/sim/demo/quickDemo'

const WELCOME_KEY = 'drone-sim:welcome-seen:v1'

// Same guarded-storage pattern as waypointPersistence.resolveStorage (private there):
// localStorage can throw in private browsing / restricted contexts.
function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function markSeen() {
  try {
    safeStorage()?.setItem(WELCOME_KEY, '1')
  } catch {
    /* storage full or unavailable — overlay simply reappears next visit */
  }
}

// First-visit onboarding. Eager (not lazy) on purpose: it IS first-paint content
// for a cold visitor, and it's tiny with no heavy deps.
export function WelcomeOverlay() {
  const scenario = useDroneStore((s) => s.scenario)
  const [dismissed, setDismissed] = useState(() => safeStorage()?.getItem(WELCOME_KEY) === '1')

  // Loading a scenario manually (while the overlay could still show) counts as "seen".
  useEffect(() => {
    if (scenario) markSeen()
  }, [scenario])

  if (scenario || dismissed) return null

  function dismiss() {
    markSeen()
    setDismissed(true)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Welcome">
      <div className="modal" style={{ maxWidth: 470 }}>
        <div className="modal-title">⬡ Drone Ops Center</div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '0 0 10px' }}>
          A multi-drone public-safety mission simulator: deterministic flight physics, weather,
          comms degradation, airspace deconfliction, and a verifiable chain-of-custody evidence
          log — all running locally in your browser.
        </p>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, margin: '0 0 14px' }}>
          Everything here is synthetic and simulation-only — no real aircraft, airspace, or
          flight data. Launch the demo for a guided mission, or explore the full operator
          workflow yourself.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={dismiss}>
            Explore manually
          </button>
          <button
            className="btn primary"
            data-testid="welcome-launch-demo"
            onClick={() => {
              dismiss()
              runQuickDemo()
            }}
          >
            ▶ LAUNCH DEMO
          </button>
        </div>
      </div>
    </div>
  )
}
