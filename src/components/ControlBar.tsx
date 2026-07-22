import { lazy, Suspense, useState } from 'react'
import { FleetRetaskReview } from '@/components/FleetRetaskReview'
import { useMissionControls } from '@/hooks/useMissionControls'
import { useScenarioOptions } from '@/scenarios/registry'
import type { OperatorRole, SimSpeed, ScenarioVariantConfig } from '@/types'

const ROLE_LABELS: Record<OperatorRole, string> = {
  pic: 'PIC',
  mission_commander: 'MC',
  observer: 'OBS',
}

const CustomMissionHub = lazy(() => import('@/components/designer/CustomMissionHub').then((module) => ({ default: module.CustomMissionHub })))

export function ControlBar() {
  const {
    ui, scenario, events, drones, lifecycle, operatorRole, weatherState, scenarioVariant, investorDemo, lastRouteChange,
    latestFleetRetaskResult, fleetRetaskUndo,
    setSimSpeed, setOperatorRole, setInvestorDemoEnabled,
    exportStatus, canStart, canAbort, canStop, canRetaskFleet, launchReady, allLanded,
    handleStart, handleAbort, handlePause, handleResume, handleEndMission, handleUndoRouteChange,
    handleFleetRetask, handleUndoRetask,
    handleScenarioChange, handleVariantChange, handleRandomizeSeed, handleDemoReset,
    handleExportLog, handleExportKML, handleExportGeoJSON, handleExportAfterAction,
  } = useMissionControls()

  const scenarioOptions = useScenarioOptions()
  const [showVariant, setShowVariant] = useState(false)
  const [showDesigner, setShowDesigner] = useState(false)

  return (
    <div className="control-dock" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Weather variant strip — visible when scenario loaded, collapsed by default */}
      {scenario && !ui.isRunning && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-color)',
          padding: '3px 12px', fontFamily: 'var(--font-mono)', fontSize: 9,
        }}>
          <button
            onClick={() => setShowVariant((v) => !v)}
            style={{
              background: 'none', border: '1px solid var(--border-color)', borderRadius: 3,
              color: 'var(--accent-blue)', fontSize: 9, padding: '1px 6px', cursor: 'pointer',
            }}
          >
            ⛅ WEATHER {showVariant ? '▲' : '▼'}
          </button>

          {showVariant && (
            <>
              <span style={{ color: 'var(--text-dim)' }}>SEED</span>
              <input
                type="number"
                value={scenarioVariant.seed}
                onChange={(e) => handleVariantChange({ seed: Number(e.target.value) })}
                style={{ width: 72, background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 4px' }}
              />
              <button className="btn" onClick={handleRandomizeSeed} style={{ fontSize: 9, padding: '1px 5px' }}>🎲</button>

              <span style={{ color: 'var(--text-dim)' }}>SEV</span>
              <div className="btn-group">
                {([0, 1, 2, 3] as const).map((s) => (
                  <button
                    key={s}
                    className={`btn${scenarioVariant.weatherSeverity === s ? ' active' : ''}`}
                    onClick={() => handleVariantChange({ weatherSeverity: s })}
                    style={{ fontSize: 9, padding: '1px 5px' }}
                  >
                    {['CLR', 'LGT', 'MOD', 'SVR'][s]}
                  </button>
                ))}
              </div>

              <span style={{ color: 'var(--text-dim)' }}>TIME</span>
              <select
                value={scenarioVariant.timeOfDay}
                onChange={(e) => handleVariantChange({ timeOfDay: e.target.value as ScenarioVariantConfig['timeOfDay'] })}
                style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 9, padding: '1px 3px' }}
              >
                {(['dawn', 'day', 'dusk', 'night'] as const).map((t) => (
                  <option key={t} value={t}>{t.toUpperCase()}</option>
                ))}
              </select>

              <span style={{ color: 'var(--text-dim)' }}>COMMS</span>
              <div className="btn-group">
                {([0, 1, 2] as const).map((s) => (
                  <button
                    key={s}
                    className={`btn${scenarioVariant.commsDegradation === s ? ' active' : ''}`}
                    onClick={() => handleVariantChange({ commsDegradation: s })}
                    style={{ fontSize: 9, padding: '1px 5px' }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Always show active hazards summary */}
          {weatherState.activeHazards.length > 0 && (
            <span style={{ color: 'var(--accent-yellow)', marginLeft: 4 }}>
              ⚠ {weatherState.activeHazards.join(', ')}
            </span>
          )}
          {weatherState.activeHazards.length === 0 && (
            <span style={{ color: 'var(--text-dim)' }}>Clear conditions</span>
          )}
        </div>
      )}

      {/* Main control bar */}
      <div className="control-bar">
        {/* Scenario selector */}
        <select
          className="scenario-select"
          value={scenario?.id ?? ''}
          onChange={(e) => handleScenarioChange(e.target.value)}
        >
          <option value="" disabled>— Load Scenario —</option>
          {scenarioOptions.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button className="btn" onClick={() => setShowDesigner(true)} title="Create or load a saved custom mission">
          ＋ CUSTOM MISSION
        </button>

        <div className="control-divider" />

        {/* Operator role selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>ROLE</span>
          <div className="btn-group">
            {(['pic', 'mission_commander', 'observer'] as OperatorRole[]).map((role) => (
              <button
                key={role}
                className={`btn${operatorRole === role ? ' active' : ''}`}
                onClick={() => setOperatorRole(role)}
                title={role === 'pic' ? 'Pilot in Command — full authority' : role === 'mission_commander' ? 'Mission Commander — can RTB/stop' : 'Observer — read-only'}
              >
                {ROLE_LABELS[role]}
              </button>
            ))}
          </div>
        </div>

        <div className="control-divider" />

        <button
          className={`btn${investorDemo.enabled ? ' active' : ''}`}
          onClick={() => setInvestorDemoEnabled(!investorDemo.enabled)}
          disabled={!scenario}
          title="Show or hide the guided tour strip that tracks mission milestones (simulation only)"
        >
          GUIDED TOUR
        </button>
        <button className="btn" onClick={handleDemoReset} disabled={!scenario} title="Reset transient state and saved waypoint drafts for a clean demo run">
          DEMO RESET
        </button>
        <button className="btn" onClick={handleExportAfterAction} disabled={!scenario} title="Export after-action mission package as JSON">
          AFTER ACTION
        </button>
        {exportStatus && (
          <span className="export-status" data-testid="export-status">{exportStatus}</span>
        )}

        <div className="control-divider" />
        {/* Mission controls */}
        <button
          className="btn primary"
          onClick={handleStart}
          disabled={!scenario || !canStart || !launchReady}
          title={!canStart ? 'PIC role required' : !launchReady ? 'Complete launch bay planning first' : undefined}
        >
          ▶ START
        </button>
        <button className="btn warning" onClick={handleAbort} disabled={!ui.isRunning || !canAbort}>
          ⬆ RTB ALL
        </button>
        <button
          className="btn primary"
          onClick={handleFleetRetask}
          disabled={!scenario || drones.length === 0 || !canRetaskFleet}
          title={!canRetaskFleet ? 'PIC role required' : 'Apply the Route Advisor fleet plan'}
        >
          ⟳ RETASK FLEET
        </button>
        {lifecycle === 'paused' ? (
          <button className="btn primary" onClick={handleResume} disabled={!canStop}>
            ▶ RESUME
          </button>
        ) : (
          <button className="btn" onClick={handlePause} disabled={!ui.isRunning || !canStop}>
            ⏸ PAUSE
          </button>
        )}
        <button
          className="btn danger"
          onClick={handleEndMission}
          disabled={!canStop || !(ui.isRunning || lifecycle === 'paused')}
        >
          ■ END MISSION
        </button>
        {lastRouteChange && lastRouteChange.source !== 'fleet_retask' && (
          <button className="btn" onClick={handleUndoRouteChange} title="Restore the routes from before the latest route change">
            ↶ UNDO ROUTE
          </button>
        )}

        <div className="control-divider" />

        {/* Speed */}
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>SIM</span>
        <div className="btn-group">
          {([1, 5, 10, 20] as SimSpeed[]).map((s) => (
            <button
              key={s}
              className={`btn${ui.simSpeed === s ? ' active' : ''}`}
              onClick={() => setSimSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="control-divider" />

        {/* Exports */}
        <button className="btn" onClick={handleExportLog} disabled={events.length === 0} title="Export chain-of-custody log as JSONL">
          📋 CUSTODY LOG
        </button>
        <button className="btn" onClick={handleExportKML} disabled={drones.length === 0} title="Export full flight path as KML">
          🗺 KML
        </button>
        <button className="btn" onClick={handleExportGeoJSON} disabled={drones.length === 0} title="Export mission as GeoJSON">
          ⬡ GeoJSON
        </button>

        <div style={{ flex: 1 }} />

        {/* Status */}
        {scenario && !ui.isRunning && !launchReady && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--accent-yellow)' }}>
            ⚠ BAY PLAN REQUIRED
          </span>
        )}
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color: ui.isRunning ? 'var(--accent-green)' : allLanded ? 'var(--accent-blue)' : 'var(--text-dim)',
        }}>
          {ui.isRunning ? '● MISSION ACTIVE' : allLanded ? '● ALL LANDED' : '○ STANDBY'}
        </span>
      </div>
      <FleetRetaskReview
        result={latestFleetRetaskResult}
        undoUntil={fleetRetaskUndo?.undoUntil}
        onUndo={handleUndoRetask}
      />
      {showDesigner && <Suspense fallback={null}><CustomMissionHub onClose={() => setShowDesigner(false)} /></Suspense>}
    </div>
  )
}
