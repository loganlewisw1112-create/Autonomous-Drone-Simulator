import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getScenarioById } from '@/scenarios/registry'
import { compileCustomMission } from '@/components/designer/designerValidation'
import { useClassroomStore, type ClassroomCommandRecord } from '@/classroom/classroomStore'
import { closeClass, focusStudent, sendCommand } from '@/classroom/classroomClient'
import { alertSeverity, stateToCode, type AlertSeverity, type GridDrone } from '@/classroom/gridFrame'
import type { InstructorCommand } from '@/classroom/commandRegistry'
import {
  commandsForPolicy, CONTROL_POLICY_PRESETS, type ControlPolicyId,
} from '@/classroom/controlPolicy'
import type { MissionAssessment } from '@/classroom/missionAssessment'
import {
  computeBbox, drawBackdrop, fitBboxToAspect, renderTile, syncCanvasToDisplaySize,
  type Bbox, type BackdropGeometry,
} from '@/components/classroom/tileRenderer'
import { StudentTile, TILE_ASPECT } from '@/components/classroom/StudentTile'
import { FocusMap } from '@/components/classroom/FocusMap'
import { captureBasemap } from '@/components/classroom/basemapSnapshot'
import { ClassResults } from '@/components/classroom/ClassResults'
import type { ClassConfig, RosterEntry, StudentId } from '@/classroom/protocol'
import type { DroneState, LatLng, ScenarioConfig } from '@/types'
import './classroom.css'

const SEVERITY_RANK: Record<AlertSeverity, number> = { crit: 0, warn: 1, none: 2 }
// Shared backdrop bitmap. Drawn once per class and blitted by every tile, so it must be big
// enough to survive being scaled UP into the focus pane (which is several hundred px wide on a
// projector) without going soft — the old 360×240 was the same size as a tile and blurred badly
// the moment it was enlarged. 3:2 to match TILE_ASPECT exactly.
const BACKDROP_W = 1080
const BACKDROP_H = 720
let commandCounter = 0

interface SiteOption {
  id: string
  label: string
  position: LatLng
}

function nextCommandId(): string {
  commandCounter += 1
  return `cmd-${Date.now().toString(36)}-${commandCounter.toString(36)}`
}

function scenarioForConfig(config: ClassConfig): ScenarioConfig | null {
  return config.kind === 'catalog'
    ? getScenarioById(config.scenarioId)?.config ?? null
    : compileCustomMission(config.definition)
}

function scenarioPoints(sc: ScenarioConfig): LatLng[] {
  const points: LatLng[] = [sc.startPosition]
  sc.waypoints?.forEach((waypoint) => points.push(waypoint.position))
  sc.searchArea?.forEach((position) => points.push(position))
  sc.geofences?.forEach((geofence) => geofence.polygon.forEach((position) => points.push(position)))
  Object.values(sc.perDroneWaypoints ?? {}).forEach((waypoints) => waypoints.forEach((waypoint) => points.push(waypoint.position)))
  Object.values(sc.perDroneStartPositions ?? {}).forEach((position) => points.push(position))
  return points
}

function scenarioGeometry(sc: ScenarioConfig): BackdropGeometry {
  return {
    geofences: sc.geofences?.map((geofence) => geofence.polygon),
    searchAreas: sc.searchArea ? [sc.searchArea] : [],
    routes: Object.values(sc.perDroneWaypoints ?? {}).map((waypoints) => waypoints.map((waypoint) => waypoint.position)),
    sites: [sc.startPosition, ...Object.values(sc.perDroneStartPositions ?? {})],
  }
}

function scenarioSites(sc: ScenarioConfig | null): SiteOption[] {
  if (!sc) return []
  const sites = new Map<string, SiteOption>()
  for (const [recordId, site] of Object.entries({ ...sc.recoverySites, ...sc.launchSites })) {
    const id = site.id?.trim() || recordId
    sites.set(id, { id, label: site.label || id, position: site.position })
  }
  return [...sites.values()].sort((left, right) => left.label.localeCompare(right.label))
}

