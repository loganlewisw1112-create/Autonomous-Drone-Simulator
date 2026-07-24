import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { PREFLIGHT_CHECKLIST } from '@/sim/mission/preflightChecklist'
import {
  AUTH_TRAINING_DISCLAIMER,
  evaluateAuthorizationTraining,
} from '@/sim/mission/authorizationTraining'
import type { AuthorizationStepId } from '@/types'

const CHECKLIST = PREFLIGHT_CHECKLIST

const CATEGORY_COLORS: Record<string, string> = {
  regulatory: 'var(--accent-yellow)',
  weather: 'var(--accent-blue)',
  vehicle: 'var(--accent-green)',
  mission: 'var(--accent-magenta)',
  crew: 'var(--text-secondary)',
}

export function PreflightChecklist() {
  const {
    ui, scenario, scenarioVariant, authorizationCompletedSteps,
    setShowPreflight, setShowLaunchBay, emitEvent,
    toggleAuthorizationStep, completeAuthorizationTraining,
  } = useDroneStore(
    useShallow((s) => ({
      ui: s.ui,
      scenario: s.scenario,
      scenarioVariant: s.scenarioVariant,
      authorizationCompletedSteps: s.authorizationCompletedSteps,
      setShowPreflight: s.setShowPreflight,
      setShowLaunchBay: s.setShowLaunchBay,
      emitEvent: s.emitEvent,
      toggleAuthorizationStep: s.toggleAuthorizationStep,
      completeAuthorizationTraining: s.completeAuthorizationTraining,
    })),
  )
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set())

  // Fresh checklist every time the modal opens — items must be confirmed per mission.
  useEffect(() => {
    if (ui.showPreflight) setCheckedIds(new Set())
  }, [ui.showPreflight])

  const authProgress = useMemo(
    () => evaluateAuthorizationTraining(scenario, scenarioVariant, authorizationCompletedSteps),
    [authorizationCompletedSteps, scenario, scenarioVariant],
  )

  if (!ui.showPreflight) return null

  const allChecked = checkedIds.size === CHECKLIST.length
  const canContinue = allChecked && authProgress.ready

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
    completeAuthorizationTraining('preflight_check_all')
  }

  function handleContinue() {
    if (!canContinue) return
    emitEvent({
      eventType: 'preflight_complete',
      droneId: 'system',
      payload: {
        scenarioId: scenario?.id,
        itemsConfirmed: CHECKLIST.length,
        categories: Array.from(new Set(CHECKLIST.map((item) => item.category))),
        authorizationStepsCompleted: authProgress.completedStepIds,
        authorizationReady: true,
        simulationOnly: true,
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
          {checkedIds.size}/{CHECKLIST.length} vehicle/mission items ·{' '}
          {authProgress.completedStepIds.length}/{authProgress.requiredStepIds.length} authorization steps
          — both must be complete before launch planning.
        </div>

        <div style={{
          marginBottom: 14,
          padding: '10px 10px 8px',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-input)',
        }}>
          <div style={{
            fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.08em',
            color: 'var(--accent-yellow)', marginBottom: 6,
          }}>
            OPERATIONAL AUTHORIZATION (SIMULATION)
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.4 }}>
            Practice the authorization workflow for this AO — RID, airspace request, ceiling,
            and any TFR / BVLOS / night flags. No real FAA network calls.
          </div>
          {authProgress.tfrExercise && (
            <div style={{
              marginBottom: 8, padding: '6px 8px', fontSize: 10, lineHeight: 1.4,
              borderLeft: '2px solid var(--accent-yellow)', color: 'var(--text-secondary)',
            }}>
              <strong style={{ color: 'var(--accent-yellow)' }}>{authProgress.tfrExercise.label}</strong>
              <div>{authProgress.tfrExercise.summary}</div>
            </div>
          )}
          {authProgress.steps.map((step) => (
            <div
              key={step.id}
              className="checklist-item"
              role="checkbox"
              aria-checked={step.completed}
              tabIndex={0}
              data-testid={`auth-step-${step.id}`}
              onClick={() => toggleAuthorizationStep(step.id as AuthorizationStepId)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  toggleAuthorizationStep(step.id as AuthorizationStepId)
                }
              }}
              style={{ cursor: 'pointer', opacity: step.completed ? 1 : 0.8 }}
            >
              <span
                className="check-icon"
                style={{
                  color: step.completed ? 'var(--accent-yellow)' : 'var(--text-dim)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {step.completed ? '✓' : '○'}
              </span>
              <span style={{ flex: 1 }}>
                <div>{step.label}</div>
                <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>{step.detail}</div>
              </span>
              <span style={{
                fontSize: 9, padding: '1px 4px', borderRadius: 2,
                background: 'var(--accent-yellow)22',
                color: 'var(--accent-yellow)',
                fontFamily: 'var(--font-mono)',
              }}>
                AUTH
              </span>
            </div>
          ))}
          <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
            {AUTH_TRAINING_DISCLAIMER}
          </div>
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
          FAA Part 107 / LAANC / UTM surfaces shown for portfolio training purposes only.
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleCheckAll} style={{ marginRight: 'auto' }} disabled={canContinue}>
            ✓ Check All
          </button>
          <button className="btn" onClick={() => setShowPreflight(false)}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleContinue}
            disabled={!canContinue}
            title={canContinue ? undefined : !authProgress.ready
              ? `${authProgress.missedStepIds.length} authorization step(s) incomplete`
              : `${CHECKLIST.length - checkedIds.size} item(s) unconfirmed`}
          >
            ✓ Checklist Complete — Assign Launch Bays
          </button>
        </div>
      </div>
    </div>
  )
}
