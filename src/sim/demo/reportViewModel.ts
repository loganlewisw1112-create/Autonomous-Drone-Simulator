/**
 * Pure view model for the readable after-action report (demo blocker c5a).
 *
 * Everything here is deterministic: the timestamp is injected via `ReportSource.generatedAtIso`
 * and nothing reads the clock, the store or the DOM. The in-app view (AfterActionReport.tsx) and the
 * offline HTML export (reportHtml.ts, c5b) both render THIS object, so the two can never drift.
 *
 * `scores` is deliberately a typed slot (`scores.mission`) so a future grade can be added as a
 * sibling without reshaping anything; today it carries mission objectives only.
 */
import { buildMissionProgress } from '@/sim/mission/missionObjectives'
import type {
  AfterActionPackage,
  DroneState,
  EventType,
  LatLng,
  MissionEvent,
  ScenarioConfig,
  ScenarioVariantConfig,
  ThermalContactState,
} from '@/types'

// ─── Source ──────────────────────────────────────────────────────────────────────

export interface ReportVehicleTrack {
  id: string
  kind: 'ground' | 'recovery'
  points: LatLng[]
  /** Set when the vehicle stopped short of its target and the last leg is on foot. */
  onFootTo?: LatLng
}

export interface ReportChainSource {
  verified: boolean
  eventCount: number
  headHash: string
  failureIndex?: number
}

export interface ReportSource {
  scenario: ScenarioConfig
  scenarioVariant: ScenarioVariantConfig
  events: MissionEvent[]
  finalDrones: DroneState[]
  positionHistory: Record<string, LatLng[]>
  thermalContacts: ThermalContactState[]
  package: AfterActionPackage
  /** Injected, never read from the clock. */
  generatedAtIso: string
  chain: ReportChainSource
  vehicleTracks?: ReportVehicleTrack[]
}

// ─── Output ──────────────────────────────────────────────────────────────────────

export interface ReportSummary {
  title: string
  scenarioName: string
  scenarioId: string
  dateIso: string
  dateLabel: string
  durationSec: number
  durationLabel: string
  droneCount: number
  headline: string
}

export interface ReportTimelineRow {
  id: string
  tSec: number
  timeLabel: string
  eventType: EventType
  label: string
  /** >1 when consecutive identical events were collapsed into one row. */
  count: number
  droneId: string
}

export interface ReportTimeline {
  rows: ReportTimelineRow[]
  /** Raw report-relevant events before collapsing. */
  relevantEventCount: number
  /** Rows dropped to respect the row cap (lowest-priority first). */
  omittedRows: number
}

export interface ReportMapPoint { x: number; y: number }

export interface ReportMapTrack {
  id: string
  label: string
  kind: 'ground' | 'recovery'
  color: string
  points: ReportMapPoint[]
  onFoot: { from: ReportMapPoint; to: ReportMapPoint } | null
}

export interface ReportLegendEntry {
  key: string
  label: string
  color: string
  style: 'solid' | 'dashed' | 'dotted' | 'fill' | 'dot'
}

export interface ReportMap {
  width: number
  height: number
  empty: boolean
  searchArea: ReportMapPoint[]
  geofences: Array<{ id: string; label: string; kind: 'no_fly' | 'restricted'; points: ReportMapPoint[] }>
  base: ReportMapPoint | null
  contacts: Array<{ id: string; label: string; x: number; y: number; resolved: boolean }>
  routes: Array<{ id: string; label: string; color: string; points: ReportMapPoint[] }>
  tracks: ReportMapTrack[]
  legend: ReportLegendEntry[]
}

export interface ReportObjectiveScore {
  id: string
  kind: string
  label: string
  /** Rounded 0-100. */
  percent: number
  completed: number
  total: number
  /** Ready-to-print detail, e.g. "2 of 3" or "POD 62% of 80% target". */
  detail: string
}