export function CoordinatorConsole() {
  const {
    classId, config, roster, frames, focusedStudentId, focusFrame, focusAssessment, commands,
  } = useClassroomStore(useShallow((state) => ({
    classId: state.classId,
    config: state.config,
    roster: state.roster,
    frames: state.frames,
    focusedStudentId: state.focusedStudentId,
    focusFrame: state.focusFrame,
    focusAssessment: state.focusAssessment,
    commands: state.commands,
  })))
  const integrity = useClassroomStore((state) => state.integrity)
  const [rightPane, setRightPane] = useState<'results' | 'focus'>('results')
  const [targetMode, setTargetMode] = useState<'focused' | 'all'>('focused')

  const scenario = useMemo(() => config ? scenarioForConfig(config) : null, [config])

  /**
   * The wall backdrop: a real basemap with the mission geometry drawn over it, composited once
   * and blitted by every tile.
   *
   * Synchronous first pass so the wall is never blank, then a second pass once the shared basemap
   * capture resolves (see basemapSnapshot for why one capture serves all 40 tiles). If the capture
   * fails — no WebGL, no network — the first pass simply stands, which is the old behaviour.
   */
  const [backdrop, setBackdrop] = useState<{ canvas: HTMLCanvasElement; bbox: Bbox } | null>(null)

  useEffect(() => {
    if (!scenario) {
      setBackdrop(null)
      return
    }
    let cancelled = false

    const geometry = scenarioGeometry(scenario)
    const requested = fitBboxToAspect(computeBbox(scenarioPoints(scenario)), BACKDROP_W, BACKDROP_H)

    const compose = (bbox: Bbox, basemap: HTMLCanvasElement | null) => {
      const canvas = document.createElement('canvas')
      canvas.width = BACKDROP_W
      canvas.height = BACKDROP_H
      const context = canvas.getContext('2d')
      if (!context) return null
      if (basemap) {
        context.drawImage(basemap, 0, 0, BACKDROP_W, BACKDROP_H)
        // Knock the basemap back so it reads as context rather than competing with the mission
        // geometry and drone glyphs drawn on top of it.
        context.fillStyle = 'rgba(11, 15, 23, 0.45)'
        context.fillRect(0, 0, BACKDROP_W, BACKDROP_H)
      }
      drawBackdrop(context, geometry, bbox, BACKDROP_W, BACKDROP_H, { fillBackground: !basemap })
      return { canvas, bbox }
    }

    setBackdrop(compose(requested, null))

    captureBasemap({ bbox: requested, width: BACKDROP_W, height: BACKDROP_H }).then((snapshot) => {
      if (cancelled || !snapshot) return
      // Project against the bounds MapLibre SETTLED on, not the ones it was asked for — fitBounds
      // snaps to its own zoom, and using the requested window would offset every glyph.
      const composed = compose(snapshot.bounds, snapshot.image)
      if (composed) setBackdrop(composed)
    })

    return () => { cancelled = true }
  }, [scenario])

  const scenarioName = config && config.kind === 'catalog'
    ? getScenarioById(config.scenarioId)?.label ?? config.scenarioId
    : config?.kind === 'custom' ? config.definition.name : ''

  const sorted = useMemo(() => [...roster].sort((left, right) => {
    const leftRank = SEVERITY_RANK[frames[left.studentId] ? alertSeverity(frames[left.studentId].a) : 'none']
    const rightRank = SEVERITY_RANK[frames[right.studentId] ? alertSeverity(frames[right.studentId].a) : 'none']
    return leftRank - rightRank || left.displayName.localeCompare(right.displayName)
  }), [roster, frames])
  const alerting = sorted.filter((entry) => frames[entry.studentId] && alertSeverity(frames[entry.studentId].a) !== 'none')
  const rejected = integrity.decryptFailures + integrity.replayRejects
  const droneIds = useMemo(() => {
    const ids = new Set<string>()
    focusFrame?.drones.forEach((drone) => ids.add(drone.id))
    Object.values(frames).forEach((frame) => frame.d.forEach((drone) => ids.add(drone[0])))
    return [...ids].sort()
  }, [focusFrame, frames])

  function focus(studentId: StudentId) {
    focusStudent(studentId)
    setTargetMode('focused')
    setRightPane('focus')
  }

  const bbox = backdrop?.bbox ?? computeBbox([{ lat: 0, lng: 0 }])
  const bitmap = backdrop?.canvas ?? null

  // The focus map draws the same mission geometry as the wall backdrop, but as real GeoJSON over
  // a real basemap. Memoised on the scenario so panning the map never re-uploads the sources.
  const focusGeometry = useMemo<BackdropGeometry>(
    () => scenario ? scenarioGeometry(scenario) : {},
    [scenario],
  )
  const focusFitPoints = useMemo<LatLng[]>(
    () => scenario ? scenarioPoints(scenario) : [],
    [scenario],
  )

  return (
    <div className="cls-shell">
      <header className="cls-header">
        <span className="cls-title">⬡ Coordinator</span>
        <span className="cls-code" title="Read this code aloud">{classId}</span>
        <span className="cls-header-meta">{scenarioName}</span>
        <span className="cls-header-meta cls-header-count">{roster.length} joined</span>
        {rejected > 0 && (
          <span
            className="cls-integrity"
            title={`${integrity.decryptFailures} frame(s) would not decrypt, ${integrity.replayRejects} repeated a sequence number.`}
          >
            ⚠ {rejected} rejected
          </span>
        )}
        <div className="cls-pane-tabs" aria-label="Detail view">
          <button className={`cls-tab ${rightPane === 'focus' ? 'active' : ''}`} onClick={() => setRightPane('focus')}>Focus</button>
          <button className={`cls-tab ${rightPane === 'results' ? 'active' : ''}`} onClick={() => setRightPane('results')}>Results</button>
        </div>
        <button className="cls-btn ghost cls-header-btn" onClick={closeClass}>End class</button>
      </header>

      <div className="cls-alert-strip">
        {alerting.length === 0
          ? <span className="cls-muted">No alerts</span>
          : alerting.map((entry) => {
            const severity = alertSeverity(frames[entry.studentId].a)
            return (
              <button key={entry.studentId} className={`cls-alert-pill ${severity}`} onClick={() => focus(entry.studentId)}>
                {entry.displayName}
              </button>
            )
          })}
      </div>

      <div className="cls-body">
        <CommandRail
          targetMode={targetMode}
          onTargetModeChange={setTargetMode}
          focusedStudentId={focusedStudentId}
          roster={roster}
          droneIds={droneIds}
          sites={scenarioSites(scenario)}
        />

        <main className={`cls-wall ${roster.length > 16 ? 'compact' : ''}`} aria-label="Student rubric wall">
          {sorted.length === 0 && (
            <div className="cls-wall-empty">Waiting for students to join with code <b>{classId}</b>…</div>
          )}
          {sorted.map((entry) => (
            <StudentTile
              key={entry.studentId}
              studentId={entry.studentId}
              name={entry.displayName}
              backdrop={bitmap}
              bbox={bbox}
              selected={entry.studentId === focusedStudentId}
              onClick={() => focus(entry.studentId)}
            />
          ))}
        </main>

        <aside className="cls-focus-pane">
          {rightPane === 'results'
            ? <ClassResults classId={classId ?? ''} />
            : <FocusDetail geometry={focusGeometry} fitPoints={focusFitPoints} bbox={bbox} backdrop={bitmap} />}
          <CommandHistory commands={commands} roster={roster} focusAssessment={focusAssessment} />
        </aside>
      </div>
    </div>
  )
}

