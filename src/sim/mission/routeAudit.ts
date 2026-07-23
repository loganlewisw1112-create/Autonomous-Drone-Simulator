import { generatePerDroneWaypoints } from '@/sim/mission/SARPlanner'
import { launchSiteForDrone, recoverySiteForDrone } from '@/sim/mission/siteAssignments'
import { haversineDistanceM, pointInPolygon } from '@/utils/geometry'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'
import { containsLatLng } from '@/sim/terrain/terrainRaster'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import type { Geofence, LatLng, ScenarioConfig, Waypoint } from '@/types'

const DEFAULT_TRACK_SPACING_FT = 50
const SEGMENT_SAMPLE_COUNT = 40
const DETOUR_BUFFER_DEG = 0.00035
const METERS_PER_FOOT = 0.3048
const STRUCTURE_EPSILON_M = 0.01

/** Minimum vertical separation above a sourced building roof. */
export const REQUIRED_STRUCTURE_CLEARANCE_FT = 20

export interface RouteAuditFinding {
  scenarioId: string
  droneId: string
  kind: 'point' | 'segment'
  waypointId?: string
  segmentId?: string
  geofenceId: string
  geofenceLabel: string
  reason: string
  altitudeFt: number
  position: LatLng
}

/**
 * Terrain/structure findings are intentionally separate from geofence RouteAuditFinding.
 * They are advisory until the operator chooses a safe route; geofence findings remain the
 * only rejection contract.
 */
export interface TerrainRouteWarning {
  scenarioId: string
  droneId: string
  kind: 'no_fixture' | 'outside_coverage' | 'ground_clearance' | 'structure_clearance'
  segmentId?: string
  position: LatLng
  /** Simulator altitude is always AGL. */
  altitudeAglFt: number
  requiredClearanceFt: number
  /** Null when no sourced surface exists at the warning location. */
  surfaceClearanceFt: number | null
  /** Structure height above bare earth, never terrain elevation. */
  structureHeightFt: number | null
  reason: string
}

export interface TerrainRouteAuditOptions {
  fromPosition?: LatLng
  /**
   * Test/integration seam. Omit to resolve the scenario fixture; pass null to explicitly model
   * missing coverage without consulting the catalog.
   */
  service?: TerrainOcclusionService | null
}

export interface AuditScenarioOptions {
  routes?: Record<string, Waypoint[]>
  includeRtb?: boolean
  startPositions?: Record<string, LatLng>
}

interface RoutePoint {
  id: string
  position: LatLng
  altitudeFt: number
}

export function droneIdForIndex(index: number): string {
  return `uav-${String(index + 1).padStart(2, '0')}`
}

export function defaultDroneStartPosition(scenario: ScenarioConfig, index: number): LatLng {
  const id = droneIdForIndex(index)
  return launchSiteForDrone(scenario, id)?.position ?? scenario.perDroneStartPositions?.[id] ?? {
    lat: scenario.startPosition.lat + index * 0.00005,
    lng: scenario.startPosition.lng + index * 0.00005,
  }
}

export function buildScenarioDroneRoutes(scenario: ScenarioConfig): Record<string, Waypoint[]> {
  const routes: Record<string, Waypoint[]> = {}

  for (let i = 0; i < scenario.droneCount; i++) {
    const id = droneIdForIndex(i)
    if (scenario.missionType === 'sar_parallel' && scenario.searchArea && scenario.searchArea.length >= 3) {
      routes[id] = generatePerDroneWaypoints(
        scenario.searchArea,
        DEFAULT_TRACK_SPACING_FT,
        i,
        scenario.droneCount,
        100 + i * 20,
      )
    } else {
      routes[id] = scenario.perDroneWaypoints?.[id] ?? scenario.waypoints
    }
  }

  return routes
}

