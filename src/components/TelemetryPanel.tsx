import { useState, useEffect, useMemo, useRef } from 'react'
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts'
import { useDroneStore } from '@/store/droneStore'
import { verifyChain } from '@/utils/chainOfCustody'
import { encodeDroneTelemetry, formatMAVLinkLine } from '@/utils/mavlink'
import { buildComplianceState } from '@/sim/demo/complianceEngine'
import { buildMissionOutcomeSummary } from '@/sim/demo/missionOutcome'
import { buildUtmAirspaceState } from '@/sim/demo/utmEngine'
import type { MissionEvent } from '@/types'

// Tactical palette (hex — CSS vars don't work in recharts props)
const C_BLUE = '#00d4ff'
const C_GREEN = '#44ff88'
const C_YELLOW = '#ffaa00'
const C_RED = '#ff4444'
const C_MAGENTA = '#ff88ff'
const C_BG = '#0d1117'
const C_GRID = '#1e2b3a'

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

export function TelemetryPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('telem')
  const [mavlinkFeed, setMavlinkFeed] = useState<string[]>([])
  const mavFeedRef = useRef<HTMLDivElement>(null)

  const { drones, ui, events, telemetryHistory, thermalContacts, metrics, elapsedSec, scenario, scenarioVariant, setSensorMode } = useDroneStore()

  const selected = ui.selectedDroneId
    ? drones.find((d) => d.id === ui.selectedDroneId)
    : drones[0]

  const history = selected ? (telemetryHistory[selected.id] ?? []) : []
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
      for (const msg of encodeDroneTelemetry(d)) {
        lines.push(formatMAVLinkLine(msg))
      }
    }
    setMavlinkFeed((prev) => {
      const next = [...prev, ...lines]
      return next.length > MAX_MAVLINK_LINES ? next.slice(next.length - MAX_MAVLINK_LINES) : next
    })
  }, [drones, activeTab])

  // Auto-scroll MAVLink feed
  useEffect(() => {
    if (mavFeedRef.current) {
      mavFeedRef.current.scrollTop = mavFeedRef.current.scrollHeight
    }
  }, [mavlinkFeed])

  // Unique thermal contacts
  const uniqueContacts = new Set(thermalContacts.map((d) => d.sourceId)).size
  const outcome = buildMissionOutcomeSummary({
    scenario,
    drones,
    metrics,
    thermalContacts,
    eventsCount: events.length,
    elapsedSec,
  })
  const compliance = buildComplianceState({ scenario, drones, scenarioVariant, elapsedSec })
  const utm = buildUtmAirspaceState({ scenario, drones, elapsedSec })

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
                <TRow label="SPEED" value={`${selected.speedMs.toFixed(1)} m/s`} warn={selected.speedMs > 25} />
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

          {/* Altitude chart */}
          {history.length > 2 && (
            <div className="panel-section">
              <div className="panel-label" style={{ marginBottom: 4 }}>Altitude (ft AGL)</div>
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart data={history} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="altGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C_BLUE} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C_BLUE} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 420]} tick={{ fill: '#556677', fontSize: 9 }} tickCount={3} />
                  <Tooltip contentStyle={{ background: C_BG, border: `1px solid ${C_GRID}`, fontSize: 10 }} labelStyle={{ color: '#8899aa' }} itemStyle={{ color: C_BLUE }} formatter={(v: number) => [`${v} ft`, 'ALT']} labelFormatter={(t: number) => `T+${t}s`} />
                  <Area type="monotone" dataKey="alt" stroke={C_BLUE} strokeWidth={1.5} fill="url(#altGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Battery chart */}
          {history.length > 2 && (
            <div className="panel-section">
              <div className="panel-label" style={{ marginBottom: 4 }}>Battery (%)</div>
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart data={history} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="batGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={batColor} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={batColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 100]} tick={{ fill: '#556677', fontSize: 9 }} tickCount={3} />
                  <Tooltip contentStyle={{ background: C_BG, border: `1px solid ${C_GRID}`, fontSize: 10 }} labelStyle={{ color: '#8899aa' }} itemStyle={{ color: batColor }} formatter={(v: number) => [`${v}%`, 'BAT']} labelFormatter={(t: number) => `T+${t}s`} />
                  <Area type="monotone" dataKey="bat" stroke={batColor} strokeWidth={1.5} fill="url(#batGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Speed chart */}
          {history.length > 2 && (
            <div className="panel-section">
              <div className="panel-label" style={{ marginBottom: 4 }}>Speed (m/s)</div>
              <ResponsiveContainer width="100%" height={60}>
                <AreaChart data={history} margin={{ top: 2, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="spdGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={C_YELLOW} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={C_YELLOW} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="t" hide />
                  <YAxis domain={[0, 15]} tick={{ fill: '#556677', fontSize: 9 }} tickCount={3} />
                  <Tooltip contentStyle={{ background: C_BG, border: `1px solid ${C_GRID}`, fontSize: 10 }} labelStyle={{ color: '#8899aa' }} itemStyle={{ color: C_YELLOW }} formatter={(v: number) => [`${v} m/s`, 'SPD']} labelFormatter={(t: number) => `T+${t}s`} />
                  <Area type="monotone" dataKey="spd" stroke={C_YELLOW} strokeWidth={1.5} fill="url(#spdGrad)" dot={false} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
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
                <CompCheck ok={selected.speedMs <= 25.4} label={`SPD ≤ 57mph (${(selected.speedMs * 2.237).toFixed(1)}mph)`} />
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
                <CompCheck ok={d.speedMs <= 25.4} label={`${(d.speedMs * 2.237).toFixed(0)}mph`} />
                <CompCheck ok={d.signalDbm > -90} label={`${d.signalDbm}dBm`} />
              </div>
            ))}
          </div>
        </div>
      )}
      {/* ── READINESS TAB ────────────────────────────────────────────────── */}
      {activeTab === 'readiness' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }} data-testid="investor-readiness-panel">
          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>Mission Outcome (measured)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <MetricRow label="OUTCOME" value={outcome.headline} color={C_BLUE} />
              <MetricRow label="SEARCH COVERAGE" value={`${Math.round(outcome.searchCoveragePct)}%`} color={C_GREEN} />
              <MetricRow label="CONTACTS" value={`${outcome.detectedContacts} detected / ${outcome.resolvedContacts} actioned`} color={C_MAGENTA} />
              <MetricRow label="FLEET HEALTH" value={`${Math.round(outcome.fleetHealthScore)}%`} color={outcome.fleetHealthScore < 60 ? C_YELLOW : C_GREEN} />
            </div>
          </div>

          <div className="panel-section">
            <div className="panel-label" style={{ marginBottom: 8 }}>Compliance & Airspace Readiness</div>
            <ReadinessPill label="REMOTE ID" value={compliance.remoteId.status.toUpperCase()} tone={compliance.remoteId.status === 'broadcasting' ? 'good' : 'warn'} />
            <ReadinessPill label="AUTH" value={compliance.airspace.authorization.label} tone={compliance.airspace.authorization.status === 'ready' ? 'good' : 'warn'} />
            <ReadinessPill label="MAX ALT" value={`${Math.round(compliance.airspace.maxObservedAltitudeFt)}ft AGL`} tone={compliance.airspace.maxObservedAltitudeFt <= 400 ? 'good' : 'bad'} />
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
