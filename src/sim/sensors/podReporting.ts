import { platformForDrone } from '@/sim/drone/platformCatalog'
import { cumulativePod, probabilityOfDetection, sweepWidthM } from '@/sim/sensors/sweepWidth'
import { effectiveDetectionRangeM, thermalTransmission, type ThermalWeather } from '@/sim/sensors/thermalRange'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import type { DroneState, LatLng, ScenarioConfig } from '@/types'
import { bearingDeg, haversineDistanceM, offsetLatLng, pointInPolygon } from '@/utils/geometry'

// SAR probability of detection, reported (REALISM_ROADMAP WP-6).
//
// `sweepWidth.ts` holds the maths; this file is the read-model that feeds it real mission data
// and is what the READY tab renders. It closes the chain the roadmap specifies:
//
//   R_d (WP-5 Johnson range, after atmosphere)  →  W = 1.645·R_d  →  coverage  →  POD
//
// DETERMINISM (§3). This is a *derived* quantity, computed on demand from state the sim already
// records (`positionHistory`, drones, scenario, weather). It is deliberately NOT accumulated on
// the sim tick and stores nothing of its own, so WP-6 adds exactly zero new state to the
// simulation kernel and cannot perturb replay. Every function here is pure.
//
// THE THING THIS FILE REFUSES TO DO. A detection radius is only ever taken from published optics
// via `effectiveDetectionRangeM`. Where a platform's focal length or NETD is unpublished, R_d is
// `null` and the sweep is reported UNSOURCED — it is not given a plausible-looking default and it
// is not folded into the cumulative figure. An invented R_d would propagate through W, coverage
// and POD and come out the far end looking exactly like a measured number, which is the one
// failure mode a POD report cannot survive. (The pre-WP-6 `sector_coverage` objective did fall
// back to a flat 60 m; that fallback is removed, and `podReporting.spec.ts` pins it staying gone.)

/** Person-sized target: the critical dimension SAR sweep width is defined against (§18.1/§18.2). */
export const SAR_TARGET_SIZE_M = 0.5

/**
 * Ceiling on LOS probes per sweep. The swath-visibility term is a sampled estimate, and its cost
 * is what would otherwise make POD too expensive to recompute on a panel render. 24 probe pairs
 * resolve the terrain features a sweep actually crosses while keeping a full fleet report well
 * inside one frame.
 */
const MAX_LOS_SAMPLES = 24

const FT_TO_M = 0.3048

/** Why a sweep has no POD, when it has none. Drives the READY-tab wording. */
export type SweepStatus =
  /** Sourced optics, effort flown, POD is a real number. */
  | 'ok'
  /** Optics or NETD unpublished — R_d cannot be computed and is not invented. */
  | 'unsourced'
  /** Sourced optics, but the drone never flew inside the sector. */
  | 'no_effort'
  /** Effort flown, but terrain/structures blocked the swath for the whole sweep. */
  | 'no_los'

export interface SectorSweep {
  droneId: string
  label: string
  platformName: string
  /** Johnson detection range after atmospheric transmission (m). Null when unpublished. */
  detectionRadiusM: number | null
  /** W = 1.645 · R_d (m). 0 when R_d is unsourced. */
  sweepWidthM: number
  /** Track flown inside the sector polygon (m), before the swath-visibility credit. */
  trackLengthM: number
  /** Fraction of the swath with clear LOS to ground; 1 when no terrain fixture is loaded. */
  losFraction: number
  /** trackLengthM × losFraction — the effort that actually swept visible ground. */
  effectiveEffortM: number
  coverage: number
  /** Null exactly when `status` is 'unsourced'. 0 is a real answer; null is "cannot say". */
  pod: number | null
  status: SweepStatus
}

export interface SectorPodReport {
  /** Sector area (m²). 0 when the scenario authors no search area. */
  sectorAreaM2: number
  /** One entry per drone, ordered by drone id for a stable render. */
  sweeps: SectorSweep[]
  /** 1 − Π(1 − POD_i) over sourced sweeps only. Null when no sweep is sourced. */
  cumulativePod: number | null
  /** True when the scenario has a search area and at least one sweep has sourced optics. */
  supported: boolean
  /** Platforms excluded from the cumulative figure for want of published optics. */
  unsourcedPlatforms: string[]
}