export function buildSafeDroneRoutes(scenario: ScenarioConfig): Record<string, Waypoint[]> {
  const routes = buildScenarioDroneRoutes(scenario)
  const safeRoutes: Record<string, Waypoint[]> = {}

  for (let i = 0; i < scenario.droneCount; i++) {
    const droneId = droneIdForIndex(i)
    const start = defaultDroneStartPosition(scenario, i)
    const rechargeStations = scenario.perDroneRechargeStations?.[droneId] ?? []
    const base = recoverySiteForDrone(scenario, droneId)?.position ?? rechargeStations[rechargeStations.length - 1] ?? scenario.startPosition
    const recoveryId = `${droneId}-rtb-safe`
    const missionRoute = (routes[droneId] ?? []).filter((wp) => !wp.id.startsWith(recoveryId))
    const routeWithRecovery = [
      ...missionRoute,
      {
        id: recoveryId,
        label: 'RTB Safe Recovery',
        position: base,
        altitudeFt: 120,
        dwellTimeSec: 2,
      },
    ]
    safeRoutes[droneId] = buildSafeRouteFromWaypoints(scenario, droneId, start, routeWithRecovery)
  }

  return safeRoutes
}

export function buildSafeRouteFromWaypoints(
  scenario: ScenarioConfig,
  _droneId: string,
  start: LatLng,
  waypoints: Waypoint[],
): Waypoint[] {
  const safe: Waypoint[] = []
  let from = relocatePointOutsideGeofences(start, scenario.geofences, waypoints[0]?.altitudeFt ?? 120)

  waypoints.forEach((wp, index) => {
    const to = relocatePointOutsideGeofences(wp.position, scenario.geofences, wp.altitudeFt)
    const path = planSafePath(from, to, wp.altitudeFt, scenario.geofences)

    path.slice(1).forEach((point, pathIndex) => {
      const isFinal = pathIndex === path.length - 2
      safe.push({
        ...wp,
        id: isFinal ? wp.id : `${wp.id}-detour-${pathIndex + 1}`,
        label: isFinal ? wp.label : `${wp.label ?? wp.id} Detour ${pathIndex + 1}`,
        position: point,
      })
    })

    from = to
    if (safe.length === 0 && index === waypoints.length - 1) safe.push({ ...wp, position: to })
  })

  return safe
}

export function auditScenarioRoutes(scenario: ScenarioConfig, options: AuditScenarioOptions = {}): RouteAuditFinding[] {
  const routes = options.routes ?? buildScenarioDroneRoutes(scenario)
  const includeRtb = options.includeRtb ?? true
  const findings: RouteAuditFinding[] = []

  for (let i = 0; i < scenario.droneCount; i++) {
    const droneId = droneIdForIndex(i)
    const start = options.startPositions?.[droneId] ?? defaultDroneStartPosition(scenario, i)
    const rechargeStations = scenario.perDroneRechargeStations?.[droneId] ?? []
    const base = recoverySiteForDrone(scenario, droneId)?.position ?? rechargeStations[rechargeStations.length - 1] ?? scenario.startPosition
    const route = routes[droneId] ?? []
    const points: RoutePoint[] = [
      { id: 'start', position: start, altitudeFt: route[0]?.altitudeFt ?? 120 },
      ...route.map((wp) => ({ id: wp.id, position: wp.position, altitudeFt: wp.altitudeFt })),
    ]

    if (includeRtb) {
      points.push({ id: 'rtb-base', position: base, altitudeFt: 120 })
    }

    auditRoutePoints(scenario, droneId, points, findings)

    if (rechargeStations.length > 0) {
      const stationPoints: Waypoint[] = rechargeStations.map((position, index) => ({
        id: `recharge-station-${index + 1}`,
        label: `Recharge Station ${index + 1}`,
        position,
        altitudeFt: 120,
      }))
      auditRoutePoints(scenario, droneId, stationPoints, findings, false)
      auditRoutePoints(scenario, droneId, [
        { id: 'start', position: start, altitudeFt: stationPoints[0]?.altitudeFt ?? 120 },
        ...buildSafeRouteFromWaypoints(scenario, droneId, start, stationPoints).map((wp) => ({
          id: wp.id,
          position: wp.position,
          altitudeFt: wp.altitudeFt,
        })),
      ], findings)
    }
  }

  return dedupeFindings(findings)
}

