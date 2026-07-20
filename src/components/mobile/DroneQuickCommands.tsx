import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { COMMANDS } from '@/components/OperatorCommandPanel'

const THERMAL_HOLD_MIN_SEC = 10

// Compact "suggested next move" controls for the mobile MISSION tab: pick a drone,
// then HOVER / RESUME / RTB / the canned search patterns / SUGGEST. These call the
// same droneStore actions the OPS hub uses, so behavior is identical to desktop —
// this is just a map-visible shortcut so the operator doesn't have to open the
// full OPS drawer to redirect a drone. Kept short on purpose: the mission sheet is
// a partial-height drawer, so the map stays visible above it.
export function DroneQuickCommands() {
  const {
    scenario, drones, elapsedSec, selectedDroneId, routeCommandError,
    setSelectedDrone, hoverDrone, resumeDrone, returnDroneToBase,
    commandDroneRoute, generateRouteSuggestionsForDrone,
  } = useDroneStore(
    useShallow((s) => ({
      scenario: s.scenario, drones: s.drones, elapsedSec: s.elapsedSec,
      selectedDroneId: s.ui.selectedDroneId, routeCommandError: s.routeCommandError,
      setSelectedDrone: s.setSelectedDrone, hoverDrone: s.hoverDrone,
      resumeDrone: s.resumeDrone, returnDroneToBase: s.returnDroneToBase,
      commandDroneRoute: s.commandDroneRoute,
      generateRouteSuggestionsForDrone: s.generateRouteSuggestionsForDrone,
    })),
  )

  const selected = useMemo(
    () => drones.find((d) => d.id === selectedDroneId) ?? drones[0],
    [drones, selectedDroneId],
  )

  if (!scenario || !selected) {
    return (
      <div className="mobile-sheet-section mobile-drone-commands">
        <span className="mobile-sheet-label">DRONE COMMANDS</span>
        <span className="mobile-status-line">
          {scenario
            ? 'Run preflight to launch the fleet, then command drones here.'
            : 'Load a scenario to command drones.'}
        </span>
      </div>
    )
  }

  // Mirror the OPS hub's thermal-hold guard: resume is blocked until the minimum
  // hold has elapsed, so the two surfaces can't disagree on what's allowed.
  const thermalHoldRemaining = selected.missionState === 'thermal_hold' && selected.thermalHoldStartSec !== undefined
    ? Math.max(0, THERMAL_HOLD_MIN_SEC - (elapsedSec - selected.thermalHoldStartSec))
    : 0
  const resumeBlocked = thermalHoldRemaining > 0

  return (
    <div className="mobile-sheet-section mobile-drone-commands">
      <span className="mobile-sheet-label">DRONE COMMANDS</span>

      <div className="mobile-drone-picker" role="tablist" aria-label="Select drone">
        {drones.map((d) => (
          <button
            key={d.id}
            role="tab"
            aria-selected={selected.id === d.id}
            className={`mobile-drone-chip${selected.id === d.id ? ' active' : ''}`}
            onClick={() => setSelectedDrone(d.id)}
          >
            {d.id.toUpperCase()}
          </button>
        ))}
      </div>

      <span className="mobile-status-line">
        {selected.label} · {selected.missionState.replace(/_/g, ' ').toUpperCase()} · BAT {Math.round(selected.batteryPct)}% · ALT {Math.round(selected.altitudeFt)}ft
      </span>

      <div className="mobile-command-grid">
        <button className="mobile-btn" onClick={() => hoverDrone(selected.id)}>HOVER</button>
        <button
          className="mobile-btn"
          onClick={() => resumeDrone(selected.id)}
          disabled={resumeBlocked}
          title={resumeBlocked ? `Hold for ${Math.ceil(thermalHoldRemaining)}s before resuming` : undefined}
        >
          RESUME
        </button>
        <button className="mobile-btn warning" onClick={() => returnDroneToBase(selected.id)}>RTB</button>
        {COMMANDS.map((item) => (
          <button key={item.command} className="mobile-btn" onClick={() => commandDroneRoute(selected.id, item.command)}>
            {item.label}
          </button>
        ))}
        <button className="mobile-btn primary" onClick={() => generateRouteSuggestionsForDrone(selected.id)}>SUGGEST</button>
      </div>

      {routeCommandError && (
        <span className="mobile-status-line" style={{ color: 'var(--accent-red)' }}>{routeCommandError}</span>
      )}
    </div>
  )
}
