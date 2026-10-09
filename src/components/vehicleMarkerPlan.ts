import type { GroundUnitState, LatLng, RecoveryTeamState } from '@/types'
import {
  VEHICLE_ASPECT,
  VEHICLE_LENGTH_M,
  groundUnitVariants,
  headingAt,
  isHidden,
  markerSizePx,
  pointAtDistance,
  recoveryChipOffset,
  type RouteLike,
  type VehicleKind,
  type VehicleVariant,
} from '@/components/vehicleAvatars'
import { vehicleTitle, type VehiclePopupModel } from '@/components/vehicleMarkers'

/**
 * Pure planning for the TacticalMap vehicle layer: what to draw for the current store frame,
 * given the zoom, the map-centre latitude and a route lookup. No maplibre and no DOM, so jsdom
 * specs cover it (TacticalMap itself cannot run there). The component only diffs this output
 * against its marker refs.
 */

/** Walking pace of a recovery crew from the parked vehicle to the aircraft, m/s (sim: recoveryManager). */
const WALK_SPEED_MPS = 1.3
/** One sim tick in seconds (SimulationLoop FIXED_DT; the sim runs at 20 Hz). */
const SIM_TICK_S = 0.05
/** A crew only walks in (and a dotted line is only drawn) when the road access point is further than this. */
export const WALK_IN_MIN_M = 15

export interface VehiclePlan {
  id: string
  kind: VehicleKind
  variant: VehicleVariant
  /** Ground unit role; undefined for recovery teams. */
  role?: string
  status: string
  lng: number
  lat: number
  headingDeg: number
  lengthPx: number
  widthPx: number
  /** Inside a tunnel or covered span: opacity 0. */
  hidden: boolean
  popup: VehiclePopupModel
  /** Recovery teams only: MapLibre offset for the non-rotating chip marker. */
  chipOffset?: [number, number]
}

export interface PlanInput {
  /** The store array, unfiltered and in order (variants depend on it). */
  groundUnits: readonly GroundUnitState[]
  recoveryTeams: readonly RecoveryTeamState[]
  zoom: number
  /** Latitude the true-scale size is computed at: the map centre. */
  centerLat: number
  unitRoute(unit: GroundUnitState): RouteLike | null
  teamRoute(team: RecoveryTeamState): RouteLike | null
}

const crewOnFoot = (status: string, accessGapM: number | undefined): number | undefined =>
  status === 'on_scene' && (accessGapM ?? 0) > WALK_IN_MIN_M ? accessGapM : undefined

/**
 * Every vehicle to draw this frame, ground units first. Ground units draw while not on standby.
 * A recovery team draws only while it is road-routed, enroute or on scene, and has a route;
 * a team without road access, and an extracted one, draw nothing.
 */
export function planVehicles(input: PlanInput): VehiclePlan[] {
  const { groundUnits, recoveryTeams, zoom, centerLat } = input
  const out: VehiclePlan[] = []
  const variants = groundUnitVariants(groundUnits)

  for (const unit of groundUnits) {
    if (unit.status === 'standby') continue
    const variant = variants.get(unit.id) ?? 'truck'
    const route = input.unitRoute(unit)
    const s = unit.routeDistM ?? 0
    const at = route ? pointAtDistance(route, s) : null
    const pos = at ?? unit.position
    const size = markerSizePx(zoom, centerLat, VEHICLE_LENGTH_M[variant], VEHICLE_ASPECT[variant])
    out.push({
      id: unit.id,
      kind: 'ground',
      variant,
      role: unit.role,
      status: unit.status,
      lng: pos.lng,
      lat: pos.lat,
      headingDeg: unit.headingDeg ?? (route ? headingAt(route, s) : 0),
      lengthPx: size.lengthPx,
      widthPx: size.widthPx,
      hidden: route ? isHidden(route, s) : false,
      popup: {
        title: vehicleTitle('ground', unit.role),
        status: unit.status,
        etaSec: unit.etaSec,
        crewOnFootM: crewOnFoot(unit.status, unit.accessGapM),
        note: unit.weatherRiskNote ? `⚠ ${unit.weatherRiskNote}` : undefined,
      },
    })
  }

  for (const team of recoveryTeams) {
    if (team.roadRouted !== true || (team.status !== 'enroute' && team.status !== 'on_scene')) continue
    const route = input.teamRoute(team)
    if (!route) continue
    const s = team.routeDistM ?? 0
    const pos = pointAtDistance(route, s) ?? team.position
    const size = markerSizePx(zoom, centerLat, VEHICLE_LENGTH_M.pickup, VEHICLE_ASPECT.pickup)
    out.push({
      id: team.id,
      kind: 'recovery',
      variant: 'pickup',
      status: team.status,
      lng: pos.lng,
      lat: pos.lat,
      headingDeg: team.headingDeg ?? headingAt(route, s),
      lengthPx: size.lengthPx,
      widthPx: size.widthPx,
      hidden: isHidden(route, s),
      chipOffset: recoveryChipOffset(size.lengthPx),
      popup: {
        title: vehicleTitle('recovery', undefined),
        status: team.status,
        etaSec: team.etaSec,
        crewOnFootM: crewOnFoot(team.status, team.accessGapM),
        walkSecLeft: team.status === 'on_scene' ? team.etaSec : undefined,
        note: team.weatherRiskNote ? `⚠ ${team.weatherRiskNote}` : undefined,
      },
    })
  }
  return out
}