/**
 * Audit an operator route against sourced terrain coverage and discrete building surfaces.
 *
 * Segment samples are spaced at the raster's native resolution. At every sample aircraft MSL
 * is recomputed as local bare-ground MSL + authored AGL, so climbing terrain cannot create a
 * false low-clearance warning. Only a surface measurably above bare ground is considered a
 * structure.
 */
export function auditTerrainClearance(
  scenarioId: string,
  droneId: string,
  route: readonly Waypoint[],
  options: TerrainRouteAuditOptions = {},
): TerrainRouteWarning[] {
  if (route.length === 0) return []
  const service = options.service === undefined
    ? occlusionServiceFor(scenarioId)
    : options.service ?? undefined
  const startPosition = options.fromPosition ?? route[0].position
  const firstAltitude = route[0].altitudeFt

  if (!service) {
    return [{
      scenarioId,
      droneId,
      kind: 'no_fixture',
      position: startPosition,
      altitudeAglFt: firstAltitude,
      requiredClearanceFt: REQUIRED_STRUCTURE_CLEARANCE_FT,
      surfaceClearanceFt: null,
      structureHeightFt: null,
      reason: 'No sourced terrain/building fixture is available for this scenario',
    }]
  }

  const points: RoutePoint[] = [
    { id: 'start', position: startPosition, altitudeFt: firstAltitude },
    ...route.map((waypoint) => ({
      id: waypoint.id,
      position: waypoint.position,
      altitudeFt: waypoint.altitudeFt,
    })),
  ]
  const warnings: TerrainRouteWarning[] = []

  for (let pointIndex = 0; pointIndex < points.length - 1; pointIndex++) {
    const from = points[pointIndex]
    const to = points[pointIndex + 1]
    const segmentId = from.id + '->' + to.id
    const distanceM = haversineDistanceM(from.position, to.position)
    const sampleCount = Math.max(1, Math.ceil(distanceM / service.raster.metersPerPixel))
    let outside: TerrainRouteWarning | null = null
    let clearance: TerrainRouteWarning | null = null

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex++) {
      const t = sampleIndex / sampleCount
      const position = {
        lat: from.position.lat + (to.position.lat - from.position.lat) * t,
        lng: from.position.lng + (to.position.lng - from.position.lng) * t,
      }
      const altitudeAglFt = from.altitudeFt + (to.altitudeFt - from.altitudeFt) * t

      if (!containsLatLng(service.raster, position.lat, position.lng)) {
        outside ??= {
          scenarioId,
          droneId,
          kind: 'outside_coverage',
          segmentId,
          position,
          altitudeAglFt,
          requiredClearanceFt: REQUIRED_STRUCTURE_CLEARANCE_FT,
          surfaceClearanceFt: null,
          structureHeightFt: null,
          reason: 'Route leaves the sourced terrain/building coverage area',
        }
        continue
      }

      const groundMslM = service.groundElevation(position.lat, position.lng)
      const surfaceMslM = service.surfaceHeight(position.lat, position.lng)
      const structureHeightM = Math.max(0, surfaceMslM - groundMslM)
      const structureHeightFt = structureHeightM / METERS_PER_FOOT
      const surfaceClearanceFt = altitudeAglFt - structureHeightFt
      if (surfaceClearanceFt >= REQUIRED_STRUCTURE_CLEARANCE_FT) continue
      if (clearance && surfaceClearanceFt >= (clearance.surfaceClearanceFt ?? Infinity)) continue
      const isStructure = structureHeightM > STRUCTURE_EPSILON_M
      clearance = {
        scenarioId,
        droneId,
        kind: isStructure ? 'structure_clearance' : 'ground_clearance',
        segmentId,
        position,
        altitudeAglFt,
        requiredClearanceFt: REQUIRED_STRUCTURE_CLEARANCE_FT,
        surfaceClearanceFt,
        structureHeightFt,
        reason: (isStructure ? 'Structure' : 'Ground') + ' clearance is '
          + surfaceClearanceFt.toFixed(1)
          + 'ft; '
          + REQUIRED_STRUCTURE_CLEARANCE_FT
          + 'ft required',
      }
    }

    if (outside) warnings.push(outside)
    if (clearance) warnings.push(clearance)
  }

  return warnings
}

