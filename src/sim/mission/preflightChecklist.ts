// Preflight checklist data, shared by the PreflightChecklist modal and the
// one-click quick demo (which records the same completion evidence event).
// Kept as a standalone data module so eager code never imports the lazy modal chunk.

export interface PreflightItem {
  id: number
  text: string
  category: string
}

export const PREFLIGHT_CHECKLIST: PreflightItem[] = [
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
  // Matches the simulated lost-link doctrine: drones continue their task through comms loss and
  // reconnect on signal restore; RTB triggers on battery reserve, geofence, weather, or operator.
  { id: 11, text: 'Lost-link procedure confirmed: continue task, reconnect on restore; RTB on reserve/geofence', category: 'mission' },
  { id: 12, text: 'Observers briefed and in position', category: 'crew' },
]
