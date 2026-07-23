import { lazy, Suspense, useState, useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { verifyChain } from '@/utils/chainOfCustody'
import { encodeDroneTelemetry, formatMAVLinkLine } from '@/utils/mavlink'
import { buildComplianceState } from '@/sim/demo/complianceEngine'
import { airspaceCeilingCaption, airspaceForScenario } from '@/sim/mission/airspace'
import { buildMissionOutcomeSummary } from '@/sim/demo/missionOutcome'
import { buildSectorPodReport, type SectorPodReport, type SectorSweep } from '@/sim/sensors/podReporting'
import { buildUtmAirspaceState } from '@/sim/demo/utmEngine'
import { platformForDrone, LEGACY_FAA_SPEED_LIMIT_MS } from '@/sim/drone/platformCatalog'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'
import { terrainAltitudeSnapshot } from '@/sim/terrain/altitude'
import type { MissionEvent, ScenarioConfig } from '@/types'

// Recharts is a ~530kB vendor chunk — keep it out of the first paint by lazy-loading
// the chart block (same React.lazy pattern as the modals in App.tsx).
const TelemetryCharts = lazy(() => import('@/components/TelemetryCharts').then((m) => ({ default: m.TelemetryCharts })))

// Tactical palette (hex, shared with chart colors in TelemetryCharts)
const C_BLUE = '#00d4ff'
const C_GREEN = '#44ff88'
const C_YELLOW = '#ffaa00'
const C_RED = '#ff4444'
const C_MAGENTA = '#ff88ff'

const EVENT_COLORS: Record<string, string> = {
  mission_start: C_BLUE,
  mission_complete: C_GREEN,
  mission_abort: C_RED,
  state_change: '#8899aa',
  waypoint_reached: C_BLUE,
  rtb_triggered: C_YELLOW,
  emergency_land: C_RED,
  low_battery: C_YELLOW,
  avoidance_start: C_YELLOW,
  avoidance_complete: C_GREEN,
  geofence_breach: C_RED,
  comms_degraded: C_YELLOW,
  comms_lost: C_RED,
  comms_restored: C_GREEN,
  conflict_detected: C_RED,
  conflict_resolved: C_GREEN,
  thermal_detection: C_MAGENTA,
  preflight_complete: C_GREEN,
  operator_command: C_BLUE,
}

type Tab = 'telem' | 'mavlink' | 'metrics' | 'readiness'

const MAX_MAVLINK_LINES = 80

// Per-drone certified max groundspeed. Falls back to the FAA Part 107 cap when no
// scenario (and therefore no platform assignment) is loaded.
function certifiedSpeedLimitMs(scenario: ScenarioConfig | null, droneId: string): number {
  return scenario ? platformForDrone(scenario, droneId).maxSpeedMs : LEGACY_FAA_SPEED_LIMIT_MS
}

export function TelemetryPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('telem')
  const [mavlinkFeed, setMavlinkFeed] = useState<string[]>([])
  const mavFeedRef = useRef<HTMLDivElement>(null)

  const { drones, ui, events, telemetryHistory, thermalContacts, metrics, elapsedSec, scenario, scenarioVariant, positionHistory, weatherState, setSensorMode } = useDroneStore(
    useShallow((s) => ({
      drones: s.drones, ui: s.ui, events: s.events, telemetryHistory: s.telemetryHistory,
      thermalContacts: s.thermalContacts, metrics: s.metrics, elapsedSec: s.elapsedSec,
      scenario: s.scenario, scenarioVariant: s.scenarioVariant, positionHistory: s.positionHistory,
      weatherState: s.weatherState, setSensorMode: s.setSensorMode,
    })),
  )

  const selected = ui.selectedDroneId
    ? drones.find((d) => d.id === ui.selectedDroneId)
    : drones[0]

  const history = selected ? (telemetryHistory[selected.id] ?? []) : []
  const terrainScenarioId = scenario?.id
  const terrainService = useMemo(
    () => terrainScenarioId ? occlusionServiceFor(terrainScenarioId) : undefined,
    [terrainScenarioId],
  )
  const selectedTerrain = selected
    ? terrainAltitudeSnapshot(terrainService, selected.position, selected.altitudeFt)
    : null
  const recentEvents = [...events].reverse().slice(0, 60)

  // Re-verify the whole hash chain whenever the event log changes. Synchronous and cheap
  // (one SHA-256 per event); memoized so it does NOT run on every sim tick — only on new events.
  const chainValid = useMemo(() => verifyChain(events), [events])

  const batColor = selected
    ? selected.batteryPct < 10 ? C_RED : selected.batteryPct < 25 ? C_YELLOW : C_GREEN
    : C_GREEN

  // Generate MAVLink feed on every tick (throttled to every ~20 ticks to avoid flooding)
  const mavTickRef = useRef(0)
  useEffect(() => {
    if (activeTab !== 'mavlink' || drones.length === 0) return
    mavTickRef.current++
    if (mavTickRef.current % 20 !== 0) return  // sample ~1Hz at 1× speed
    const lines: string[] = []
    for (const d of drones) {
      const terrain = terrainAltitudeSnapshot(terrainService, d.position, d.altitudeFt)
      for (const msg of encodeDroneTelemetry(d, terrain.aircraftMslM)) {
        lines.push(formatMAVLinkLine(msg))
      }
    }
    setMavlinkFeed((prev) => {
      const next = [...prev, ...lines]
      return next.length > MAX_MAVLINK_LINES ? next.slice(next.length - MAX_MAVLINK_LINES) : next
    })
  }, [drones, activeTab, terrainService])

  // Auto-scroll MAVLink feed
  useEffect(() => {
    if (mavFeedRef.current) {
      mavFeedRef.current.scrollTop = mavFeedRef.current.scrollHeight
    }
  }, [mavlinkFeed])

  // Unique thermal contacts
  const uniqueContacts = new Set(thermalContacts.map((d) => d.sourceId)).size

  // These three rebuild derived state from full fleet/scenario objects — expensive enough
  // (and irrelevant enough on other tabs) that they should only run while READY is visible,
  // not on every 20Hz tick regardless of active tab.
  const outcome = useMemo(
    () => activeTab === 'readiness'
      ? buildMissionOutcomeSummary({ scenario, drones, metrics, thermalContacts, eventsCount: events.length, elapsedSec })
      : null,
    [activeTab, scenario, drones, metrics, thermalContacts, events.length, elapsedSec],
  )
  const compliance = useMemo(
    () => activeTab === 'readiness' ? buildComplianceState({ scenario, drones, scenarioVariant, elapsedSec }) : null,
    [activeTab, scenario, drones, scenarioVariant, elapsedSec],
  )
  const utm = useMemo(
    () => activeTab === 'readiness' ? buildUtmAirspaceState({ scenario, drones, elapsedSec }) : null,
    [activeTab, scenario, drones, elapsedSec],
  )
  // WP-6: sector POD. Same gating as the three above — it walks every drone's full position
  // history and fires terrain LOS probes, so it must not run on the 20Hz tick from another tab.
  const podReport = useMemo(
    () => activeTab === 'readiness'
      ? buildSectorPodReport({ scenario, drones, positionHistory, weather: weatherState, occlusion: terrainService })
      : null,
    [activeTab, scenario, drones, positionHistory, weatherState, terrainService],
  )
  // WP-3: the published-ceiling provenance line. Cheap (a static fixture lookup), but keyed off
  // the scenario so it recomputes only when the scenario changes, like the three above.
  const ceilingCaption = useMemo(() => airspaceCeilingCaption(airspaceForScenario(scenario?.id)), [scenario?.id])

  return (
    <div className="telemetry-panel">
      {/* Tab strip */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        {(['telem', 'mavlink', 'metrics', 'readiness'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            style={{
              flex: 1,
              padding: '5px 0',
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              letterSpacing: 1,
              background: activeTab === t ? 'var(--bg-panel)' : 'transparent',
              color: activeTab === t ? 'var(--accent-blue)' : 'var(--text-dim)',
              border: 'none',
              borderBottom: activeTab === t ? '2px solid var(--accent-blue)' : '2px solid transparent',
              cursor: 'pointer',
              textTransform: 'uppercase',
            }}
          >
            {tabLabel(t)}
          </button>
        ))}
      </div>

      {/* ── TELEMETRY TAB ─────────────────────────────────────────────────── */}
      {activeTab === 'telem' && (
        <>
          <div className="panel-section">
            <div className="panel-label">
              {selected ? `${selected.label} Telemetry` : 'Telemetry'}
            </div>
            {selected ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <TRow label="POSITION" value={`${selected.position.lat.toFixed(5)}, ${selected.position.lng.toFixed(5)}`} />
                <TRow label="ALTITUDE" value={`${Math.round(selected.altitudeFt)} ft AGL`} warn={selected.altitudeFt > 390} />
                {selectedTerrain?.coverage === 'available' ? (
                  <>
                    <TRow label="GROUND MSL" value={`${Math.round(selectedTerrain.groundMslM! * 3.28084)} ft`} />
                    <TRow label="AIRCRAFT MSL" value={`${Math.round(selectedTerrain.aircraftMslM! * 3.28084)} ft`} />
                    <TRow
                      label="SURFACE CLR"
                      value={`${Math.round(selectedTerrain.surfaceClearanceFt!)} ft`}
                      warn={selectedTerrain.surfaceClearanceFt! < 20}
                      crit={selectedTerrain.surfaceClearanceFt! < 0}
                    />
                  </>
                ) : (
                  <TRow
                    label="TERRAIN"
                    value={selectedTerrain?.coverage === 'outside' ? 'OUTSIDE FIXTURE' : 'NOT SOURCED'}
                    warn
                  />
                )}
                <TRow label="SPEED" value={`${selected.speedMs.toFixed(1)} m/s`} warn={selected.speedMs > certifiedSpeedLimitMs(scenario, selected.id) + 0.5} />
                <TRow label="HEADING" value={`${Math.round(selected.headingDeg)}° (${compassDir(selected.headingDeg)})`} />
                <TRow label="BATTERY" value={`${Math.round(selected.batteryPct)}%`} warn={selected.batteryPct < 25} crit={selected.batteryPct < 10} />
                <TRow label="SIGNAL" value={`${selected.signalDbm} dBm`} warn={selected.signalDbm < -80} crit={selected.signalDbm < -90} />
                <TRow label="STATE" value={selected.missionState.replace(/_/g, ' ').toUpperCase()} />
                <TRow label="WP INDEX" value={`${selected.currentWaypointIndex + 1}`} />
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 11 }}>Select a drone</div>
            )}
          </div>

          {/* Altitude / battery / speed charts (lazy — recharts stays out of first paint) */}
          {history.length > 2 && (
            <Suspense fallback={null}>
              <TelemetryCharts history={history} batColor={batColor} />
            </Suspense>
          )}

          {/* Sensor mode */}
          <div className="panel-section">
            <div className="panel-label">Sensor Mode</div>
            <div className="btn-group" style={{ marginTop: 2 }}>
              <button className={`btn${ui.sensorMode === 'eo' ? ' active' : ''}`} onClick={() => setSensorMode('eo')}>EO</button>
              <button className={`btn${ui.sensorMode === 'ir' ? ' active' : ''}`} onClick={() => setSensorMode('ir')}>IR / THERMAL</button>
            </div>
          </div>

          {/* Warnings */}
          {selected && (
            <div className="panel-section">
              <div className="panel-label">Warnings</div>
              <div className="warnings-list">
                {selected.batteryPct < 10 && <WarnBadge level="critical" text="BATTERY CRITICAL — EMERGENCY LAND" />}
                {selected.batteryPct < 25 && selected.batteryPct >= 10 && <WarnBadge level="critical" text="LOW BATTERY — RTB INITIATED" />}
                {selected.conflictFlag && <WarnBadge level="critical" text="AIRSPACE CONFLICT DETECTED" />}
                {selected.geofenceBreachFlag && <WarnBadge level="critical" text="GEOFENCE BREACH" />}
                {selected.signalDbm < -90 && <WarnBadge level="critical" text="COMMS LOST — BVLOS DEGRADED" />}
                {selected.signalDbm < -80 && selected.signalDbm >= -90 && <WarnBadge level="caution" text="COMMS DEGRADED" />}
                {selected.altitudeFt > 390 && <WarnBadge level="caution" text="APPROACHING 400ft AGL LIMIT" />}
                {selected.missionState === 'avoid' && <WarnBadge level="caution" text="CONFLICT AVOIDANCE — GIVING WAY" />}
                {selected.missionState === 'emergency' && <WarnBadge level="critical" text="EMERGENCY LANDING IN PROGRESS" />}
                {selected.batteryPct >= 25 && !selected.conflictFlag && !selected.geofenceBreachFlag &&
                 selected.signalDbm >= -80 && selected.altitudeFt <= 390 &&
                 selected.missionState !== 'avoid' && selected.missionState !== 'emergency' && (
                  <WarnBadge level="info" text="ALL SYSTEMS NOMINAL" />
                )}
              </div>
            </div>
          )}

          {/* Part 107 */}
          {selected && (
            <div className="panel-section">
              <div className="panel-label">FAA Part 107</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <CompCheck ok={selected.altitudeFt <= 400} label={`ALT ≤ 400ft (${Math.round(selected.altitudeFt)}ft)`} />
                {/* The limit is per-airframe (9-20 m/s across the catalog), not the flat Part 107
                    cap — so the label has to quote the same number the check uses. It previously
                    read a hardcoded "57mph", which put a ✗ next to a limit the drone was under. */}
                <CompCheck
                  ok={selected.speedMs <= certifiedSpeedLimitMs(scenario, selected.id) + 0.5}
                  label={`SPD ≤ ${Math.round(certifiedSpeedLimitMs(scenario, selected.id) * 2.237)}mph (${(selected.speedMs * 2.237).toFixed(1)}mph)`}
                />
                <CompCheck ok={selected.signalDbm > -90} label={`COMMS LINK (${selected.signalDbm}dBm)`} />
              </div>
            </div>
          )}

          {/* Event log */}
          <div className="panel-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div className="panel-label">
              Chain of Custody Log
              <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)' }}>
                {events.length} events
              </span>
              {events.length > 0 && (
                <span
                  data-testid="chain-verify-badge"
                  title={chainValid
                    ? 'verifyChain(): every prevHash link and SHA-256 recomputation checks out'
                    : 'verifyChain() FAILED — hash chain is broken or tampered'}
                  style={{
                    marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 8, fontWeight: 700,
                    padding: '1px 5px', borderRadius: 2, letterSpacing: '0.06em',
                    color: chainValid ? 'var(--accent-green)' : '#fff',
                    background: chainValid ? 'rgba(68,255,136,0.12)' : 'var(--accent-red)',
                    border: `1px solid ${chainValid ? '#44ff8855' : 'var(--accent-red)'}`,
                  }}
                >
                  {chainValid ? 'CHAIN VERIFIED' : 'CHAIN BROKEN'}
                </span>
              )}
            </div>
            <div className="event-log">
              {recentEvents.map((e, i) => <EventRow key={i} event={e} chainValid={chainValid} />)}
              {events.length === 0 && (
                <div style={{ color: 'var(--text-dim)', fontSize: 10, padding: 4 }}>No events yet — start a mission</div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── MAVLINK TAB ───────────────────────────────────────────────────── */}
      {activeTab === 'mavlink' && (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 4 }}>MAVLink v2 — Decoded Feed</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              {drones.map((d) => (
                <div key={d.id} style={{
                  fontFamily: 'var(--font-mono)', fontSize: 9,
                  color: d.color, border: `1px solid ${d.color}44`,
                  padding: '2px 6px', borderRadius: 3,
                }}>
                  SYS:{d.id.replace('uav-', '')} {d.label}
                </div>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
              {['HEARTBEAT·0', 'GLOBAL_POSITION_INT·33', 'BATTERY_STATUS·147', 'SYS_STATUS·1'].map((m) => {
                const [name, id] = m.split('·')
                return (
                  <div key={m} style={{
                    fontFamily: 'var(--font-mono)', fontSize: 8,
                    color: 'var(--text-secondary)', background: 'var(--bg-body)',
                    padding: '3px 6px', borderRadius: 3,
                  }}>
                    <span style={{ color: C_BLUE }}>{name}</span>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>#{id}</span>
                  </div>
                )
              })}
            </div>
          </div>
          <div
            ref={mavFeedRef}
            style={{
              flex: 1, overflowY: 'auto', overflowX: 'hidden',
              fontFamily: 'var(--font-mono)', fontSize: 8,
              color: '#44cc66', background: '#050a05',
              padding: '6px 8px', lineHeight: 1.6,
              borderTop: '1px solid var(--border)',
            }}
          >
            {mavlinkFeed.length === 0 ? (
              <span style={{ color: 'var(--text-dim)' }}>
                {ui.isRunning ? 'Waiting for telemetry…' : 'Start mission to receive MAVLink feed'}
              </span>
            ) : mavlinkFeed.map((line, i) => (
              <div key={i} style={{
                borderBottom: line.includes('HEARTBEAT') ? '1px solid #0a1a0a' : 'none',
                paddingBottom: line.includes('HEARTBEAT') ? 3 : 0,
                marginBottom: line.includes('HEARTBEAT') ? 3 : 0,
                color: line.includes('SYS_STATUS') && line.includes('errors_comm=1') ? C_RED
                  : line.includes('HEARTBEAT') ? '#88ddaa'
                  : '#44cc66',
              }}>
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── METRICS TAB ──────────────────────────────────────────────────── */}
      {activeTab === 'metrics' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>Mission Summary</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <MetricRow label="MISSION TIME" value={formatDuration(elapsedSec)} color={C_BLUE} />
              <MetricRow label="FLIGHT DISTANCE" value={`${(metrics.totalFlightDistanceM / 1000).toFixed(2)} km`} color={C_GREEN} />
              <MetricRow label="WAYPOINTS REACHED" value={`${metrics.waypointsReached}`} color={C_BLUE} />
              <MetricRow label="THERMAL CONTACTS" value={`${uniqueContacts} unique / ${metrics.thermalContacts} detections`} color={C_MAGENTA} />
              <MetricRow label="CONFLICTS DETECTED" value={`${metrics.conflictsDetected}`} color={metrics.conflictsDetected > 0 ? C_RED : C_GREEN} />
              <MetricRow label="RTB TRIGGERS" value={`${metrics.rtbTriggers}`} color={metrics.rtbTriggers > 0 ? C_YELLOW : C_GREEN} />
              <MetricRow label="GEOFENCE BREACHES" value={`${metrics.geofenceBreaches}`} color={metrics.geofenceBreaches > 0 ? C_RED : C_GREEN} />
              <MetricRow label="CHAIN EVENTS" value={`${events.length}`} color={C_BLUE} />
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 6 }}>Fleet Status</div>
            {drones.map((d) => (
              <div key={d.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 0', borderBottom: '1px solid var(--border)',
                fontFamily: 'var(--font-mono)', fontSize: 10,
              }}>
                <span style={{ color: d.color, minWidth: 64 }}>{d.label}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{d.missionState.replace(/_/g, ' ').toUpperCase()}</span>
                <span style={{ color: d.batteryPct < 25 ? C_YELLOW : C_GREEN }}>{Math.round(d.batteryPct)}%</span>
                <span style={{ color: 'var(--text-dim)' }}>{Math.round(d.altitudeFt)}ft</span>
              </div>
            ))}
            {drones.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 10 }}>No drones — load a scenario</div>
            )}
          </div>

          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 6 }}>FAA Part 107 — Fleet</div>
            {drones.map((d) => (
              <div key={d.id} style={{ display: 'flex', gap: 8, marginBottom: 3, fontSize: 9, fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: d.color, minWidth: 56 }}>{d.label}</span>
                <CompCheck ok={d.altitudeFt <= 400} label={`${Math.round(d.altitudeFt)}ft`} />
                <CompCheck ok={d.speedMs <= certifiedSpeedLimitMs(scenario, d.id) + 0.5} label={`${(d.speedMs * 2.237).toFixed(0)}mph`} />
                <CompCheck ok={d.signalDbm > -90} label={`${d.signalDbm}dBm`} />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* ── READINESS TAB ────────────────────────────────────────────────── */}
      {activeTab === 'readiness' && outcome && compliance && utm && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }} data-testid="investor-readiness-panel">
          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>Mission Outcome (measured)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <MetricRow label="OUTCOME" value={outcome.headline} color={C_BLUE} />
              <MetricRow label="ROUTE PROGRESS" value={`${Math.round(outcome.searchCoveragePct)}%`} color={C_GREEN} />
              <MetricRow label="CONTACTS" value={`${outcome.detectedContacts} detected / ${outcome.resolvedContacts} actioned`} color={C_MAGENTA} />
              <MetricRow label="FLEET HEALTH" value={`${Math.round(outcome.fleetHealthScore)}%`} color={outcome.fleetHealthScore < 60 ? C_YELLOW : C_GREEN} />
            </div>
          </div>

          {/* REALISM_ROADMAP WP-6 — probability of detection. The row above is route progress:
              how much of the planned track has been flown. It is NOT a detection claim, which is
              why it is no longer labelled "search coverage". POD is the detection claim, and it
              is the metric a SAR planner reads: R_d → W = 1.645·R_d → coverage → POD. Absent
              entirely for scenarios with no authored search area. */}
          {podReport && podReport.sweeps.length > 0 && <SectorPodSection report={podReport} />}

          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>Compliance & Airspace Readiness</div>
            <ReadinessPill label="REMOTE ID" value={compliance.remoteId.status.toUpperCase()} tone={compliance.remoteId.status === 'broadcasting' ? 'good' : 'warn'} />
            <ReadinessPill label="AUTH" value={compliance.airspace.authorization.label} tone={compliance.airspace.authorization.status === 'ready' ? 'good' : 'warn'} />
            <ReadinessPill label="MAX ALT" value={`${Math.round(compliance.airspace.maxObservedAltitudeFt)}ft AGL`} tone={compliance.airspace.maxObservedAltitudeFt <= 400 ? 'good' : 'bad'} />
            {/* REALISM_ROADMAP WP-3 — real published FAA ceilings, with their edition date.
                The date is not decoration: the accept criterion is that a stale fixture is
                visible rather than silently wrong, and this is the panel an operator reads
                airspace readiness from. Absent for scenarios with no published facility map. */}
            {ceilingCaption && (
              <ReadinessPill label="FAA CEILINGS" value={ceilingCaption} tone="good" />
            )}
            {compliance.waiverFlags.map((flag) => (
              <ReadinessPill key={`${flag.kind}-${flag.label}`} label={flag.kind.replace(/_/g, ' ').toUpperCase()} value={flag.detail} tone={flag.severity === 'critical' ? 'bad' : 'warn'} />
            ))}
            <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', lineHeight: 1.35 }}>
              {compliance.disclaimer}
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>UTM / External Traffic</div>
            <ReadinessPill label="COORD" value={utm.coordinationMode} tone="good" />
            <ReadinessPill label="TRACKS" value={`${utm.externalTracks.length} external / ${utm.reservations.length} reservations`} tone="good" />
            <ReadinessPill label="CONFLICTS" value={`${utm.conflicts.length} active`} tone={utm.conflicts.length > 0 ? 'warn' : 'good'} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function tabLabel(tab: Tab): string {
  if (tab === 'telem') return 'TELEM'
  if (tab === 'mavlink') return 'MAVLINK'
  if (tab === 'metrics') return 'METRICS'
  return 'READY'
}

/**
 * WP-6 sector POD. Cumulative first — it is the number that answers "have we searched this
 * sector well enough to move on?" — then the per-sweep breakdown that explains it.
 *
 * An unsourced sweep renders as UNSOURCED, never as 0% and never as a plausible-looking figure.
 * The distinction is the whole point: 0% means the sweep genuinely detected nothing detectable,
 * UNSOURCED means the platform's optics are unpublished so no honest claim can be made at all.
 */
function SectorPodSection({ report }: { report: SectorPodReport }) {
  const cumulativePct = report.cumulativePod === null ? null : Math.round(report.cumulativePod * 100)
  const areaKm2 = report.sectorAreaM2 / 1_000_000
  return (
    <div className="panel-section" data-testid="sector-pod-section">
      <div className="panel-label" style={{ marginBottom: 8 }}>Probability of Detection (sector)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <MetricRow
          label="CUMULATIVE POD"
          value={cumulativePct === null ? 'UNSOURCED' : `${cumulativePct}%`}
          color={cumulativePct === null ? C_YELLOW : cumulativePct >= 80 ? C_GREEN : cumulativePct >= 50 ? C_YELLOW : C_RED}
        />
        <MetricRow label="SECTOR AREA" value={`${areaKm2.toFixed(2)} km²`} color={C_BLUE} />
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {report.sweeps.map((sweep) => <SweepRow key={sweep.droneId} sweep={sweep} />)}
      </div>
      <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--text-dim)', lineHeight: 1.35 }}>
        POD = 1 − e^(−coverage), coverage = (track × W) / area, W = 1.645 · R_d (USCG/NASAR
        detection experiments, R² = 0.827). R_d is the Johnson-criteria range for this platform's
        published thermal optics after atmospheric transmission.
        {report.unsourcedPlatforms.length > 0 && ` Excluded for unpublished optics: ${report.unsourcedPlatforms.join(', ')}.`}
      </div>
    </div>
  )
}

