import { useMissionControls } from '@/hooks/useMissionControls'
import { SCENARIO_OPTIONS } from '@/scenarios/catalog'
import type { OperatorRole, SimSpeed, ScenarioVariantConfig } from '@/types'

export type MobileSheet = 'mission' | 'scenario' | 'exports' | null

const ROLE_LABELS: Record<OperatorRole, string> = {
  pic: 'PIC',
  mission_commander: 'MC',
  observer: 'OBS',
}

interface BottomDockProps {
  openSheet: MobileSheet
  onToggleSheet: (sheet: MobileSheet) => void
  onOpenAccount: () => void
  accountLabel: string
}

// The dock is the mobile home row: primary mission action always one tap away,
// everything else one sheet away. Same handlers as the desktop ControlBar via
// useMissionControls — zero behavioral divergence between shells.
export function BottomDock({ openSheet, onToggleSheet, onOpenAccount, accountLabel }: BottomDockProps) {
  const {
    ui, scenario, canStart, canStop, launchReady,
    handleStart, handleStop,
  } = useMissionControls()

  const toggle = (sheet: Exclude<MobileSheet, null>) => onToggleSheet(openSheet === sheet ? null : sheet)

  return (
    <nav className="mobile-dock" data-testid="mobile-dock">
      <button
        className={`mobile-dock-btn${openSheet === 'scenario' ? ' active' : ''}`}
        onClick={() => toggle('scenario')}
      >
        <span className="dock-ico">🗂</span>SCENARIO
      </button>

      {ui.isRunning ? (
        <button className="mobile-dock-btn danger" onClick={handleStop} disabled={!canStop}>
          <span className="dock-ico">■</span>STOP
        </button>
      ) : (
        <button
          className="mobile-dock-btn primary"
          onClick={handleStart}
          disabled={!scenario || !canStart || !launchReady}
        >
          <span className="dock-ico">▶</span>START
        </button>
      )}

      <button
        className={`mobile-dock-btn${openSheet === 'mission' ? ' active' : ''}`}
        onClick={() => toggle('mission')}
      >
        <span className="dock-ico">🛰</span>MISSION
      </button>

      <button
        className={`mobile-dock-btn${openSheet === 'exports' ? ' active' : ''}`}
        onClick={() => toggle('exports')}
      >
        <span className="dock-ico">📦</span>EXPORTS
      </button>

      <button className="mobile-dock-btn" onClick={onOpenAccount}>
        <span className="dock-ico">◉</span>{accountLabel}
      </button>
    </nav>
  )
}

// ── Sheets (rendered inside a bottom Drawer by MobileShell) ──────────────────

export function ScenarioSheet() {
  const {
    scenario, scenarioVariant, weatherState,
    handleScenarioChange, handleVariantChange, handleRandomizeSeed, handleDemoReset,
  } = useMissionControls()

  return (
    <div className="mobile-sheet-section">
      <span className="mobile-sheet-label">LOAD SCENARIO</span>
      <select
        className="mobile-select"
        value={scenario?.id ?? ''}
        onChange={(e) => handleScenarioChange(e.target.value)}
      >
        <option value="" disabled>— Load Scenario —</option>
        {SCENARIO_OPTIONS.map((s) => (
          <option key={s.id} value={s.id}>{s.label}</option>
        ))}
      </select>

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
    ui, scenario, operatorRole, investorDemo, launchPlan,
    canStart, canAbort, canStop, launchReady, allLanded,
    setSimSpeed, setOperatorRole, setInvestorDemoEnabled,
    handleStart, handleAbort, handleStop,
  } = useMissionControls()

  return (
    <div className="mobile-sheet-section">
      <span className="mobile-sheet-label">MISSION CONTROL</span>
      <div className="mobile-sheet-row">
        <button
          className="mobile-btn primary grow"
          onClick={handleStart}
          disabled={!scenario || !canStart || !launchReady}
        >
          ▶ START
        </button>
        <button className="mobile-btn warning grow" onClick={handleAbort} disabled={!ui.isRunning || !canAbort}>
          ⬆ RTB ALL
        </button>
        <button className="mobile-btn danger grow" onClick={handleStop} disabled={!ui.isRunning || !canStop}>
          ■ STOP
        </button>
      </div>
      {scenario && !ui.isRunning && !launchReady && (
        <span className="mobile-status-line" style={{ color: 'var(--accent-yellow)' }}>
          ⚠ BAY PLAN REQUIRED — load a scenario and complete preflight + bay planning
        </span>
      )}
      {launchPlan && !launchPlan.readyToLaunch && launchPlan.blockers.length > 0 && (
        <span className="mobile-status-line" style={{ color: 'var(--accent-yellow)' }}>
          {launchPlan.blockers.join(' · ')}
        </span>
      )}

      <span className="mobile-sheet-label">SIM SPEED</span>
      <div className="mobile-sheet-row">
        {([1, 5, 10] as SimSpeed[]).map((s) => (
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
        {ui.isRunning ? '● MISSION ACTIVE' : allLanded ? '● ALL LANDED' : '○ STANDBY'}
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