// ─── Lines ──────────────────────────────────────────────────────────────────────

export interface LineFeature {
  type: 'Feature'
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> }
  properties: { id: string; covered: boolean }
}

const lngLat = (p: LatLng): [number, number] => [p.lng, p.lat]

function lineFeature(id: string, covered: boolean, coordinates: Array<[number, number]>): LineFeature {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { id, covered } }
}

/**
 * The part of the route still ahead of `s` metres, as LineString features that follow the road
 * geometry exactly (the point at `s`, every later vertex, the end). Spans inside a hidden range
 * (tunnel, covered edge) are separate features with `covered: true` so they can be drawn finer.
 * Empty at or past the route end.
 */
export function remainingRouteFeatures(route: RouteLike, s: number, id: string): LineFeature[] {
  const n = Math.min(route.points.length, route.cumDistM.length)
  if (n < 2) return []
  const total = route.cumDistM[n - 1]
  const start = Number.isFinite(s) ? Math.max(0, s) : 0
  if (start >= total) return []

  const cuts = new Set<number>([start, total])
  for (let i = 0; i < n; i += 1) {
    const d = route.cumDistM[i]
    if (d > start && d < total) cuts.add(d)
  }
  for (const [from, to] of route.hiddenRanges ?? []) {
    if (from > start && from < total) cuts.add(from)
    if (to > start && to < total) cuts.add(to)
  }
  const ds = [...cuts].sort((a, b) => a - b)

  const features: LineFeature[] = []
  let current: Array<[number, number]> = []
  let covered = false
  for (let i = 0; i < ds.length - 1; i += 1) {
    const a = pointAtDistance(route, ds[i])
    const b = pointAtDistance(route, ds[i + 1])
    if (!a || !b) continue
    const spanCovered = isHidden(route, (ds[i] + ds[i + 1]) / 2)
    if (current.length > 0 && spanCovered !== covered) {
      features.push(lineFeature(id, covered, current))
      current = [current[current.length - 1]]
    }
    if (current.length === 0) current = [lngLat(a)]
    covered = spanCovered
    current.push(lngLat(b))
  }
  if (current.length >= 2) features.push(lineFeature(id, covered, current))
  return features
}

/** Where a unit's contact is, from the scenario heat sources (contacts never move). */
export function unitContactPosition(
  unit: Pick<GroundUnitState, 'targetThermalId'>,
  heatSources: ReadonlyArray<{ id: string; position: LatLng }> | undefined,
): LatLng | null {
  if (!unit.targetThermalId) return null
  return heatSources?.find((h) => h.id === unit.targetThermalId)?.position ?? null
}

/** Dotted crew-on-foot line from a parked unit to its contact, when the road ends > 15 m short. */
export function groundWalkFeatures(
  units: readonly GroundUnitState[],
  contactOf: (unit: GroundUnitState) => LatLng | null,
): LineFeature[] {
  const out: LineFeature[] = []
  for (const unit of units) {
    if (unit.status !== 'on_scene' || (unit.accessGapM ?? 0) <= WALK_IN_MIN_M) continue
    const contact = contactOf(unit)
    if (!contact) continue
    out.push(lineFeature(unit.id, false, [lngLat(unit.position), lngLat(contact)]))
  }
  return out
}

/** Total walk-in seconds for a gap and weather multiplier, as the sim counts it (ceil to 20 Hz ticks). */
export function walkSecondsTotal(accessGapM: number, groundUnitEtaMultiplier: number): number {
  return Math.ceil((accessGapM / (WALK_SPEED_MPS / groundUnitEtaMultiplier)) / SIM_TICK_S) * SIM_TICK_S
}

/**
 * The crew's remaining walk, from where they are now to the aircraft. On scene the team's `etaSec`
 * is the walk-in seconds left, so the line shrinks toward the drone as the countdown runs out.
 */
export function recoveryWalkFeatures(
  teams: readonly RecoveryTeamState[],
  accessOf: (team: RecoveryTeamState) => LatLng | null,
  groundUnitEtaMultiplier: number,
): LineFeature[] {
  const out: LineFeature[] = []
  for (const team of teams) {
    const gap = team.accessGapM ?? 0
    if (team.status !== 'on_scene' || team.roadRouted !== true || gap <= WALK_IN_MIN_M) continue
    const access = accessOf(team)
    if (!access) continue
    const total = walkSecondsTotal(gap, groundUnitEtaMultiplier)
    const left = Math.min(1, Math.max(0, total > 0 ? team.etaSec / total : 0))
    if (left <= 0) continue
    const aircraft = team.targetPosition
    const crew: LatLng = {
      lat: aircraft.lat + (access.lat - aircraft.lat) * left,
      lng: aircraft.lng + (access.lng - aircraft.lng) * left,
    }
    out.push(lineFeature(team.id, false, [lngLat(crew), lngLat(aircraft)]))
  }
  return out
}