function CommandRail({
  targetMode, onTargetModeChange, focusedStudentId, roster, droneIds, sites,
}: {
  targetMode: 'focused' | 'all'
  onTargetModeChange: (target: 'focused' | 'all') => void
  focusedStudentId: StudentId | null
  roster: RosterEntry[]
  droneIds: string[]
  sites: SiteOption[]
}) {
  const [selectedDroneId, setSelectedDroneId] = useState('')
  const [directive, setDirective] = useState('')
  const [siteId, setSiteId] = useState('')
  const [siteLat, setSiteLat] = useState('')
  const [siteLng, setSiteLng] = useState('')
  const [policyId, setPolicyId] = useState<ControlPolicyId>('student_led')
  const [dispatchNote, setDispatchNote] = useState('')
  const focusedName = roster.find((entry) => entry.studentId === focusedStudentId)?.displayName
  const target = targetMode === 'all' ? null : focusedStudentId
  const canSend = targetMode === 'all' ? roster.length > 0 : focusedStudentId !== null

  useEffect(() => {
    if (!droneIds.includes(selectedDroneId)) setSelectedDroneId(droneIds[0] ?? '')
  }, [droneIds, selectedDroneId])

  useEffect(() => {
    if (sites.some((site) => site.id === siteId)) return
    const first = sites[0]
    setSiteId(first?.id ?? '')
    setSiteLat(first ? String(first.position.lat) : '')
    setSiteLng(first ? String(first.position.lng) : '')
  }, [siteId, sites])

  function issue(command: InstructorCommand) {
    if (!canSend) return
    const recipients = sendCommand(target, command)
    setDispatchNote(recipients.length > 0 ? `Sent to ${recipients.length}` : 'No connected recipient')
  }

  function issueKind(kind: 'pause' | 'resume_session' | 'end_mission' | 'restart' | 'rtb_all' | 'hold_all' | 'retask_fleet' | 'undo_retask') {
    issue({ commandId: nextCommandId(), kind })
  }

  function issueDrone(kind: 'hover' | 'resume' | 'rtb' | 'remote_land' | 'abort_recovery') {
    if (!selectedDroneId) return
    issue({ commandId: nextCommandId(), kind, droneId: selectedDroneId })
  }

  function changeSite(nextSiteId: string) {
    setSiteId(nextSiteId)
    const site = sites.find((option) => option.id === nextSiteId)
    if (site) {
      setSiteLat(String(site.position.lat))
      setSiteLng(String(site.position.lng))
    }
  }

  function repositionSite() {
    const lat = Number(siteLat)
    const lng = Number(siteLng)
    if (!siteId || !Number.isFinite(lat) || !Number.isFinite(lng)) return
    issue({ commandId: nextCommandId(), kind: 'reposition_site', siteId, position: { lat, lng } })
  }

  function sendDirective() {
    const text = directive.trim()
    if (!text) return
    issue({ commandId: nextCommandId(), kind: 'directive', text })
    setDirective('')
  }

  return (
    <aside className="cls-command-rail" aria-label="Instructor command rail">
      <div className="cls-rail-heading">
        <strong>Command authority</strong>
        {dispatchNote && <span role="status">{dispatchNote}</span>}
      </div>

      <label className="cls-field-label">
        Target
        <select
          className="cls-select"
          aria-label="Command target"
          value={targetMode}
          onChange={(event) => onTargetModeChange(event.target.value as 'focused' | 'all')}
        >
          <option value="focused" disabled={!focusedStudentId}>Focused{focusedName ? ` — ${focusedName}` : ' — none'}</option>
          <option value="all">Whole class ({roster.length})</option>
        </select>
      </label>

      <CommandGroup title="Mission">
        <CommandButton disabled={!canSend} onClick={() => issueKind('pause')}>Pause</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('resume_session')}>Resume</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('end_mission')} danger>End mission</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('restart')}>Restart</CommandButton>
      </CommandGroup>

      <CommandGroup title="Fleet">
        <CommandButton disabled={!canSend} onClick={() => issueKind('hold_all')}>Hold all</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('rtb_all')}>RTB all</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('retask_fleet')}>Retask</CommandButton>
        <CommandButton disabled={!canSend} onClick={() => issueKind('undo_retask')}>Undo retask</CommandButton>
      </CommandGroup>

      <CommandGroup title="Selected drone" wide>
        <select className="cls-select" aria-label="Selected drone" value={selectedDroneId} onChange={(event) => setSelectedDroneId(event.target.value)}>
          {droneIds.length === 0 && <option value="">No drone telemetry</option>}
          {droneIds.map((droneId) => <option key={droneId} value={droneId}>{droneId}</option>)}
        </select>
        <div className="cls-command-grid">
          <CommandButton disabled={!canSend || !selectedDroneId} onClick={() => issueDrone('hover')}>Hover</CommandButton>
          <CommandButton disabled={!canSend || !selectedDroneId} onClick={() => issueDrone('resume')}>Resume UAV</CommandButton>
          <CommandButton disabled={!canSend || !selectedDroneId} onClick={() => issueDrone('rtb')}>RTB</CommandButton>
          <CommandButton disabled={!canSend || !selectedDroneId} onClick={() => issueDrone('remote_land')} danger>Land</CommandButton>
          <CommandButton disabled={!canSend || !selectedDroneId} onClick={() => issueDrone('abort_recovery')}>Abort recovery</CommandButton>
          <CommandButton
            disabled={!canSend || !selectedDroneId}
            onClick={() => issue({ commandId: nextCommandId(), kind: 'command_route', droneId: selectedDroneId, routeCommand: 'deep_scan' })}
          >
            Deep scan
          </CommandButton>
        </div>
      </CommandGroup>

      <CommandGroup title="Authority / policy" wide>
        <label className="cls-field-label">
          Control policy
          <select
            className="cls-select"
            aria-label="Control policy preset"
            value={policyId}
            disabled={!canSend}
            onChange={(event) => setPolicyId(event.target.value as ControlPolicyId)}
          >
            {Object.values(CONTROL_POLICY_PRESETS).map((policy) => (
              <option key={policy.id} value={policy.id}>{policy.label}</option>
            ))}
          </select>
        </label>
        <span className="cls-policy-description">{CONTROL_POLICY_PRESETS[policyId].description}</span>
        <CommandButton
          disabled={!canSend}
          onClick={() => commandsForPolicy(policyId, () => nextCommandId()).forEach(issue)}
        >
          Apply policy
        </CommandButton>
        <label className="cls-field-label">
          Operator role
          <select
            className="cls-select"
            aria-label="Operator role policy"
            defaultValue=""
            disabled={!canSend}
            onChange={(event) => {
              if (!event.target.value) return
              issue({ commandId: nextCommandId(), kind: 'set_operator_role', role: event.target.value as 'pic' | 'mission_commander' | 'observer' })
              event.target.value = ''
            }}
          >
            <option value="">Set…</option>
            <option value="pic">PIC</option>
            <option value="mission_commander">Mission commander</option>
            <option value="observer">Observer</option>
          </select>
        </label>
        <label className="cls-field-label">
          Simulation speed
          <select
            className="cls-select"
            aria-label="Simulation speed policy"
            defaultValue=""
            disabled={!canSend}
            onChange={(event) => {
              const speed = Number(event.target.value)
              if (![1, 5, 10, 20].includes(speed)) return
              issue({ commandId: nextCommandId(), kind: 'set_sim_speed', speed: speed as 1 | 5 | 10 | 20 })
              event.target.value = ''
            }}
          >
            <option value="">Set…</option>
            <option value="1">1×</option><option value="5">5×</option><option value="10">10×</option><option value="20">20×</option>
          </select>
        </label>
      </CommandGroup>

      <CommandGroup title="Directive / inject" wide>
        <textarea
          className="cls-input cls-directive"
          aria-label="Instructor directive"
          maxLength={500}
          placeholder="Operational directive…"
          value={directive}
          onChange={(event) => setDirective(event.target.value)}
        />
        <CommandButton disabled={!canSend || !directive.trim()} onClick={sendDirective}>Send directive</CommandButton>
      </CommandGroup>

      {sites.length > 0 && (
        <CommandGroup title="Reposition site" wide>
          <select className="cls-select" aria-label="Launch or recovery site" value={siteId} onChange={(event) => changeSite(event.target.value)}>
            {sites.map((site) => <option key={site.id} value={site.id}>{site.label}</option>)}
          </select>
          <div className="cls-coordinate-grid">
            <input className="cls-input" aria-label="Site latitude" inputMode="decimal" value={siteLat} onChange={(event) => setSiteLat(event.target.value)} />
            <input className="cls-input" aria-label="Site longitude" inputMode="decimal" value={siteLng} onChange={(event) => setSiteLng(event.target.value)} />
          </div>
          <CommandButton disabled={!canSend || !siteId} onClick={repositionSite}>Reposition</CommandButton>
        </CommandGroup>
      )}
    </aside>
  )
}

