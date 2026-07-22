import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getScenarioById } from '@/scenarios/registry'
import { compileCustomMission } from '@/components/designer/designerValidation'
import { useClassroomStore } from '@/classroom/classroomStore'
import { focusStudent, closeClass } from '@/classroom/classroomClient'
import { alertSeverity, stateToCode, type AlertSeverity, type GridDrone } from '@/classroom/gridFrame'
import {
  computeBbox, drawBackdrop, renderTile, type Bbox, type BackdropGeometry,
} from '@/components/classroom/tileRenderer'
import { StudentTile } from '@/components/classroom/StudentTile'
import { ClassResults } from '@/components/classroom/ClassResults'
import type { ClassConfig } from '@/classroom/protocol'
import type { LatLng, ScenarioConfig } from '@/types'
import './classroom.css'

const SEVERITY_RANK: Record<AlertSeverity, number> = { crit: 0, warn: 1, none: 2 }
const BACKDROP_W = 360
const BACKDROP_H = 240

function scenarioForConfig(config: ClassConfig): ScenarioConfig | null {
  return config.kind === 'catalog'
    ? getScenarioById(config.scenarioId)?.config ?? null
    : compileCustomMission(config.definition)
}

function scenarioPoints(sc: ScenarioConfig): LatLng[] {
  const pts: LatLng[] = [sc.startPosition]
  sc.waypoints?.forEach((w) => pts.push(w.position))
  sc.searchArea?.forEach((p) => pts.push(p))
  sc.geofences?.forEach((g) => g.polygon.forEach((p) => pts.push(p)))
  Object.values(sc.perDroneWaypoints ?? {}).forEach((ws) => ws.forEach((w) => pts.push(w.position)))
  Object.values(sc.perDroneStartPositions ?? {}).forEach((p) => pts.push(p))
  return pts
}

function scenarioGeometry(sc: ScenarioConfig): BackdropGeometry {
  return {
    geofences: sc.geofences?.map((g) => g.polygon),
    searchAreas: sc.searchArea ? [sc.searchArea] : [],
    routes: Object.values(sc.perDroneWaypoints ?? {}).map((ws) => ws.map((w) => w.position)),
    sites: [sc.startPosition, ...Object.values(sc.perDroneStartPositions ?? {})],
  }
}