export interface SectorPodInput {
  scenario: ScenarioConfig | null
  drones: readonly DroneState[]
  positionHistory: Readonly<Record<string, readonly LatLng[]>>
  weather?: ThermalWeather | null
  /** Terrain/building occlusion. Omitted ⇒ swath assumed visible (losFraction 1). */
  occlusion?: OcclusionService
}

const EMPTY_REPORT: SectorPodReport = {
  sectorAreaM2: 0,
  sweeps: [],
  cumulativePod: null,
  supported: false,
  unsourcedPlatforms: [],
}

/**
 * Per-sector and cumulative POD for the scenario's search area.
 *
 * Each drone's track through the sector is one sweep. Re-entering the sector adds track length,
 * which raises that sweep's coverage and so its POD along 1 − e^(−coverage); a second drone adds
 * an independent sweep, which raises the cumulative figure along 1 − Π(1 − POD_i). Both are the
 * documented curves, and both are what make "re-sweep or move on" a real decision for the
 * operator rather than a guess.
 */
export function buildSectorPodReport(input: SectorPodInput): SectorPodReport {
  const polygon = input.scenario?.searchArea ?? []
  if (!input.scenario || polygon.length < 3) return EMPTY_REPORT

  const sectorAreaM2 = polygonAreaM2(polygon)
  if (sectorAreaM2 <= 0) return EMPTY_REPORT

  // Atmosphere shortens R_d before it ever reaches the sweep-width relation, so a sweep flown in
  // fog reports the lower POD it earned. This is the same transmission term the live WP-5
  // detection gate applies, taken from the same function — the reported POD and the detection
  // the operator actually gets can never drift apart.
  const transmission = thermalTransmission(input.weather ?? null)

  const sweeps = [...input.drones]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((drone) => buildSweep(drone, input, polygon, sectorAreaM2, transmission))

  const sourced = sweeps.filter((sweep) => sweep.pod !== null)
  return {
    sectorAreaM2,
    sweeps,
    cumulativePod: sourced.length > 0 ? cumulativePod(sourced.map((sweep) => sweep.pod as number)) : null,
    supported: sourced.length > 0,
    unsourcedPlatforms: [...new Set(
      sweeps.filter((sweep) => sweep.status === 'unsourced').map((sweep) => sweep.platformName),
    )].sort(),
  }
}

function buildSweep(
  drone: DroneState,
  input: SectorPodInput,
  polygon: readonly LatLng[],
  sectorAreaM2: number,
  transmission: number,
): SectorSweep {
  const platform = platformForDrone(input.scenario as ScenarioConfig, drone.id)
  const detectionRadiusM = effectiveDetectionRangeM(platform.thermal, SAR_TARGET_SIZE_M, transmission)

  const base = {
    droneId: drone.id,
    label: drone.label,
    platformName: platform.displayName,
    detectionRadiusM,
  }

  // Fail closed before any effort is measured: without published optics there is no R_d, so
  // there is no W, no coverage and no POD. Reporting the flown track length is still useful
  // (the operator did the work), but it earns no detection claim.
  if (detectionRadiusM === null) {
    const trackLengthM = sectorTrackLengthM(input.positionHistory[drone.id] ?? [], polygon)
    return {
      ...base,
      sweepWidthM: 0,
      trackLengthM,
      losFraction: 0,
      effectiveEffortM: 0,
      coverage: 0,
      pod: null,
      status: 'unsourced',
    }
  }

  const w = sweepWidthM(detectionRadiusM)
  const history = input.positionHistory[drone.id] ?? []
  const trackLengthM = sectorTrackLengthM(history, polygon)

  if (trackLengthM <= 0) {
    return { ...base, sweepWidthM: w, trackLengthM: 0, losFraction: 0, effectiveEffortM: 0, coverage: 0, pod: 0, status: 'no_effort' }
  }

  const losFraction = swathVisibleFraction(drone, history, polygon, w, input.occlusion)
  const effectiveEffortM = trackLengthM * losFraction
  const { coverage, pod } = probabilityOfDetection({
    detectionRadiusM,
    trackLengthM: effectiveEffortM,
    sectorAreaM2,
  })

  return {
    ...base,
    sweepWidthM: w,
    trackLengthM,
    losFraction,
    effectiveEffortM,
    coverage,
    pod,
    // POD 0 through total occlusion is a real, reportable result — the accept criterion is
    // precisely that a sweep which never achieved line of sight scores nothing.
    status: losFraction <= 0 ? 'no_los' : 'ok',
  }
}