function CommandGroup({ title, wide = false, children }: { title: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <section className="cls-command-group">
      <h3>{title}</h3>
      <div className={wide ? 'cls-command-stack' : 'cls-command-grid'}>{children}</div>
    </section>
  )
}

function CommandButton({ danger = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) {
  return <button className={`cls-command-btn${danger ? ' danger' : ''}`} type="button" {...props} />
}

const NO_DRONES: DroneState[] = []

/** The Canvas-2D plot, kept as the no-WebGL fallback for the focus pane. */
function FocusPlot({ bbox, backdrop, drones }: {
  bbox: Bbox
  backdrop: CanvasImageSource | null
  drones: readonly DroneState[]
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const plotted: GridDrone[] = drones.map((drone) => ({
      id: drone.id,
      lat: drone.position.lat,
      lng: drone.position.lng,
      headingDeg: drone.headingDeg,
      batteryPct: drone.batteryPct,
      stateCode: stateToCode(drone.missionState),
    }))
    const size = syncCanvasToDisplaySize(canvas, TILE_ASPECT)
    if (!size) return
    renderTile(context, backdrop, plotted, fitBboxToAspect(bbox, size.width, size.height), size.width, size.height)
  }, [drones, bbox, backdrop])
  return <canvas ref={canvasRef} />
}

