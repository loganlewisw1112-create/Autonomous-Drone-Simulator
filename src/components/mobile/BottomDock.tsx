import { useMissionControls } from '@/hooks/useMissionControls'
import { FleetRetaskReview } from '@/components/FleetRetaskReview'
import { MissionProgress } from '@/components/MissionProgress'
import { DroneQuickCommands } from '@/components/mobile/DroneQuickCommands'
import { useScenarioOptions } from '@/scenarios/registry'
import { useMobileStore } from '@/store/mobileStore'
import { useDroneStore } from '@/store/droneStore'
import { verifyChain } from '@/utils/chainOfCustody'
import type { OperatorRole, SimSpeed, ScenarioVariantConfig } from '@/types'

export type MobileSheet = 'mission' | 'scenario' | 'exports' | null

const ROLE_LABELS: Record<OperatorRole, string> = {
  pic: 'PIC',
  mission_commander: 'MC',
  observer: 'OBS',
}

// The dock is the mobile home row: primary mission action always one tap away,
// everything else one sheet away. Same handlers as the desktop ControlBar via
// useMissionControls — zero behavioral divergence between shells.
export function BottomDock() {
  const {
    scenario, lifecycle, canStart, canStop, launchReady,
    handleStart, handlePause, handleResume,
  } = useMissionControls()
  const { activeSurface, toggleSurface } = useMobileStore()

  const action = lifecycle === 'running'
    ? { label: 'PAUSE', icon: 'Ⅱ', className: 'warning', onClick: handlePause, disabled: !canStop }
    : lifecycle === 'paused'
      ? { label: 'RESUME', icon: '▶', className: 'primary', onClick: handleResume, disabled: !canStop }
      : { label: 'START', icon: '▶', className: 'primary', onClick: handleStart, disabled: !scenario || !canStart || !launchReady || lifecycle === 'completed' }

  return (
    <nav className="mobile-dock" data-testid="mobile-dock" aria-label="Primary mission controls">
      <button
        className={`mobile-dock-btn${activeSurface === 'scenario' ? ' active' : ''}`}
        onClick={() => toggleSurface('scenario')}
      >
        <span className="dock-ico" aria-hidden="true">⌖</span>SCENARIO
      </button>

      <button className={`mobile-dock-btn ${action.className}`} onClick={action.onClick} disabled={action.disabled}>
        <span className="dock-ico" aria-hidden="true">{action.icon}</span>{action.label}
      </button>

      <button
        className={`mobile-dock-btn${activeSurface === 'mission' ? ' active' : ''}`}
        onClick={() => toggleSurface('mission')}
      >
        <span className="dock-ico" aria-hidden="true">◇</span>MISSION
      </button>

      <button
        className={`mobile-dock-btn${activeSurface === 'more' ? ' active' : ''}`}
        onClick={() => toggleSurface('more')}
      >
        <span className="dock-ico" aria-hidden="true">•••</span>MORE
      </button>
    </nav>
  )
}

// ── Sheets (rendered inside a bottom Drawer by MobileShell) ──────────────────