function auditRoutePoints(
  scenario: ScenarioConfig,
  droneId: string,
  points: RoutePoint[],
  findings: RouteAuditFinding[],
  includeSegments = true,
): void {
  points.forEach((point) => {
    const breach = firstBreachedGeofence(point.position, point.altitudeFt, scenario.geofences)
    if (!breach) return
    findings.push({
      scenarioId: scenario.id,
      droneId,
      kind: 'point',
      waypointId: point.id,
      geofenceId: breach.id,
      geofenceLabel: breach.label,
      reason: pointReason(breach, point.altitudeFt),
      altitudeFt: point.altitudeFt,
      position: point.position,
    })
  })

  if (!includeSegments) return

  for (let p = 0; p < points.length - 1; p++) {
    const from = points[p]
    const to = points[p + 1]
    const altitudeFt = to.altitudeFt
    const segmentId = `${from.id}->${to.id}`
    const sample = firstBreachingSample(from.position, to.position, altitudeFt, scenario.geofences)
    if (!sample) continue
    findings.push({
      scenarioId: scenario.id,
      droneId,
      kind: 'segment',
      segmentId,
      geofenceId: sample.geofence.id,
      geofenceLabel: sample.geofence.label,
      reason: `route segment intersects ${sample.geofence.label}`,
      altitudeFt,
      position: sample.position,
    })
  }
}

export function firstBreachedGeofence(
  point: LatLng,
  altitudeFt: number,
  geofences: Geofence[],
): Geofence | undefined {
  return geofences.find((gf) => isGeofenceActiveAtAltitude(gf, altitudeFt) && pointInPolygon(point, gf.polygon))
}

export function relocatePointOutsideGeofences(point: LatLng, geofences: Geofence[], altitudeFt: number): LatLng {
  let current = point
  for (let i = 0; i < 6; i++) {
    const breach = firstBreachedGeofence(current, altitudeFt, geofences)
    if (!breach) return current

    const bbox = boundingBox(breach.polygon)
    const candidates: LatLng[] = [
      { lat: clamp(current.lat, bbox.minLat, bbox.maxLat), lng: bbox.minLng - DETOUR_BUFFER_DEG },
      { lat: clamp(current.lat, bbox.minLat, bbox.maxLat), lng: bbox.maxLng + DETOUR_BUFFER_DEG },
      { lat: bbox.minLat - DETOUR_BUFFER_DEG, lng: clamp(current.lng, bbox.minLng, bbox.maxLng) },
      { lat: bbox.maxLat + DETOUR_BUFFER_DEG, lng: clamp(current.lng, bbox.minLng, bbox.maxLng) },
    ]
      .map((candidate) => nudge(candidate))
      .filter((candidate) => !firstBreachedGeofence(candidate, altitudeFt, geofences))

    if (candidates.length === 0) return current
    current = candidates.sort((a, b) => haversineDistanceM(point, a) - haversineDistanceM(point, b))[0]
  }
  return current
}

export function planSafePath(from: LatLng, to: LatLng, altitudeFt: number, geofences: Geofence[]): LatLng[] {
  const safeFrom = relocatePointOutsideGeofences(from, geofences, altitudeFt)
  const safeTo = relocatePointOutsideGeofences(to, geofences, altitudeFt)
  if (isSegmentClear(safeFrom, safeTo, altitudeFt, geofences)) return [safeFrom, safeTo]

  const active = geofences.filter((gf) => isGeofenceActiveAtAltitude(gf, altitudeFt))
  const nodes = [safeFrom, safeTo, ...active.flatMap((gf) => bufferedPerimeterNodes(gf))]
    .filter((point) => !firstBreachedGeofence(point, altitudeFt, geofences))

  const startIdx = 0
  const endIdx = 1
  const dist = new Array(nodes.length).fill(Infinity)
  const prev = new Array<number | null>(nodes.length).fill(null)
  const used = new Array(nodes.length).fill(false)
  dist[startIdx] = 0

  for (let step = 0; step < nodes.length; step++) {
    let current = -1
    for (let i = 0; i < nodes.length; i++) {
      if (!used[i] && (current === -1 || dist[i] < dist[current])) current = i
    }
    if (current === -1 || dist[current] === Infinity) break
    if (current === endIdx) break
    used[current] = true

    for (let next = 0; next < nodes.length; next++) {
      if (next === current || used[next]) continue
      if (!isSegmentClear(nodes[current], nodes[next], altitudeFt, geofences)) continue
      const candidate = dist[current] + haversineDistanceM(nodes[current], nodes[next])
      if (candidate < dist[next]) {
        dist[next] = candidate
        prev[next] = current
      }
    }
  }

  if (dist[endIdx] === Infinity) return [safeFrom, safeTo]

  const path: LatLng[] = []
  for (let at: number | null = endIdx; at !== null; at = prev[at]) {
    path.push(nodes[at])
  }
  return path.reverse()
}