export interface ReportScores {
  mission: {
    percent: number
    objectives: ReportObjectiveScore[]
  }
}

export interface ReportChain {
  status: 'verified' | 'failed' | 'no-events'
  verified: boolean
  label: string
  eventCount: number
  headHash: string
  failureIndex: number | null
}

export interface ReportViewModel {
  generatedAtIso: string
  summary: ReportSummary
  timeline: ReportTimeline
  map: ReportMap
  scores: ReportScores
  chain: ReportChain
}

export const REPORT_SECTION_ORDER = ['summary', 'timeline', 'map', 'scores', 'chain'] as const
export const MAX_TIMELINE_ROWS = 30
export const RECOVERY_TRACK_COLOR = '#ff88ff'
export const GROUND_TRACK_COLOR = '#ffaa00'
const FALLBACK_COLOR = '#00d4ff'
const MAX_ROUTE_POINTS = 400

// ─── Projection ──────────────────────────────────────────────────────────────────

export interface SvgProjection {
  width: number
  height: number
  project: (p: LatLng) => ReportMapPoint
}

export interface ProjectOptions {
  maxWidth?: number
  maxHeight?: number
  padding?: number
  minSide?: number
}

function isFinitePoint(p: LatLng | undefined | null): p is LatLng {
  return !!p && Number.isFinite(p.lat) && Number.isFinite(p.lng)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Equirectangular projection with cos(lat0) longitude scaling, ONE uniform scale for both axes
 * (so shapes keep their aspect ratio), padding on every side and y flipped (north is up).
 * The canvas is sized to the data (capped by maxWidth/maxHeight, floored by minSide) and the
 * data is centred in it. Empty input and single points are handled: both centre in a default canvas.
 */
export function projectToSvg(points: readonly LatLng[], options: ProjectOptions = {}): SvgProjection {
  const maxW = options.maxWidth ?? 800
  const maxH = options.maxHeight ?? 520
  const pad = options.padding ?? 28
  const minSide = options.minSide ?? 160
  const pts = points.filter(isFinitePoint)

  if (pts.length === 0) {
    return { width: maxW, height: maxH, project: () => ({ x: round1(maxW / 2), y: round1(maxH / 2) }) }
  }

  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const spanX = (maxLng - minLng) * kx
  const spanY = maxLat - minLat

  const innerW = maxW - 2 * pad
  const innerH = maxH - 2 * pad
  let scale: number
  if (spanX <= 1e-12 && spanY <= 1e-12) scale = 0
  else if (spanX <= 1e-12) scale = innerH / spanY
  else if (spanY <= 1e-12) scale = innerW / spanX
  else scale = Math.min(innerW / spanX, innerH / spanY)

  const width = scale === 0 ? maxW : Math.min(maxW, Math.max(minSide, spanX * scale + 2 * pad))
  const height = scale === 0 ? maxH : Math.min(maxH, Math.max(minSide, spanY * scale + 2 * pad))
  const offX = (width - spanX * scale) / 2
  const offY = (height - spanY * scale) / 2

  return {
    width: round1(width),
    height: round1(height),
    project(p: LatLng): ReportMapPoint {
      if (scale === 0 || !isFinitePoint(p)) return { x: round1(width / 2), y: round1(height / 2) }
      return {
        x: round1(offX + (p.lng - minLng) * kx * scale),
        y: round1(height - (offY + (p.lat - minLat) * scale)),
      }
    },
  }
}

// ─── Timeline ────────────────────────────────────────────────────────────────────

const TIMELINE_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'mission_start', 'preflight_complete', 'authorization_complete', 'sortie_launch', 'thermal_detection',
  'operator_command', 'ground_unit_dispatched', 'ground_unit_on_scene', 'drone_recovery_requested',
  'geofence_breach', 'comms_lost', 'comms_restored', 'low_battery', 'rtb_triggered', 'emergency_land',
  'weather_divert', 'conflict_detected', 'drone_recovered', 'mission_abort', 'mission_complete', 'debug_override',
])