export function ScenarioSheet({ onScenarioSelected, onOpenCustomMissions }: { onScenarioSelected?: () => void; onOpenCustomMissions?: () => void }) {
  const {
    scenario, scenarioVariant, weatherState,
    handleScenarioChange, handleVariantChange, handleRandomizeSeed, handleDemoReset,
  } = useMissionControls()
  const scenarioOptions = useScenarioOptions()

  return (
    <div className="mobile-sheet-section">
      <span className="mobile-sheet-label">LOAD SCENARIO</span>
      <select
        className="mobile-select"
        value={scenario?.id ?? ''}
        onChange={(e) => {
          onScenarioSelected?.()
          handleScenarioChange(e.target.value)
        }}
      >
        <option value="" disabled>— Load Scenario —</option>
        {scenarioOptions.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>

      {onOpenCustomMissions && (
        <button className="mobile-btn mobile-btn-full" onClick={onOpenCustomMissions}>
          + CUSTOM MISSIONS
        </button>
      )}

      <span className="mobile-sheet-label">WEATHER SEVERITY</span>
      <div className="mobile-sheet-row">
        {([0, 1, 2, 3] as const).map((s) => (
          <button
            key={s}
            className={`mobile-btn grow${scenarioVariant.weatherSeverity === s ? ' active' : ''}`}
            onClick={() => handleVariantChange({ weatherSeverity: s })}
          >
            {['CLR', 'LGT', 'MOD', 'SVR'][s]}
          </button>
        ))}
      </div>

      <span className="mobile-sheet-label">TIME OF DAY</span>
      <div className="mobile-sheet-row">
        {(['dawn', 'day', 'dusk', 'night'] as const).map((t) => (
          <button
            key={t}
            className={`mobile-btn grow${scenarioVariant.timeOfDay === t ? ' active' : ''}`}
            onClick={() => handleVariantChange({ timeOfDay: t as ScenarioVariantConfig['timeOfDay'] })}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>

      <span className="mobile-sheet-label">COMMS DEGRADATION</span>
      <div className="mobile-sheet-row">
        {([0, 1, 2] as const).map((s) => (
          <button
            key={s}
            className={`mobile-btn grow${scenarioVariant.commsDegradation === s ? ' active' : ''}`}
            onClick={() => handleVariantChange({ commsDegradation: s })}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="mobile-sheet-row">
        <button className="mobile-btn" onClick={handleRandomizeSeed}>🎲 SEED {scenarioVariant.seed}</button>
        <button className="mobile-btn warning" onClick={handleDemoReset} disabled={!scenario}>DEMO RESET</button>
      </div>

      <span className="mobile-status-line">
        {weatherState.activeHazards.length > 0
          ? `⚠ ${weatherState.activeHazards.join(', ')}`
          : 'Clear conditions'}
      </span>
    </div>
  )
}

export function MissionSheet() {
  const {
    ui, scenario, drones, lifecycle, operatorRole, investorDemo, launchPlan, lastRouteChange,
    latestFleetRetaskResult, fleetRetaskUndo,
    canStart, canAbort, canStop, canRetaskFleet, launchReady, allLanded,
    setSimSpeed, setOperatorRole, setInvestorDemoEnabled, setShowPreflight,
    handleStart, handleAbort, handlePause, handleResume, handleEndMission, handleUndoRouteChange,
    handleFleetRetask, handleUndoRetask,
  } = useMissionControls()
  const setShowLaunchBay = useDroneStore((s) => s.setShowLaunchBay)

  function resumeSetup() {
    if (!scenario) return
    if (launchPlan) setShowLaunchBay(true)
    else setShowPreflight(true)
  }

  return (
    <div className="mobile-sheet-section">
      {/* Suggested-next-move drone controls first, so redirecting a drone is one
          tap into the Mission tab — the map stays visible above this partial sheet. */}
      <DroneQuickCommands />

      <MissionProgress compact />

      <span className="mobile-sheet-label">MISSION CONTROL</span>
      <div className="mobile-sheet-row">
        {lifecycle === 'paused' ? (
          <button className="mobile-btn primary grow" onClick={handleResume} disabled={!canStop}>▶ RESUME</button>
        ) : lifecycle === 'running' ? (
          <button className="mobile-btn warning grow" onClick={handlePause} disabled={!canStop}>Ⅱ PAUSE</button>
        ) : (
          <button className="mobile-btn primary grow" onClick={handleStart} disabled={!scenario || !canStart || !launchReady || lifecycle === 'completed'}>
            ▶ START
          </button>
        )}
        <button className="mobile-btn warning grow" onClick={handleAbort} disabled={!ui.isRunning || !canAbort}>
          ⬆ RTB ALL
        </button>
        <button className="mobile-btn danger grow" onClick={handleEndMission} disabled={!canStop || !(ui.isRunning || lifecycle === 'paused')}>
          ■ END MISSION
        </button>
      </div>
      <button
        className="mobile-btn primary mobile-btn-full"
        onClick={handleFleetRetask}
        disabled={!scenario || drones.length === 0 || !canRetaskFleet}
      >
        ⟳ RETASK FLEET
      </button>
      <FleetRetaskReview
        result={latestFleetRetaskResult}
        undoUntil={fleetRetaskUndo?.undoUntil}
        onUndo={handleUndoRetask}
        compact
      />
      {lastRouteChange && lastRouteChange.source !== 'fleet_retask' && (
        <button className="mobile-btn mobile-btn-full" onClick={handleUndoRouteChange}>
          ↶ UNDO LAST ROUTE CHANGE
        </button>
      )}
      {scenario && !ui.isRunning && !launchReady && (
        <button className="mobile-btn warning mobile-btn-full" onClick={resumeSetup}>
          RESUME SETUP
        </button>
      )}
      {launchPlan && !launchPlan.readyToLaunch && launchPlan.blockers.length > 0 && (
        <span className="mobile-status-line" style={{ color: 'var(--accent-yellow)' }}>
          {launchPlan.blockers.join(' · ')}
        </span>
      )}

      <span className="mobile-sheet-label">SIM SPEED</span>
      <div className="mobile-sheet-row">
        {([1, 5, 10, 20] as SimSpeed[]).map((s) => (
          <button
            key={s}
            className={`mobile-btn grow${ui.simSpeed === s ? ' active' : ''}`}
            onClick={() => setSimSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>

      <span className="mobile-sheet-label">OPERATOR ROLE</span>
      <div className="mobile-sheet-row">
        {(['pic', 'mission_commander', 'observer'] as OperatorRole[]).map((role) => (
          <button
            key={role}
            className={`mobile-btn grow${operatorRole === role ? ' active' : ''}`}
            onClick={() => setOperatorRole(role)}
          >
            {ROLE_LABELS[role]}
          </button>
        ))}
      </div>

      <span className="mobile-sheet-label">GUIDED TOUR</span>
      <div className="mobile-sheet-row">
        <button
          className={`mobile-btn grow${investorDemo.enabled ? ' active' : ''}`}
          onClick={() => setInvestorDemoEnabled(!investorDemo.enabled)}
          disabled={!scenario}
        >
          {investorDemo.enabled ? 'TOUR ON' : 'TOUR OFF'}
        </button>
      </div>

      <span className="mobile-status-line">
        {lifecycle === 'paused' ? 'Ⅱ MISSION PAUSED' : ui.isRunning ? '● MISSION ACTIVE' : allLanded ? '● ALL LANDED' : '○ STANDBY'}
      </span>
    </div>
  )
}

export function ExportsSheet() {
  const {
    scenario, events, drones, exportStatus,
    handleExportLog, handleExportKML, handleExportGeoJSON, handleExportAfterAction,
  } = useMissionControls()

  return (
    <div className="mobile-sheet-section">
      <span className="mobile-sheet-label">EVIDENCE EXPORTS</span>
      <div className="mobile-sheet-row">
        <button className="mobile-btn grow" onClick={handleExportAfterAction} disabled={!scenario}>
          AFTER ACTION (JSON)
        </button>
      </div>
      <div className="mobile-sheet-row">
        <button className="mobile-btn grow" onClick={handleExportLog} disabled={events.length === 0}>
          📋 CUSTODY LOG
        </button>
      </div>
      <div className="mobile-sheet-row">
        <button className="mobile-btn grow" onClick={handleExportKML} disabled={drones.length === 0}>
          🗺 KML
        </button>
        <button className="mobile-btn grow" onClick={handleExportGeoJSON} disabled={drones.length === 0}>
          ⬡ GeoJSON
        </button>
      </div>
      {exportStatus && <span className="mobile-status-line" style={{ color: 'var(--accent-green)' }}>✓ {exportStatus}</span>}
      <span className="mobile-status-line">Files download to this device.</span>
    </div>
  )
}

export function EvidenceSheet() {
  const events = useDroneStore((s) => s.events)
  const verified = events.length > 0 && verifyChain(events)
  return (
    <div className="mobile-sheet-section">
      <div className="mobile-evidence-summary">
        <span className="mobile-sheet-label">EVIDENCE CHAIN</span>
        <strong className={events.length === 0 ? 'evidence-empty' : verified ? 'evidence-ok' : 'evidence-failed'}>
          {events.length === 0 ? 'NO EVIDENCE YET' : verified ? 'VERIFIED' : 'FAILED'}
        </strong>
        <span>{events.length} linked event{events.length === 1 ? '' : 's'}</span>
      </div>
      <ExportsSheet />
    </div>
  )
}

export function MapToolsSheet({ onRecenter }: { onRecenter: () => void }) {
  const scenario = useDroneStore((s) => s.scenario)
  const visibility = useDroneStore((s) => s.ui.layerVisibility)
  const toggleLayer = useDroneStore((s) => s.toggleLayer)
  const layers = [
    ['relays', 'Relays'],
    ['gates', 'Gates'],
    ['recharge', 'Recharge'],
    ['traffic', 'Air Traffic'],
    ['thermal', 'Heat (IR)'],
    ['irFootprints', 'Sensor FOV (IR)'],
  ] as const
  return (
    <div className="mobile-sheet-section">
      <button className="mobile-btn primary mobile-btn-full" onClick={onRecenter} disabled={!scenario}>◎ RECENTER MISSION</button>
      <span className="mobile-sheet-label">MAP LAYERS</span>
      <div className="mobile-layer-grid">
        {layers.map(([key, label]) => (
          <button key={key} className={`mobile-btn${visibility[key] ? ' active' : ''}`} onClick={() => toggleLayer(key)}>
            {visibility[key] ? '✓ ' : ''}{label.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
