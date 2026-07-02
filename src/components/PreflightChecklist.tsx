import { useDroneStore } from '@/store/droneStore'

const CHECKLIST = [
  { id: 1, text: 'Remote pilot certificate verified', category: 'regulatory' },
  { id: 2, text: 'Airspace authorization confirmed (LAANC/Part 107)', category: 'regulatory' },
  { id: 3, text: 'Weather briefing reviewed — wind < 25 knots', category: 'weather' },
  { id: 4, text: 'NOTAM check complete for operating area', category: 'regulatory' },
  { id: 5, text: 'Battery fully charged (≥95%)', category: 'vehicle' },
  { id: 6, text: 'Propellers inspected — no damage', category: 'vehicle' },
  { id: 7, text: 'GPS satellite lock confirmed (≥8 sats)', category: 'vehicle' },
  { id: 8, text: 'Compass calibration verified', category: 'vehicle' },
  { id: 9, text: 'Geofences loaded and active', category: 'mission' },
  { id: 10, text: 'Mission waypoints reviewed', category: 'mission' },
  { id: 11, text: 'Lost-link procedure confirmed: RTB at 30s', category: 'mission' },
  { id: 12, text: 'Observers briefed and in position', category: 'crew' },
]

const CATEGORY_COLORS: Record<string, string> = {
  regulatory: 'var(--accent-yellow)',
  weather: 'var(--accent-blue)',
  vehicle: 'var(--accent-green)',
  mission: 'var(--accent-magenta)',
  crew: 'var(--text-secondary)',
}

export function PreflightChecklist() {
  const { ui, scenario, setShowPreflight, setShowLaunchBay } = useDroneStore()
  if (!ui.showPreflight) return null

  function handleContinue() {
    setShowPreflight(false)
    setShowLaunchBay(true)
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowPreflight(false)}>
      <div className="modal">
        <div className="modal-title">⚙ Pre-Flight Checklist</div>
        <div style={{ marginBottom: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
          Scenario: <strong style={{ color: 'var(--text-primary)' }}>{scenario?.name}</strong>
          {' · '}
          Drones: <strong style={{ color: 'var(--text-primary)' }}>{scenario?.droneCount}</strong>
          {' · '}
          Seed: <strong style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>{scenario?.seed}</strong>
        </div>

        {CHECKLIST.map((item) => (
          <div key={item.id} className="checklist-item">
            <span className="check-icon" style={{ color: CATEGORY_COLORS[item.category] }}>✓</span>
            <span style={{ flex: 1 }}>{item.text}</span>
            <span style={{
              fontSize: 9, padding: '1px 4px', borderRadius: 2,
              background: CATEGORY_COLORS[item.category] + '22',
              color: CATEGORY_COLORS[item.category],
              fontFamily: 'var(--font-mono)',
            }}>
              {item.category.toUpperCase()}
            </span>
          </div>
        ))}

        {scenario?.perDroneMissionRoles && Object.keys(scenario.perDroneMissionRoles).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-blue)', marginBottom: 6, letterSpacing: '0.08em' }}>
              DRONE ASSIGNMENTS
            </div>
            <div style={{ display: 'grid', gap: 4 }}>
              {Object.entries(scenario.perDroneMissionRoles).map(([droneId, role]) => (
                <div key={droneId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 10 }}>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontWeight: 700,
                    color: 'var(--accent-yellow)', minWidth: 56,
                  }}>
                    {droneId.toUpperCase()}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{role}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{
          marginTop: 16,
          padding: '8px 10px',
          background: 'var(--bg-input)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 10,
          color: 'var(--text-dim)',
          fontFamily: 'var(--font-mono)',
        }}>
          ⚠ SIMULATION ONLY — Not for operational deployment. All data synthetic.
          FAA Part 107 compliance shown for portfolio demonstration purposes.
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setShowPreflight(false)}>Cancel</button>
          <button className="btn primary" onClick={handleContinue}>
            ✓ Checklist Complete — Assign Launch Bays
          </button>
        </div>
      </div>
    </div>
  )
}
