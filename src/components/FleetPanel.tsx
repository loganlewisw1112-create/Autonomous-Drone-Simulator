import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { PLATFORM_CATALOG } from '@/sim/drone/platformCatalog'
import type { DroneState, MissionState, RecoveryTeamState } from '@/types'

function batteryColor(pct: number): string {
  if (pct > 50) return 'var(--accent-green)'
  if (pct > 25) return 'var(--accent-yellow)'
  return 'var(--accent-red)'
}

function signalLabel(dbm: number): string {
  if (dbm > -65) return 'STRONG'
  if (dbm > -80) return 'GOOD'
  if (dbm > -90) return 'WEAK'
  return 'LOST'
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export const RECOVERY_STATES = new Set<MissionState>(['stranded', 'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim', 'remote_landed'])

function DroneCard({ drone, recoveryTeam }: { drone: DroneState; recoveryTeam?: RecoveryTeamState }) {
  const { selectedDroneId, setSelectedDrone, elapsedSec } = useDroneStore(
    useShallow((s) => ({ selectedDroneId: s.ui.selectedDroneId, setSelectedDrone: s.setSelectedDrone, elapsedSec: s.elapsedSec })),
  )
  const selected = selectedDroneId === drone.id

  const flightSec = drone.launchTimeSec !== undefined ? Math.max(0, elapsedSec - drone.launchTimeSec) : null

  const warnings = [
    drone.batteryPct < 25 && 'LOW BAT',
    drone.conflictFlag && 'CONFLICT',
    drone.geofenceBreachFlag && 'GEO-BREACH',
    drone.signalDbm < -90 && 'COMMS LOST',
    RECOVERY_STATES.has(drone.missionState) && 'RECOVERY',
  ].filter((w): w is string => !!w)

  return (
    <div
      className={`drone-card${selected ? ' selected' : ''}`}
      onClick={() => setSelectedDrone(selected ? null : drone.id)}
    >
      <div className="drone-card-header">
        <div className="drone-dot" style={{ background: drone.color }} />
        <span className="drone-label">{drone.label}</span>
        {/* Platform tag — omitted for unassigned drones (custom missions), which
            fly the generic legacy airframe. */}
        {drone.platformId && (
          <span className="drone-platform-tag" title={PLATFORM_CATALOG[drone.platformId].displayName}>
            {PLATFORM_CATALOG[drone.platformId].shortName}
          </span>
        )}
        <span className={`state-badge state-${drone.missionState}`}>
          {drone.missionState.replace('_', ' ')}
        </span>
      </div>
      <div className="telemetry-grid">
        <div className="telem-row">
          <span className="telem-key">ALT</span>
          <span className="telem-val">{Math.round(drone.altitudeFt)}ft</span>
        </div>
        <div className="telem-row">
          <span className="telem-key">SPD</span>
          <span className="telem-val">{drone.speedMs.toFixed(1)}m/s</span>
        </div>
        <div className="telem-row">
          <span className="telem-key">HDG</span>
          <span className="telem-val">{Math.round(drone.headingDeg)}°</span>
        </div>
        <div className="telem-row">
          <span className="telem-key">SIG</span>
          <span className="telem-val" style={{ color: drone.signalDbm < -90 ? 'var(--accent-red)' : undefined }}>
            {signalLabel(drone.signalDbm)}
          </span>
        </div>
        {flightSec !== null && (
          <div className="telem-row">
            <span className="telem-key">FLT</span>
            <span className="telem-val" style={{ color: 'var(--text-secondary)' }}>{fmtTime(flightSec)}</span>
          </div>
        )}
      </div>
      <div className="battery-bar-wrap">
        <div
          className="battery-bar-fill"
          style={{ width: `${drone.batteryPct}%`, background: batteryColor(drone.batteryPct) }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
        <span className="telem-key">BAT</span>
        <span className="telem-val" style={{ color: batteryColor(drone.batteryPct) }}>
          {Math.round(drone.batteryPct)}%
        </span>
      </div>
      {warnings.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
          {warnings.map((w) => (
            <span key={w} style={{
              fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
              padding: '1px 4px', borderRadius: 2,
              background: w === 'RECOVERY' ? 'var(--accent-magenta)' : 'var(--accent-red)',
              color: '#fff',
            }}>{w}</span>
          ))}
        </div>
      )}

      {recoveryTeam && (
        <div style={{
          marginTop: 5, padding: '4px 6px', borderRadius: 3,
          background: 'rgba(255,136,255,0.1)', border: '1px solid #ff88ff44',
          fontSize: 9, fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ color: 'var(--accent-magenta)', fontWeight: 700 }}>
            ⛑ RECOVERY TEAM — {recoveryTeam.status.toUpperCase()}
          </div>
          {recoveryTeam.etaSec > 0 && (
            <div style={{ color: 'var(--text-secondary)' }}>
              ETA: {Math.round(recoveryTeam.etaSec)}s
            </div>
          )}
          {recoveryTeam.weatherRiskNote && (
            <div style={{ color: 'var(--accent-yellow)', fontSize: 8 }}>
              ⚠ {recoveryTeam.weatherRiskNote}
            </div>
          )}
          {recoveryTeam.accessNote && (
            <div style={{ color: 'var(--text-dim)', fontSize: 8 }}>{recoveryTeam.accessNote}</div>
          )}
        </div>
      )}
    </div>
  )
}

export function FleetPanel() {
  const { drones, scenario, elapsedSec, recoveryTeams } = useDroneStore(
    useShallow((s) => ({ drones: s.drones, scenario: s.scenario, elapsedSec: s.elapsedSec, recoveryTeams: s.recoveryTeams })),
  )

  return (
    <div className="fleet-panel">
      <div className="panel-section">
        <div className="panel-label">Fleet Status</div>
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
          {scenario ? scenario.name : 'No scenario loaded'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
          T+{fmtTime(elapsedSec)}
        </div>
      </div>

      {drones.map((d) => (
        <DroneCard
          key={d.id}
          drone={d}
          recoveryTeam={recoveryTeams.find((t) => t.droneId === d.id && t.status !== 'extracted')}
        />
      ))}

      {drones.length === 0 && (
        <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11, textAlign: 'center' }}>
          Load a scenario to see drones
        </div>
      )}
    </div>
  )
}
