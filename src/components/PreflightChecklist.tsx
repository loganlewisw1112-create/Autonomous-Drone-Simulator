import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { PREFLIGHT_CHECKLIST } from '@/sim/mission/preflightChecklist'

const CHECKLIST = PREFLIGHT_CHECKLIST

const CATEGORY_COLORS: Record<string, string> = {
  regulatory: 'var(--accent-yellow)',
  weather: 'var(--accent-blue)',
  vehicle: 'var(--accent-green)',
  mission: 'var(--accent-magenta)',
  crew: 'var(--text-secondary)',
}

export function PreflightChecklist() {
  const { ui, scenario, setShowPreflight, setShowLaunchBay, emitEvent } = useDroneStore(
    useShallow((s) => ({
      ui: s.ui, scenario: s.scenario, setShowPreflight: s.setShowPreflight,
      setShowLaunchBay: s.setShowLaunchBay, emitEvent: s.emitEvent,
    })),
  )
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  // Fresh checklist every time the modal opens — items must be confirmed per mission.
  useEffect(() => {
    if (ui.showPreflight) setCheckedIds(new Set())
  }, [ui.showPreflight])

  if (!ui.showPreflight) return null

  const allChecked = checkedIds.size === CHECKLIST.length

  function toggleItem(id: number) {
    setCheckedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleCheckAll() {
    setCheckedIds(new Set(CHECKLIST.map((item) => item.id)))
  }

  function handleContinue() {
    if (!allChecked) return
    emitEvent({
      eventType: 'preflight_complete',
      droneId: 'system',
      payload: {
        scenarioId: scenario?.id,
        itemsConfirmed: CHECKLIST.length,
        categories: Array.from(new Set(CHECKLIST.map((item) => item.category))),
      },
    })
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
        <div style={{ marginBottom: 10, fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
          {checkedIds.size}/{CHECKLIST.length} items confirmed — each item must be checked before launch planning.
        </div>

        {CHECKLIST.map((item) => {
          const checked = checkedIds.has(item.id)
          return (
            <div
              key={item.id}
              className="checklist-item"
              role="checkbox"
              aria-checked={checked}
              tabIndex={0}
              onClick={() => toggleItem(item.id)}
              onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleItem(item.id) } }}
              style={{ cursor: 'pointer', opacity: checked ? 1 : 0.75 }}
            >
              <span
                className="check-icon"
                style={{
                  color: checked ? CATEGORY_COLORS[item.category] : 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {checked ? '✓' : '○'}
              </span>
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
          )
        })}

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
          <button className="btn" onClick={handleCheckAll} style={{ marginRight: 'auto' }} disabled={allChecked}>
            ✓ Check All
          </button>
          <button className="btn" onClick={() => setShowPreflight(false)}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleContinue}
            disabled={!allChecked}
            title={allChecked ? undefined : `${CHECKLIST.length - checkedIds.size} item(s) unconfirmed`}
          >
            ✓ Checklist Complete — Assign Launch Bays
          </button>
        </div>
      </div>
    </div>
  )
}