function firstBreachingSample(from: LatLng, to: LatLng, altitudeFt: number, geofences: Geofence[]) {
  for (let i = 0; i <= SEGMENT_SAMPLE_COUNT; i++) {
    const t = i / SEGMENT_SAMPLE_COUNT
    const position = {
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    }
    const geofence = firstBreachedGeofence(position, altitudeFt, geofences)
    if (geofence) return { position, geofence }
  }
  return null
}

function isSegmentClear(from: LatLng, to: LatLng, altitudeFt: number, geofences: Geofence[]): boolean {
  return firstBreachingSample(from, to, altitudeFt, geofences) === null
}

function isGeofenceActiveAtAltitude(geofence: Geofence, altitudeFt: number): boolean {
  if (geofence.bypassForMission) return false
  if (geofence.type === 'restricted') return altitudeFt <= geofence.maxAltitudeFt
  return true
}

function bufferedPerimeterNodes(geofence: Geofence): LatLng[] {
  const b = boundingBox(geofence.polygon)
  const midLat = (b.minLat + b.maxLat) / 2
  const midLng = (b.minLng + b.maxLng) / 2
  return [
    { lat: b.minLat - DETOUR_BUFFER_DEG, lng: b.minLng - DETOUR_BUFFER_DEG },
    { lat: b.minLat - DETOUR_BUFFER_DEG, lng: midLng },
    { lat: b.minLat - DETOUR_BUFFER_DEG, lng: b.maxLng + DETOUR_BUFFER_DEG },
    { lat: midLat, lng: b.maxLng + DETOUR_BUFFER_DEG },
    { lat: b.maxLat + DETOUR_BUFFER_DEG, lng: b.maxLng + DETOUR_BUFFER_DEG },
    { lat: b.maxLat + DETOUR_BUFFER_DEG, lng: midLng },
    { lat: b.maxLat + DETOUR_BUFFER_DEG, lng: b.minLng - DETOUR_BUFFER_DEG },
    { lat: midLat, lng: b.minLng - DETOUR_BUFFER_DEG },
  ].map((point) => nudge(point))
}

function boundingBox(polygon: LatLng[]) {
  return {
    minLat: Math.min(...polygon.map((p) => p.lat)),
    maxLat: Math.max(...polygon.map((p) => p.lat)),
    minLng: Math.min(...polygon.map((p) => p.lng)),
    maxLng: Math.max(...polygon.map((p) => p.lng)),
  }
}

function pointReason(geofence: Geofence, altitudeFt: number): string {
  if (geofence.type === 'no_fly') return `${geofence.label} is no-fly`
  return `${geofence.label} restricted at or below ${geofence.maxAltitudeFt}ft; route is ${altitudeFt}ft`
}

function dedupeFindings(findings: RouteAuditFinding[]): RouteAuditFinding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = [
      finding.scenarioId,
      finding.droneId,
      finding.kind,
      finding.waypointId ?? finding.segmentId,
      finding.geofenceId,
    ].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function nudge(point: LatLng): LatLng {
  return {
    lat: Number(point.lat.toFixed(7)),
    lng: Number(point.lng.toFixed(7)),
  }
}


