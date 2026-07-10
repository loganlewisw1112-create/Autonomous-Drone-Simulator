import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { SCENARIO_OPTIONS } from '@/scenarios/catalog'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { exportChainAsJsonl } from '@/utils/chainOfCustody'
import { buildFullKML } from '@/utils/kmlExport'
import { buildGeoJSON } from '@/utils/geojsonExport'
import { buildAfterActionPackage, serializeAfterActionPackage } from '@/sim/demo/missionReport'
import type { OperatorRole, SimSpeed, ScenarioVariantConfig } from '@/types'

const ROLE_LABELS: Record<OperatorRole, string> = {
  pic: 'PIC',
  mission_commander: 'MC',
  observer: 'OBS',
}

export function ControlBar() {
  const {
    ui, scenario, events, drones, positionHistory, thermalContacts, operatorRole,
    launchPlan, weatherState, scenarioVariant, metrics, elapsedSec, replaySession, investorDemo,
    setRunning, setSimSpeed, setScenario, setShowPreflight, setOperatorRole,
    setWeatherState, setScenarioVariant, resetInvestorDemo, setInvestorDemoEnabled,
  } = useDroneStore(
    useShallow((s) => ({
      ui: s.ui, scenario: s.scenario, events: s.events, drones: s.drones,
      positionHistory: s.positionHistory, thermalContacts: s.thermalContacts, operatorRole: s.operatorRole,
      launchPlan: s.launchPlan, weatherState: s.weatherState, scenarioVariant: s.scenarioVariant,
      metrics: s.metrics, elapsedSec: s.elapsedSec, replaySession: s.replaySession, investorDemo: s.investorDemo,
      setRunning: s.setRunning, setSimSpeed: s.setSimSpeed, setScenario: s.setScenario,
      setShowPreflight: s.setShowPreflight, setOperatorRole: s.setOperatorRole,
      setWeatherState: s.setWeatherState, setScenarioVariant: s.setScenarioVariant,
      resetInvestorDemo: s.resetInvestorDemo, setInvestorDemoEnabled: s.setInvestorDemoEnabled,
    })),
  )

  const [showVariant, setShowVariant] = useState(false)
  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const canStart = operatorRole === 'pic'
  const canAbort = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const canStop  = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const launchReady = launchPlan?.readyToLaunch === true

  function handleStart() {
    if (!scenario || !launchReady) return
    // Issue the coordinated launch command: parked drones enter the 'preflight'
    // hold and lift off on their staggered schedule (see beginLaunchSequence +
    // MissionManager). No more all-at-once takeoff from stacked spawn points.
    useDroneStore.getState().beginLaunchSequence()
    setRunning(true)
    startSimLoop()
  }

  function handleAbort() {
    setRunning(false)
    stopSimLoop()
    const { updateDrone, drones: currentDrones } = useDroneStore.getState()
    currentDrones.forEach((d) => {
      if (!['landed', 'idle'].includes(d.missionState)) {
        updateDrone(d.id, { missionState: 'return_to_base', currentWaypointIndex: 0 })
      }
    })
    setRunning(true)
    startSimLoop()
  }

  function handleStop() {
    setRunning(false)
    stopSimLoop()
  }

  function handleScenarioChange(id: string) {
    const found = SCENARIO_OPTIONS.find((s) => s.id === id)
    if (!found) return
    handleStop()
    setScenario(found.config)
    // Apply current variant to this scenario's profile
    if (found.config.weatherProfile) {
      const ws = buildWeatherState(found.config.weatherProfile, scenarioVariant)
      setWeatherState(ws)
    }
    // Zustand writes are synchronous — initFleet reads the scenario set above directly.
    initFleet()
    setShowPreflight(true)
  }

  function handleVariantChange(patch: Partial<ScenarioVariantConfig>) {
    const next = { ...scenarioVariant, ...patch }
    setScenarioVariant(next)
    if (scenario?.weatherProfile) {
      setWeatherState(buildWeatherState(scenario.weatherProfile, next))
    }
  }

  function handleRandomizeSeed() {
    handleVariantChange({ seed: Math.floor(Math.random() * 0xffffff) })
  }

  function handleDemoReset() {
    stopSimLoop()
    resetInvestorDemo()
    if (scenario) initFleet()
  }

  function handleExportLog() {
    triggerDownload(
      exportChainAsJsonl(events),
      `custody-log-${scenario?.id ?? 'mission'}-${Date.now()}.jsonl`,
      'application/jsonl',
    )
  }

  function handleExportKML() {
    if (!drones.length || !scenario) return
    const kml = buildFullKML(drones, positionHistory, scenario, thermalContacts)
    triggerDownload(kml, `mission-${scenario.id}-${Date.now()}.kml`, 'application/vnd.google-earth.kml+xml')
  }

  function handleExportGeoJSON() {
    if (!drones.length || !scenario) return
    const geojson = buildGeoJSON(drones, positionHistory, scenario, thermalContacts)
    triggerDownload(geojson, `mission-${scenario.id}-${Date.now()}.geojson`, 'application/geo+json')
  }

  function handleExportAfterAction() {
    const packageData = buildAfterActionPackage({
      scenario,
      scenarioVariant,
      drones,
      metrics,
      thermalContacts,
      events,
      elapsedSec,
      replayFrameCount: replaySession?.frames.length ?? 0,
      positionHistory,
      replaySession,
    })
    triggerDownload(
      serializeAfterActionPackage(packageData),
      `after-action-${scenario?.id ?? 'mission'}-${Date.now()}.json`,
      'application/json',
    )
  }
  function triggerDownload(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setExportStatus(filename.startsWith('after-action') ? 'AFTER ACTION READY' : 'EXPORT READY')
    window.setTimeout(() => setExportStatus(null), 4500)
    window.setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
  }

  const allLanded = drones.length > 0 && drones.every((d) => ['idle', 'landed'].includes(d.missionState))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
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
          {SCENARIO_OPTIONS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>

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
          title="Show or hide the guided investor demo spine"
        >
          DEMO MODE
        </button>
        <button className="btn" onClick={handleDemoReset} disabled={!scenario} title="Reset transient state and saved waypoint drafts for a clean demo run">
          DEMO RESET
        </button>
        <button className="btn" onClick={handleExportAfterAction} disabled={!scenario} title="Export investor after-action package as JSON">
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
        <button className="btn danger" onClick={handleStop} disabled={!ui.isRunning || !canStop}>
          ■ STOP
        </button>

        <div className="control-divider" />

        {/* Speed */}
        <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>SIM</span>
        <div className="btn-group">
          {([1, 5, 10] as SimSpeed[]).map((s) => (
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
    </div>
  )
}