/** Track length flown inside the sector. A segment counts when either endpoint is inside it. */
function sectorTrackLengthM(history: readonly LatLng[], polygon: readonly LatLng[]): number {
  let effortM = 0
  for (let index = 1; index < history.length; index += 1) {
    const from = history[index - 1]
    const to = history[index]
    if (pointInPolygon(from, polygon as LatLng[]) || pointInPolygon(to, polygon as LatLng[])) {
      effortM += haversineDistanceM(from, to)
    }
  }
  return effortM
}

/**
 * Fraction of the swept swath the sensor could actually see.
 *
 * Sweep width is a claim about ground either side of the track, so the LOS question is not "can
 * the drone see straight down" (trivially yes) but "can it see out to the edges of the swath it
 * is being credited for". Each sample probes both swath edges at ±W/2 perpendicular to the track;
 * the fraction of clear probes scales the effort. Terrain that hides half a valley therefore
 * halves the coverage that sweep earns, and a sweep flown entirely behind a ridge earns none.
 *
 * Simplification, stated: `positionHistory` records position without altitude, so probes are
 * flown at the drone's current altitude. For the constant-altitude search patterns the SAR
 * planner generates this is exact; for a sweep flown during a climb it is an approximation of
 * the altitude profile, never of the terrain.
 */
function swathVisibleFraction(
  drone: DroneState,
  history: readonly LatLng[],
  polygon: readonly LatLng[],
  sweepW: number,
  occlusion?: OcclusionService,
): number {
  if (!occlusion || sweepW <= 0) return 1

  const segments: Array<{ from: LatLng; to: LatLng }> = []
  for (let index = 1; index < history.length; index += 1) {
    const from = history[index - 1]
    const to = history[index]
    if (pointInPolygon(from, polygon as LatLng[]) || pointInPolygon(to, polygon as LatLng[])) {
      segments.push({ from, to })
    }
  }
  if (segments.length === 0) return 0

  // Even stride over the in-sector segments: a long sweep is sampled across its whole length
  // rather than densely at the start, so the estimate does not depend on where the cap bites.
  const stride = Math.max(1, Math.ceil(segments.length / MAX_LOS_SAMPLES))
  const halfSwathM = sweepW / 2

  let clear = 0
  let probes = 0
  for (let index = 0; index < segments.length; index += stride) {
    const { from, to } = segments[index]
    const trackBearing = bearingDeg(from, to)
    const droneMslM = occlusion.groundElevation(from.lat, from.lng) + drone.altitudeFt * FT_TO_M
    for (const side of [90, -90]) {
      const edge = offsetLatLng(from, trackBearing + side, halfSwathM)
      const los = occlusion.hasLineOfSight(
        { lat: from.lat, lng: from.lng, altMslM: droneMslM },
        { lat: edge.lat, lng: edge.lng, altMslM: occlusion.groundElevation(edge.lat, edge.lng) },
      )
      probes += 1
      if (los.clear) clear += 1
    }
  }
  return probes === 0 ? 0 : clear / probes
}

/**
 * Sector area via an equal-area local projection about the polygon's mean latitude. Shoelace on
 * the projected metres; accurate well past the scale of any search area a single sortie sweeps.
 */
export function polygonAreaM2(points: readonly LatLng[]): number {
  if (points.length < 3) return 0
  const meanLatRad = points.reduce((sum, point) => sum + point.lat, 0) / points.length * Math.PI / 180
  const metersPerDegreeLat = 111_320
  const metersPerDegreeLng = metersPerDegreeLat * Math.cos(meanLatRad)
  const origin = points[0]
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const currentX = (current.lng - origin.lng) * metersPerDegreeLng
    const currentY = (current.lat - origin.lat) * metersPerDegreeLat
    const nextX = (next.lng - origin.lng) * metersPerDegreeLng
    const nextY = (next.lat - origin.lat) * metersPerDegreeLat
    area += currentX * nextY - nextX * currentY
  }
  return Math.abs(area) / 2
}