export function CoordinatorConsole() {
  const { classId, config, roster, frames, focusedStudentId } = useClassroomStore(useShallow((s) => ({
    classId: s.classId, config: s.config, roster: s.roster,
    frames: s.frames, focusedStudentId: s.focusedStudentId,
  })))
  const [rightPane, setRightPane] = useState<'results' | 'focus'>('results')

  // Shared static backdrop + bbox, computed once per class. Every tile blits this one
  // bitmap (scaled to its size), so 40 tiles carry zero per-tile terrain cost.
  const backdrop = useMemo(() => {
    const sc = config ? scenarioForConfig(config) : null
    if (!sc) return null
    const bbox = computeBbox(scenarioPoints(sc))
    const canvas = document.createElement('canvas')
    canvas.width = BACKDROP_W
    canvas.height = BACKDROP_H
    const ctx = canvas.getContext('2d')
    if (ctx) drawBackdrop(ctx, scenarioGeometry(sc), bbox, BACKDROP_W, BACKDROP_H)
    return { canvas, bbox }
  }, [config])

  const scenarioName = config && config.kind === 'catalog'
    ? getScenarioById(config.scenarioId)?.label ?? config.scenarioId
    : config?.kind === 'custom' ? config.definition.name : ''

  // Sort alerting tiles to the top-left; this is what makes the wall an instrument.
  const sorted = useMemo(() => {
    return [...roster].sort((a, b) => {
      const sa = SEVERITY_RANK[frames[a.studentId] ? alertSeverity(frames[a.studentId].a) : 'none']
      const sb = SEVERITY_RANK[frames[b.studentId] ? alertSeverity(frames[b.studentId].a) : 'none']
      return sa - sb || a.displayName.localeCompare(b.displayName)
    })
  }, [roster, frames])

  const alerting = sorted.filter((r) => frames[r.studentId] && alertSeverity(frames[r.studentId].a) !== 'none')

  function focus(studentId: string) {
    focusStudent(studentId)
    setRightPane('focus')
  }

  const bbox = backdrop?.bbox ?? computeBbox([{ lat: 0, lng: 0 }])
  const bmp = backdrop?.canvas ?? null

  return (
    <div className="cls-shell">
      <header className="cls-header">
        <span style={{ fontWeight: 700 }}>⬡ Coordinator</span>
        <span className="cls-code" title="Read this code aloud">{classId}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{scenarioName}</span>
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto' }}>{roster.length} joined</span>
        <button className="cls-btn ghost" style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => setRightPane((p) => (p === 'results' ? 'focus' : 'results'))}>
          {rightPane === 'results' ? 'Show focus' : 'Show results'}
        </button>
        <button className="cls-btn ghost" style={{ padding: '4px 10px', fontSize: 12 }} onClick={closeClass}>
          End class
        </button>
      </header>

      <div className="cls-alert-strip">
        {alerting.length === 0
          ? <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>No alerts</span>
          : alerting.map((r) => {
            const sev = alertSeverity(frames[r.studentId].a)
            return (
              <span key={r.studentId} className={`cls-alert-pill ${sev}`} onClick={() => focus(r.studentId)}>
                {r.displayName}
              </span>
            )
          })}
      </div>

      <div className="cls-body">
        <div className={`cls-wall ${roster.length > 16 ? 'compact' : ''}`}>
          {sorted.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-dim)', gridColumn: '1 / -1' }}>
              Waiting for students to join with code <b>{classId}</b>…
            </div>
          )}
          {sorted.map((r) => (
            <StudentTile
              key={r.studentId}
              studentId={r.studentId}
              name={r.displayName}
              backdrop={bmp}
              bbox={bbox}
              selected={r.studentId === focusedStudentId}
              onClick={() => focus(r.studentId)}
            />
          ))}
        </div>

        <div className="cls-focus-pane">
          {rightPane === 'results'
            ? <ClassResults classId={classId ?? ''} />
            : <FocusDetail bbox={bbox} backdrop={bmp} />}
        </div>
      </div>
    </div>
  )
}

function FocusDetail({ bbox, backdrop }: { bbox: Bbox; backdrop: CanvasImageSource | null }) {
  const { focusedStudentId, focusFrame, roster } = useClassroomStore(useShallow((s) => ({
    focusedStudentId: s.focusedStudentId, focusFrame: s.focusFrame, roster: s.roster,
  })))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const name = roster.find((r) => r.studentId === focusedStudentId)?.displayName ?? ''

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const drones: GridDrone[] = (focusFrame?.drones ?? []).map((d) => ({
      id: d.id, lat: d.position.lat, lng: d.position.lng,
      headingDeg: d.headingDeg, batteryPct: d.batteryPct, stateCode: stateToCode(d.missionState),
    }))
    renderTile(ctx, backdrop, drones, bbox, BACKDROP_W, BACKDROP_H)
  }, [focusFrame, bbox, backdrop])

  if (!focusedStudentId) {
    return <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Click a tile to watch a student in full detail.</div>
  }

  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{name}</div>
      <canvas ref={canvasRef} width={BACKDROP_W} height={BACKDROP_H} style={{ width: '100%', borderRadius: 6, background: '#0a0e14' }} />
      {!focusFrame ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 8 }}>Waiting for the focus stream…</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '8px 0 4px' }}>
            T+{Math.floor(focusFrame.elapsedSec / 60)}:{String(Math.floor(focusFrame.elapsedSec % 60)).padStart(2, '0')}
            {' · '}wind {Math.round(focusFrame.weatherState.windKts)} kt
            {' · '}vis {focusFrame.weatherState.visibilityMi.toFixed(1)} mi
            {' · '}{focusFrame.thermalContacts.length} thermal
          </div>
          <table className="cls-table">
            <thead><tr><th>Drone</th><th>State</th><th>Alt</th><th>Batt</th><th>Sig</th></tr></thead>
            <tbody>
              {focusFrame.drones.map((d) => (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td>{d.missionState}</td>
                  <td>{Math.round(d.altitudeFt)}ft</td>
                  <td style={{ color: d.batteryPct < 20 ? '#ff8080' : undefined }}>{Math.round(d.batteryPct)}%</td>
                  <td>{Math.round(d.signalDbm)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}
