import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { RECOVERY_STATES } from '@/components/FleetPanel'
import { haversineDistanceM } from '@/utils/geometry'
import type { DispatchTimelineEntry, OperatorRouteCommand, Waypoint, WaypointSaveStatus } from '@/types'

const COMMANDS: Array<{ command: OperatorRouteCommand; label: string }> = [
  { command: 'deep_scan', label: 'Deep Scan' },
  { command: 'street_sweep', label: 'Street Sweep' },
  { command: 'perimeter_orbit', label: 'Perimeter Orbit' },
  { command: 'expanding_search', label: 'Expanding Search' },
  { command: 'route_lkl', label: 'Route to LKL' },
]

const TASK_CATEGORY_LABEL: Record<NonNullable<DispatchTimelineEntry['category']>, string> = {
  dispatch: 'Dispatch',
  field_unit: 'Field Unit',
  operator_task: 'Operator Task',
  agency_update: 'Agency Update',
  safety: 'Safety',
}

export function OperatorCommandPanel() {
  const {
    scenario,
    elapsedSec,
    drones,
    droneWaypoints,
    routeSuggestions,
    routeCommandError,
    routeSaveStatuses,
    ui,
    hoverDrone,
    resumeDrone,
    returnDroneToBase,
    abortRecovery,
    commandDroneRoute,
    generateRouteSuggestionsForDrone,
    acceptRouteSuggestion,
    rejectRouteSuggestion,
    saveDroneRouteDraft,
    clearDroneRouteDraft,
  } = useDroneStore(
    useShallow((s) => ({
      scenario: s.scenario, elapsedSec: s.elapsedSec, drones: s.drones, droneWaypoints: s.droneWaypoints,
      routeSuggestions: s.routeSuggestions, routeCommandError: s.routeCommandError, routeSaveStatuses: s.routeSaveStatuses,
      ui: s.ui, hoverDrone: s.hoverDrone, resumeDrone: s.resumeDrone, returnDroneToBase: s.returnDroneToBase,
      abortRecovery: s.abortRecovery, commandDroneRoute: s.commandDroneRoute,
      generateRouteSuggestionsForDrone: s.generateRouteSuggestionsForDrone,
      acceptRouteSuggestion: s.acceptRouteSuggestion, rejectRouteSuggestion: s.rejectRouteSuggestion,
      saveDroneRouteDraft: s.saveDroneRouteDraft, clearDroneRouteDraft: s.clearDroneRouteDraft,
    })),
  )

  const selectedDrone = useMemo(
    () => drones.find((d) => d.id === ui.selectedDroneId) ?? drones[0],
    [drones, ui.selectedDroneId],
  )

  if (!scenario || !selectedDrone) return null

  const route = droneWaypoints[selectedDrone.id] ?? []
  const routeSaveStatus = routeSaveStatuses[selectedDrone.id]
  const suggestions = routeSuggestions.filter((suggestion) => suggestion.droneId === selectedDrone.id)
  const routeBrief = scenario.droneRouteBriefs?.[selectedDrone.id]
  const batteryProfile = scenario.droneBatteryProfiles?.[selectedDrone.id] ?? scenario.batteryProfile
  const launchSite = scenario.launchSites?.[selectedDrone.id]
  const recoverySite = scenario.recoverySites?.[selectedDrone.id]
  const dispatchTasks = (scenario.dispatchTimeline ?? [])
    .filter((entry) => ['operator_task', 'field_unit', 'agency_update'].includes(entry.category ?? 'dispatch'))
    .filter((entry) => entry.timeSec <= elapsedSec + 180)
    .sort((a, b) => a.timeSec - b.timeSec)
    .slice(0, 6)

  const THERMAL_HOLD_MIN_SEC = 10
  const thermalHoldRemaining = selectedDrone.missionState === 'thermal_hold' && selectedDrone.thermalHoldStartSec !== undefined
    ? Math.max(0, THERMAL_HOLD_MIN_SEC - (elapsedSec - selectedDrone.thermalHoldStartSec))
    : 0
  const resumeBlocked = thermalHoldRemaining > 0

  return (
    <aside className="ops-hub" aria-label="OPS HUB" data-testid="ops-hub">
      <div className="operator-panel-header ops-hub-header">
        <div>
          <div className="mission-feed-label">OPS HUB</div>
          <div className="operator-drone-title">{selectedDrone.label}</div>
        </div>
        <button className="operator-icon-btn" onClick={() => generateRouteSuggestionsForDrone(selectedDrone.id)}>
          SUGGEST
        </button>
      </div>

      <div className="ops-status-grid">
        <div>
          <span className="mission-feed-label">STATE</span>
          <strong>{selectedDrone.missionState.replace('_', ' ').toUpperCase()}</strong>
        </div>
        <div>
          <span className="mission-feed-label">BAT</span>
          <strong>{Math.round(selectedDrone.batteryPct)}%</strong>
        </div>
        <div>
          <span className="mission-feed-label">ALT</span>
          <strong>{Math.round(selectedDrone.altitudeFt)}ft</strong>
        </div>
        <div>
          <span className="mission-feed-label">SIG</span>
          <strong>{selectedDrone.signalDbm}dBm</strong>
        </div>
      </div>

      {routeBrief && (
        <div className="operator-brief">
          <strong>{routeBrief.role}</strong>
          <span>{routeBrief.launchRationale}</span>
          <span>{routeBrief.routePattern}</span>
          <span>{routeBrief.recoveryPlan}</span>
          {batteryProfile && (
            <span>
              {batteryProfile.label} | reserve {batteryProfile.reservePct}% | endurance x{batteryProfile.enduranceMultiplier}
            </span>
          )}
        </div>
      )}

      <div className="ops-site-list">
        <div className="mission-feed-label">LAUNCH / RECOVERY SITE</div>
        {launchSite && (
          <div className="ops-site-row">
            <span>Launch</span>
            <strong>{launchSite.label}</strong>
            <small>{launchSite.kind.replace('_', ' ')} | {launchSite.agency} | {formatCoord(launchSite.position)}</small>
          </div>
        )}
        {recoverySite && (
          <div className="ops-site-row">
            <span>Recovery</span>
            <strong>{recoverySite.label}</strong>
            <small>{recoverySite.kind.replace('_', ' ')} | {recoverySite.agency} | {formatCoord(recoverySite.position)}</small>
          </div>
        )}
      </div>

      {selectedDrone.missionState === 'thermal_hold' && (
        <div className="operator-thermal-hold-alert">
          ⚠ THERMAL HOLD —{' '}
          {resumeBlocked
            ? `Resume available in ${Math.ceil(thermalHoldRemaining)}s`
            : 'Awaiting PIC/MC resume'}
        </div>
      )}

      <div className="operator-command-grid">
        <button onClick={() => hoverDrone(selectedDrone.id)}>HOVER</button>
        <button onClick={() => resumeDrone(selectedDrone.id)} disabled={resumeBlocked}
          title={resumeBlocked ? `Hold for ${Math.ceil(thermalHoldRemaining)}s before resuming` : undefined}>
          RESUME
        </button>
        <button onClick={() => returnDroneToBase(selectedDrone.id)}>RTB</button>
        {COMMANDS.map((item) => (
          <button key={item.command} onClick={() => commandDroneRoute(selectedDrone.id, item.command)}>
            {item.label}
          </button>
        ))}
        {RECOVERY_STATES.has(selectedDrone.missionState) && (
          <button className="operator-abort-recovery" onClick={() => abortRecovery(selectedDrone.id)}>
            ABORT RECOVERY
          </button>
        )}
      </div>

      {routeCommandError && <div className="operator-error">{routeCommandError}</div>}

      <div className="operator-route-list">
        <div className="operator-route-header">
          <div>
            <div className="mission-feed-label">ACTIVE ROUTE ({route.length})</div>
            {routeSaveStatus && (
              <div className={`operator-save-status status-${routeSaveStatus.state}`}>
                {routeSaveStatusLabel(routeSaveStatus)}
              </div>
            )}
          </div>
          <div className="operator-route-actions">
            <button type="button" onClick={() => saveDroneRouteDraft(selectedDrone.id)}>SAVE NOW</button>
            <button type="button" onClick={() => clearDroneRouteDraft(selectedDrone.id)}>CLEAR DRAFT</button>
          </div>
        </div>
        {route.slice(0, 8).map((wp, index) => (
          <div key={wp.id} className="operator-route-row">
            <span>{String(index + 1).padStart(2, '0')}</span>
            <span>{wp.label ?? wp.id}</span>
            <span>{wp.altitudeFt}ft</span>
          </div>
        ))}
      </div>

      {suggestions.length > 0 && (
        <div className="operator-suggestions">
          <div className="mission-feed-label">PENDING ROUTE SUGGESTIONS</div>
          {suggestions.map((suggestion) => (
            <div key={suggestion.id} className={`operator-suggestion suggestion-${suggestion.priority}`}>
              <div className="operator-suggestion-title">{suggestion.title}</div>
              <p>{suggestion.rationale}</p>
              {/* M2: accepting a suggestion REPLACES the drone's current route — show
                  what's being discarded vs. adopted, never a silent swap. */}
              <div className="operator-suggestion-diff" data-testid="suggestion-route-diff">
                <span className="suggestion-diff-old">
                  − {route.length > 0 ? routeSummary(route) : 'no saved route'}
                </span>
                <span className="suggestion-diff-new">
                  + {routeSummary(suggestion.route)}
                </span>
              </div>
              <div className="operator-suggestion-actions">
                <button onClick={() => acceptRouteSuggestion(suggestion.id)}>ACCEPT</button>
                <button onClick={() => rejectRouteSuggestion(suggestion.id)}>REJECT</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="dispatch-task-queue" data-testid="dispatch-task-queue">
        <div className="mission-feed-label">DISPATCH TASK QUEUE</div>
        {dispatchTasks.map((task) => (
          <div key={task.id} className={`dispatch-task-row task-${task.category ?? 'dispatch'}`}>
            <span>{formatTime(task.timeSec)}</span>
            <span>{TASK_CATEGORY_LABEL[task.category ?? 'dispatch']}</span>
            <p>{task.message}</p>
          </div>
        ))}
      </div>
    </aside>
  )
}

function routeSaveStatusLabel(status: WaypointSaveStatus): string {
  if (status.state === 'autosaved') return 'AUTOSAVED'
  if (status.state === 'restored') return 'RESTORED'
  if (status.state === 'failed') return 'SAVE FAILED'
  return 'DRAFT CLEARED'
}

function formatCoord(position: { lat: number; lng: number }): string {
  return position.lat.toFixed(4) + ', ' + position.lng.toFixed(4)
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `T+${m}:${s}`
}

// One-line summary of a route for the suggestion diff: waypoint count, leg distance,
// and the first/last waypoint labels so the operator can tell WHAT is being swapped.
function routeSummary(route: Waypoint[]): string {
  if (route.length === 0) return 'empty route'
  let distM = 0
  for (let i = 1; i < route.length; i++) {
    distM += haversineDistanceM(route[i - 1].position, route[i].position)
  }
  const span = route.length === 1
    ? route[0].label
    : `${route[0].label} → ${route[route.length - 1].label}`
  return `${route.length} wp · ${(distM / 1000).toFixed(1)} km · ${span}`
}