// Lower number = kept first when the row cap bites.
const TIMELINE_PRIORITY: Partial<Record<EventType, number>> = {
  mission_start: 0, mission_complete: 0, mission_abort: 0, debug_override: 0,
  emergency_land: 1, geofence_breach: 1, comms_lost: 1, low_battery: 1, rtb_triggered: 1, weather_divert: 1,
  drone_recovery_requested: 1, drone_recovered: 1, thermal_detection: 1,
  ground_unit_dispatched: 2, ground_unit_on_scene: 2, comms_restored: 2, conflict_detected: 2,
  sortie_launch: 3, authorization_complete: 3, preflight_complete: 3,
  operator_command: 4,
}

function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  return `T+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(totalSec) ? totalSec : 0))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// buildMissionStatusFeed (dispatchFeed.ts) was checked for reuse: it phrases long operator prose,
// dedupes and caps at 32 entries, and has no cases for the recovery or ground-unit events, so these
// short per-event labels are new rather than borrowed.
function eventLabel(e: MissionEvent, uav: (id: string) => string): string {
  const who = uav(e.droneId)
  switch (e.eventType) {
    case 'mission_start': return 'Mission started'
    case 'preflight_complete': return 'Preflight complete'
    case 'authorization_complete': return 'Authorization complete'
    case 'sortie_launch': return `${who} launched`
    case 'thermal_detection': {
      const cls = str(e.payload.class)
      return cls ? `${who} thermal contact: ${cls}` : `${who} thermal contact`
    }
    case 'operator_command': {
      const command = str(e.payload.command)
      if (command === 'abort_recovery') return `Operator aborted recovery of ${who}`
      return command ? `Operator command: ${command.replace(/_/g, ' ')} (${who})` : `Operator command (${who})`
    }
    case 'ground_unit_dispatched': return 'Ground unit dispatched'
    case 'ground_unit_on_scene':
      return str(e.payload.teamId) ? `Recovery team on scene at ${who}` : 'Ground unit on scene'
    case 'drone_recovery_requested':
      return e.payload.roadAccess === 'none'
        ? `${who} down: recovery team dispatched (no road data)`
        : `${who} down: recovery team dispatched`
    case 'drone_recovered': return `${who} recovered`
    case 'geofence_breach': return `${who} geofence breach`
    case 'comms_lost': return `${who} link lost`
    case 'comms_restored': return `${who} link restored`
    case 'low_battery': return `${who} low battery`
    case 'rtb_triggered': return `${who} returning to base`
    case 'emergency_land': return `${who} emergency landing`
    case 'weather_divert': return `${who} diverting for weather`
    case 'conflict_detected': return `${who} traffic conflict`
    case 'mission_abort': return 'Mission aborted'
    case 'mission_complete': return 'Mission complete'
    default: return e.eventType.replace(/_/g, ' ')
  }
}

function buildTimeline(events: readonly MissionEvent[], drones: readonly DroneState[]): ReportTimeline {
  const uav = (id: string) => drones.find((d) => d.id === id)?.label ?? id.toUpperCase()
  const relevant = events.filter((e) => TIMELINE_TYPES.has(e.eventType))
  const collapsed: ReportTimelineRow[] = []
  for (const e of relevant) {
    const label = eventLabel(e, uav)
    const tSec = Math.round(e.tick * 0.05)
    const prev = collapsed.at(-1)
    if (prev && prev.eventType === e.eventType && prev.label === label) {
      prev.count += 1
      continue
    }
    collapsed.push({ id: `t${collapsed.length}`, tSec, timeLabel: formatClock(tSec), eventType: e.eventType, label, count: 1, droneId: e.droneId })
  }
  if (collapsed.length <= MAX_TIMELINE_ROWS) {
    return { rows: collapsed, relevantEventCount: relevant.length, omittedRows: 0 }
  }
  const keep = collapsed
    .map((row, index) => ({ row, index, rank: TIMELINE_PRIORITY[row.eventType] ?? 5 }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, MAX_TIMELINE_ROWS)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.row)
  return { rows: keep, relevantEventCount: relevant.length, omittedRows: collapsed.length - keep.length }
}

// ─── Map ─────────────────────────────────────────────────────────────────────────

function safeColor(color: string | undefined): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : FALLBACK_COLOR
}

function decimate<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items]
  const stride = (items.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) out.push(items[Math.round(i * stride)])
  return out
}

function buildMap(source: ReportSource): ReportMap {
  const { scenario, finalDrones, positionHistory, thermalContacts } = source
  const vehicleTracks = (source.vehicleTracks ?? [])
    .map((t) => ({ ...t, points: t.points.filter(isFinitePoint), onFootTo: isFinitePoint(t.onFootTo) ? t.onFootTo : undefined }))
    .filter((t) => t.points.length > 0)

  const searchArea = (scenario.searchArea ?? []).filter(isFinitePoint)
  const geofences = scenario.geofences
    .map((g) => ({ ...g, polygon: g.polygon.filter(isFinitePoint) }))
    .filter((g) => g.polygon.length > 0)
  const base = isFinitePoint(scenario.startPosition) ? scenario.startPosition : null
  const contacts = thermalContacts.filter((c) => isFinitePoint(c.position))
  const droneIds = Array.from(new Set([...finalDrones.map((d) => d.id), ...Object.keys(positionHistory)]))
  const routes = droneIds
    .map((id) => {
      const drone = finalDrones.find((d) => d.id === id)
      let pts = (positionHistory[id] ?? []).filter(isFinitePoint)
      if (pts.length === 0 && drone && isFinitePoint(drone.position)) pts = [drone.position]
      return { id, drone, pts: decimate(pts, MAX_ROUTE_POINTS) }
    })
    .filter((r) => r.pts.length > 0)

  const all: LatLng[] = [
    ...searchArea,
    ...geofences.flatMap((g) => g.polygon),
    ...(base ? [base] : []),
    ...contacts.map((c) => c.position),
    ...routes.flatMap((r) => r.pts),
    ...vehicleTracks.flatMap((t) => [...t.points, ...(t.onFootTo ? [t.onFootTo] : [])]),
  ]
  const proj = projectToSvg(all)
  const pp = (p: LatLng) => proj.project(p)

  const tracks: ReportMapTrack[] = vehicleTracks.map((t) => ({
    id: t.id,
    label: t.kind === 'recovery' ? `Recovery team ${t.id}` : `Ground unit ${t.id}`,
    kind: t.kind,
    color: t.kind === 'recovery' ? RECOVERY_TRACK_COLOR : GROUND_TRACK_COLOR,
    points: decimate(t.points, MAX_ROUTE_POINTS).map(pp),
    onFoot: t.onFootTo ? { from: pp(t.points[t.points.length - 1]), to: pp(t.onFootTo) } : null,
  }))

  const legend: ReportLegendEntry[] = []
  for (const r of routes) {
    legend.push({ key: `route-${r.id}`, label: `${r.drone?.label ?? r.id.toUpperCase()} track`, color: safeColor(r.drone?.color), style: 'solid' })
  }
  if (searchArea.length >= 3) legend.push({ key: 'search', label: 'Search area', color: '#58a6ff', style: 'fill' })
  if (geofences.some((g) => g.type === 'no_fly')) legend.push({ key: 'nofly', label: 'No-fly zone', color: '#ff5555', style: 'fill' })
  if (geofences.some((g) => g.type === 'restricted')) legend.push({ key: 'restricted', label: 'Restricted zone', color: '#ffaa00', style: 'fill' })
  if (base) legend.push({ key: 'base', label: 'Launch base', color: '#3fb950', style: 'dot' })
  if (contacts.length > 0) legend.push({ key: 'contact', label: 'Thermal contact', color: '#ff7b54', style: 'dot' })
  if (tracks.some((t) => t.kind === 'recovery')) legend.push({ key: 'recovery-track', label: 'Recovery team route', color: RECOVERY_TRACK_COLOR, style: 'dashed' })
  if (tracks.some((t) => t.kind === 'ground')) legend.push({ key: 'ground-track', label: 'Ground unit route', color: GROUND_TRACK_COLOR, style: 'dashed' })
  if (tracks.some((t) => t.onFoot)) legend.push({ key: 'on-foot', label: 'Last leg on foot', color: '#c9d1d9', style: 'dotted' })

  return {
    width: proj.width,
    height: proj.height,
    empty: all.length === 0,
    searchArea: searchArea.map(pp),
    geofences: geofences.map((g) => ({ id: g.id, label: g.label, kind: g.type, points: g.polygon.map(pp) })),
    base: base ? pp(base) : null,
    contacts: contacts.map((c) => {
      const p = pp(c.position)
      return { id: c.sourceId, label: String(c.class), x: p.x, y: p.y, resolved: c.action !== undefined }
    }),
    routes: routes.map((r) => ({ id: r.id, label: r.drone?.label ?? r.id.toUpperCase(), color: safeColor(r.drone?.color), points: r.pts.map(pp) })),
    tracks,
    legend,
  }
}

// ─── Scores / chain / summary ────────────────────────────────────────────────────

function finiteOr0(n: number): number {
  return Number.isFinite(n) ? n : 0
}

function buildScores(source: ReportSource): ReportScores {
  const progress = buildMissionProgress({
    scenario: source.scenario,
    drones: source.finalDrones,
    thermalContacts: source.thermalContacts,
    events: source.events,
    positionHistory: source.positionHistory,
    elapsedSec: source.package.outcome.missionTimeSec,
  })
  const pct = (n: number) => `${Math.round(finiteOr0(n) * 100)}%`
  return {
    mission: {
      percent: finiteOr0(progress.percent),
      objectives: progress.objectives.map((o) => ({
        id: o.id,
        kind: o.kind,
        label: o.label,
        percent: Math.round(finiteOr0(o.completion) * 100),
        completed: finiteOr0(o.completed),
        total: finiteOr0(o.total),
        detail: o.kind === 'sector_coverage'
          ? `POD ${pct(o.completed)} of ${pct(o.total)} target`
          : `${finiteOr0(o.completed)} of ${finiteOr0(o.total)}`,
      })),
    },
  }
}

function buildChain(chain: ReportChainSource): ReportChain {
  const status: ReportChain['status'] = chain.eventCount === 0 ? 'no-events' : chain.verified ? 'verified' : 'failed'
  return {
    status,
    verified: status === 'verified',
    label: status === 'verified' ? 'VERIFIED' : status === 'failed' ? 'FAIL' : 'NO EVENTS RECORDED',
    eventCount: chain.eventCount,
    headHash: chain.headHash,
    failureIndex: status === 'failed' && typeof chain.failureIndex === 'number' ? chain.failureIndex : null,
  }
}

function dateLabel(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : iso
}

export function buildReportViewModel(source: ReportSource): ReportViewModel {
  const { package: pkg } = source
  return {
    generatedAtIso: source.generatedAtIso,
    summary: {
      title: pkg.missionReport.title,
      scenarioName: pkg.scenarioName,
      scenarioId: pkg.scenarioId,
      dateIso: source.generatedAtIso,
      dateLabel: dateLabel(source.generatedAtIso),
      durationSec: pkg.outcome.missionTimeSec,
      durationLabel: formatDuration(pkg.outcome.missionTimeSec),
      droneCount: source.finalDrones.length,
      headline: pkg.outcome.headline,
    },
    timeline: buildTimeline(source.events, source.finalDrones),
    map: buildMap(source),
    scores: buildScores(source),
    chain: buildChain(source.chain),
  }
}