function FocusDetail({ geometry, fitPoints, bbox, backdrop }: {
  geometry: BackdropGeometry
  fitPoints: LatLng[]
  bbox: Bbox
  backdrop: CanvasImageSource | null
}) {
  const { focusedStudentId, focusFrame, focusAssessment, roster } = useClassroomStore(useShallow((state) => ({
    focusedStudentId: state.focusedStudentId,
    focusFrame: state.focusFrame,
    focusAssessment: state.focusAssessment,
    roster: state.roster,
  })))
  const name = roster.find((entry) => entry.studentId === focusedStudentId)?.displayName ?? ''

  if (!focusedStudentId) return <div className="cls-muted">Click a tile to watch a student in full detail.</div>

  return (
    <div className="cls-focus-detail">
      <div className="cls-focus-title">{name}</div>
      {/* A real basemap, not the Canvas-2D plot the wall uses. One focused student costs one
          WebGL context, which is affordable — the §16.2 limit is per TILE, not per console. */}
      <FocusMap
        geometry={geometry}
        drones={focusFrame?.drones ?? NO_DRONES}
        fitPoints={fitPoints}
        fallback={<FocusPlot bbox={bbox} backdrop={backdrop} drones={focusFrame?.drones ?? NO_DRONES} />}
      />
      {!focusFrame ? (
        <div className="cls-muted">Waiting for the focus stream…</div>
      ) : (
        <>
          <div className="cls-focus-meta">
            T+{Math.floor(focusFrame.elapsedSec / 60)}:{String(Math.floor(focusFrame.elapsedSec % 60)).padStart(2, '0')}
            {' · '}wind {Math.round(focusFrame.weatherState.windKts)} kt
            {' · '}vis {focusFrame.weatherState.visibilityMi.toFixed(1)} mi
            {' · '}{focusFrame.thermalContacts.length} thermal
          </div>
          <table className="cls-table">
            <thead><tr><th>Drone</th><th>State</th><th>Alt</th><th>Batt</th><th>Sig</th></tr></thead>
            <tbody>
              {focusFrame.drones.map((drone) => (
                <tr key={drone.id}>
                  <td>{drone.label}</td><td>{drone.missionState}</td><td>{Math.round(drone.altitudeFt)}ft</td>
                  <td className={drone.batteryPct < 20 ? 'cls-danger-text' : ''}>{Math.round(drone.batteryPct)}%</td>
                  <td>{Math.round(drone.signalDbm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {focusAssessment ? <AssessmentDetail assessment={focusAssessment} /> : <div className="cls-muted">Waiting for assessment…</div>}
    </div>
  )
}

function AssessmentDetail({ assessment }: { assessment: MissionAssessment }) {
  return (
    <section className="cls-focus-assessment" aria-label="Focused student assessment">
      <div className="cls-assessment-hero">
        <span><b>{Math.round(assessment.progressPercent)}%</b><small>progress</small></span>
        <span><b>{assessment.band} · {assessment.total}</b><small>band / score</small></span>
      </div>
      <progress value={assessment.progressPercent} max={100} aria-label="Mission progress" />
      <div className="cls-assessment-tiers">
        <span>Incident stabilization <b>{assessment.tier1}/60</b></span>
        <span>Resource stewardship <b>{assessment.tier2}/40</b></span>
      </div>
      <div className={`cls-safety-gate ${assessment.lifeSafety.status}`}>
        Life safety: <b>{assessment.lifeSafety.status.toUpperCase()}</b>
        <span>{assessment.lifeSafety.status === 'fail' ? ` · ${assessment.lifeSafety.severity} · cap ${assessment.lifeSafety.cap}` : ''}</span>
      </div>
      <div className="cls-assessment-section">
        <h4>Objectives</h4>
        {assessment.objectives.length === 0 ? <span className="cls-muted">No objectives reported.</span> : (
          <ul>{assessment.objectives.map((objective) => (
            <li key={objective.id}><span>{objective.label}</span><b>{Math.round(objective.completion * 100)}%</b></li>
          ))}</ul>
        )}
      </div>
      <div className="cls-assessment-section">
        <h4>Findings</h4>
        {assessment.lifeSafety.findings.length === 0 ? <span className="cls-muted">No life-safety findings.</span> : (
          <ul>{assessment.lifeSafety.findings.map((finding, index) => (
            <li key={`${finding.code}-${index}`} className={`finding-${finding.severity}`}>
              <span><b>{finding.code.replaceAll('_', ' ')}</b><small>{finding.message}</small></span>
            </li>
          ))}</ul>
        )}
      </div>
    </section>
  )
}

function CommandHistory({
  commands, roster, focusAssessment,
}: {
  commands: ClassroomCommandRecord[]
  roster: RosterEntry[]
  focusAssessment: MissionAssessment | null
}) {
  const recent = commands.slice(-20).reverse()
  return (
    <section className="cls-command-history" aria-label="Command and intervention history">
      <h3>Command / intervention history</h3>
      {recent.length === 0 ? <div className="cls-muted">No commands issued.</div> : (
        <ol>
          {recent.map((command) => (
            <li key={`${command.studentId}-${command.commandId}`}>
              <span className={`cls-command-status ${command.status}`}>{command.status}</span>
              <b>{command.command.kind.replaceAll('_', ' ')}</b>
              <span>{roster.find((entry) => entry.studentId === command.studentId)?.displayName ?? command.studentId}</span>
              <code>{command.actorId}</code>
            </li>
          ))}
        </ol>
      )}
      {(focusAssessment?.interventions.length ?? 0) > 0 && (
        <div className="cls-assessment-interventions">
          <b>Assessment interventions</b>
          {focusAssessment!.interventions.map((intervention, index) => (
            <span key={`${intervention.actorId}-${intervention.tick}-${index}`}>
              {intervention.command ?? intervention.eventType} · {intervention.droneId} · {intervention.actorId}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