function SweepRow({ sweep }: { sweep: SectorSweep }) {
  const podPct = sweep.pod === null ? null : Math.round(sweep.pod * 100)
  const detail = sweep.status === 'unsourced'
    ? 'optics not published'
    : sweep.status === 'no_effort'
      ? 'not on task in sector'
      : sweep.status === 'no_los'
        ? 'swath occluded'
        : `${(sweep.trackLengthM / 1000).toFixed(2)}km × ${Math.round(sweep.sweepWidthM)}m W${sweep.losFraction < 1 ? ` · ${Math.round(sweep.losFraction * 100)}% LOS` : ''}`
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 9, fontFamily: 'var(--font-mono)' }}>
      <span style={{ minWidth: 56, color: 'var(--text-dim)' }}>{sweep.label}</span>
      <strong style={{ minWidth: 40, color: podPct === null ? C_YELLOW : podPct >= 50 ? C_GREEN : C_YELLOW }}>
        {podPct === null ? '—' : `${podPct}%`}
      </strong>
      <span style={{ flex: 1, color: 'var(--text-dim)' }}>{detail}</span>
    </div>
  )
}

function ReadinessPill({ label, value, tone }: { label: string; value: string; tone: 'good' | 'warn' | 'bad' }) {
  const color = tone === 'good' ? 'var(--accent-green)' : tone === 'warn' ? 'var(--accent-yellow)' : 'var(--accent-red)'
  return (
    <div className="readiness-pill">
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

function EventRow({ event: e, chainValid }: { event: MissionEvent; chainValid: boolean }) {
  const color = EVENT_COLORS[e.eventType] ?? '#8899aa'
  const shortHash = e.hash.slice(0, 8)
  const label = e.eventType.replace(/_/g, ' ')
  const droneShort = e.droneId === 'system' ? 'SYS' : e.droneId.toUpperCase().slice(-4)
  // The mark reflects the verifyChain() result — never an unconditional checkmark.
  return (
    <div className="event-row" title={`Full hash: ${e.hash}`}>
      <span className="event-tick" style={{ minWidth: 44 }}>T+{e.tick}</span>
      <span className="event-drone" style={{ minWidth: 32, color: '#8899aa' }}>{droneShort}</span>
      <span className="event-type" style={{ flex: 1, color }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 8, color: chainValid ? '#44cc66' : 'var(--accent-red)', letterSpacing: 0 }}>
        {shortHash}{chainValid ? '✓' : '✗'}
      </span>
    </div>
  )
}

function TRow({ label, value, warn, crit }: { label: string; value: string; warn?: boolean; crit?: boolean }) {
  return (
    <div className="telem-row">
      <span className="telem-key">{label}</span>
      <span className="telem-val" style={{
        color: crit ? 'var(--accent-red)' : warn ? 'var(--accent-yellow)' : undefined,
        fontSize: label === 'POSITION' ? 9 : undefined,
      }}>
        {value}
      </span>
    </div>
  )
}

function MetricRow({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-dim)', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color, fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function WarnBadge({ level, text }: { level: 'critical' | 'caution' | 'info'; text: string }) {
  return (
    <div className={`warning-badge ${level}`}>
      <span>{level === 'critical' ? '⚠' : level === 'caution' ? '△' : 'ℹ'}</span>
      <span>{text}</span>
    </div>
  )
}

function CompCheck({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 9 }}>
      <span className={ok ? 'part107-ok' : 'part107-warn'}>{ok ? '✓' : '✗'}</span>
      <span style={{ color: ok ? 'var(--text-secondary)' : 'var(--accent-yellow)' }}>{label}</span>
    </div>
  )
}

function compassDir(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8]
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
