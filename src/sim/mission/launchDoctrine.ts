import { platformForDrone } from '@/sim/drone/platformCatalog'
import { BAY_SPACING_M } from '@/sim/mission/LaunchCoordinator'
import {
  batteryReservePctForDrone,
  effectiveBatteryDrainRateForDrone,
} from '@/sim/mission/rechargeStations'
import { auditScenarioRoutes, droneIdForIndex, firstBreachedGeofence } from '@/sim/mission/routeAudit'
import { bearingDeg, haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type {
  LatLng,
  LaunchBayPlan,
  LaunchBayStatus,
  LaunchDoctrineAssignmentDetail,
  LaunchDoctrineCandidate,
  LaunchDoctrineRejectCode,
  LaunchDoctrineScore,
  LaunchRecoverySite,
  LaunchSiteExposure,
  ScenarioConfig,
  Waypoint,
  WeatherVariantState,
} from '@/types'

const DISPERSION_INCREMENT = 12
const EXPOSURE_LIMITS: Record<LaunchSiteExposure, { maxGustKts: number; minCeilingFt: number }> = {
  sheltered: { maxGustKts: 35, minCeilingFt: 150 },
  semi: { maxGustKts: 30, minCeilingFt: 200 },
  exposed: { maxGustKts: 25, minCeilingFt: 300 },
}

export interface LaunchDoctrineInput {
  scenario: ScenarioConfig
  weather: WeatherVariantState
}

export interface LaunchDoctrineSituation extends LaunchDoctrineInput {
  droneIds: string[]
  launchSites: Record<string, LaunchRecoverySite>
  recoverySites: Record<string, LaunchRecoverySite>
  assignments: Readonly<Record<string, string>>
}

export function buildLaunchDoctrineSituation(
  input: LaunchDoctrineInput,
  assignments: Readonly<Record<string, string>> = {},
): LaunchDoctrineSituation {
  return {
    scenario: input.scenario,
    weather: input.weather,
    droneIds: Array.from({ length: input.scenario.droneCount }, (_, index) => droneIdForIndex(index)).sort(),
    launchSites: canonicalSites(input.scenario.launchSites),
    recoverySites: canonicalSites(input.scenario.recoverySites),
    assignments: { ...assignments },
  }
}

export function weatherGateForSite(
  site: LaunchRecoverySite,
  weather: WeatherVariantState,
): LaunchDoctrineRejectCode | null {
  const exposure = site.exposure ?? 'semi'
  const limits = EXPOSURE_LIMITS[exposure]
  return weather.activeHazards.includes('snow_ice')
    || weather.gustKts > limits.maxGustKts
    || weather.ceilingFt < limits.minCeilingFt
    ? 'weather_exposure'
    : null
}

export function effectiveSiteCapacity(site: LaunchRecoverySite): number {
  const declared = Math.max(0, Math.floor(site.capacityDrones ?? 2))
  if (site.padFootprintM === undefined) return declared
  const footprintCapacity = Math.floor(Math.max(0, site.padFootprintM) / BAY_SPACING_M) + 1
  return Math.min(declared, footprintCapacity)
}

export function evaluateLaunchCandidate(
  situation: LaunchDoctrineSituation,
  droneId: string,
  siteId: string,
): LaunchDoctrineCandidate {
  const { scenario, weather } = situation
  const site = situation.launchSites[siteId]
  const route = routeForDrone(scenario, droneId)
  const recovery = recoveryForDrone(situation, droneId, route)
  const rejected = new Set<LaunchDoctrineRejectCode>()

  if (!route.length) rejected.add('missing_route')
  if (!recovery) rejected.add('missing_recovery')
  if (!site) {
    return missingSiteCandidate(droneId, siteId, rejected)
  }

  const altitudeFt = route[0]?.altitudeFt ?? 120
  if (firstBreachedGeofence(site.position, altitudeFt, scenario.geofences)) {
    rejected.add('launch_geofence')
  }
  if (route[0] && climboutBreaches(scenario, droneId, site.position, route[0])) {
    rejected.add('climbout_geofence')
  }
  const weatherReject = weatherGateForSite(site, weather)
  if (weatherReject) rejected.add(weatherReject)

  const loads = assignmentLoads(situation.assignments)
  const assignedCount = loads.get(siteId) ?? 0
  const declaredCapacity = Math.max(0, Math.floor(site.capacityDrones ?? 2))
  const footprintCapacity = site.padFootprintM === undefined
    ? declaredCapacity
    : Math.floor(Math.max(0, site.padFootprintM) / BAY_SPACING_M) + 1
  if (assignedCount > declaredCapacity) rejected.add('capacity')
  if (assignedCount > footprintCapacity) rejected.add('pad_footprint')

  const metrics = missionMetrics(scenario, weather, droneId, site.position, route, recovery?.site.position)
  if (metrics.reserveMarginPct < 0) rejected.add('unreachable')

  const score = candidateScore({
    scenario,
    droneId,
    site,
    firstTaskDistanceM: metrics.firstTaskDistanceM,
    transitSec: metrics.transitSec,
    recoveryDistanceM: recovery ? haversineDistanceM(site.position, recovery.site.position) : 0,
    dispersionPenalty: 0,
  })
  const rejectedBy = [...rejected].sort()

  return {
    id: `${droneId}|${siteId}`,
    droneId,
    siteId,
    recoverySiteId: recovery?.id ?? null,
    launchPosition: clonePosition(site.position),
    firstTaskDistanceM: round(metrics.firstTaskDistanceM),
    transitSec: round(metrics.transitSec),
    routeDistanceM: round(metrics.routeDistanceM),
    batteryRequiredPct: round(metrics.batteryRequiredPct),
    reserveMarginPct: round(metrics.reserveMarginPct),
    score,
    rejectedBy,
    rationale: rationale(site, metrics, score, rejectedBy),
  }
}

export function buildLaunchBayPlan(
  scenario: ScenarioConfig,
  weather: WeatherVariantState,
  assignments: Record<string, string>,
): LaunchBayPlan {
  const situation = buildLaunchDoctrineSituation({ scenario, weather }, assignments)
  const candidatesByDrone: Record<string, LaunchDoctrineCandidate[]> = {}
  const rejectedByDrone: Record<string, LaunchDoctrineCandidate[]> = {}
  const blockers: string[] = []
  const assignmentDetails: Record<string, LaunchDoctrineAssignmentDetail> = {}
  const loads = assignmentLoads(assignments)

  for (const droneId of situation.droneIds) {
    const candidates = Object.keys(situation.launchSites)
      .sort()
      .map((siteId) => evaluateLaunchCandidate(situation, droneId, siteId))
    candidatesByDrone[droneId] = candidates
    rejectedByDrone[droneId] = candidates.filter((candidate) => candidate.rejectedBy.length > 0)

    const assignedSiteId = assignments[droneId]
    if (!assignedSiteId) {
      blockers.push(`${droneId.toUpperCase()} — no launch bay assigned`)
      continue
    }
    const candidate = candidates.find((item) => item.siteId === assignedSiteId)
    if (!candidate) {
      blockers.push(`${droneId.toUpperCase()} — unknown launch site ${assignedSiteId}`)
      continue
    }
    if (candidate.rejectedBy.length > 0) {
      blockers.push(`${droneId.toUpperCase()} — ${assignedSiteId}: ${candidate.rejectedBy.join(', ')}`)
      continue
    }
    const siteLoad = loads.get(assignedSiteId) ?? 1
    assignmentDetails[droneId] = {
      ...candidate,
      score: withDispersion(candidate.score, -6 * Math.max(0, siteLoad - 1)),
      rank: 0,
      bay: candidate.launchPosition,
    }
  }

  applySiteFans(situation, assignmentDetails)
  rankAssignments(assignmentDetails)
  const bayStatuses = buildBayStatuses(situation, assignments)

  return {
    assignments: { ...assignments },
    assignmentDetails,
    candidatesByDrone,
    rejectedByDrone,
    bayStatuses,
    blockers,
    readyToLaunch: blockers.length === 0,
  }
}

export function buildAutoLaunchDoctrinePlan(
  scenario: ScenarioConfig,
  weather: WeatherVariantState,
): LaunchBayPlan {
  const emptySituation = buildLaunchDoctrineSituation({ scenario, weather })
  const candidatesByDrone = Object.fromEntries(emptySituation.droneIds.map((droneId) => [
    droneId,
    Object.keys(emptySituation.launchSites)
      .sort()
      .map((siteId) => evaluateLaunchCandidate(emptySituation, droneId, siteId))
      .filter((candidate) => candidate.rejectedBy.length === 0),
  ]))
  const assignments: Record<string, string> = {}
  const loads = new Map<string, number>()
  const remaining = new Set(emptySituation.droneIds)

  while (remaining.size > 0) {
    const available = [...remaining].flatMap((droneId) => (
      candidatesByDrone[droneId].filter((candidate) => {
        const site = emptySituation.launchSites[candidate.siteId]
        return (loads.get(candidate.siteId) ?? 0) < effectiveSiteCapacity(site)
      })
    ))
    available.sort((left, right) => compareAdjustedCandidates(left, right, loads))
    const best = available[0]
    if (!best) break
    assignments[best.droneId] = best.siteId
    loads.set(best.siteId, (loads.get(best.siteId) ?? 0) + 1)
    remaining.delete(best.droneId)
  }

  improveAssignments(assignments, candidatesByDrone)
  return buildLaunchBayPlan(scenario, weather, assignments)
}

function canonicalSites(
  sites: Record<string, LaunchRecoverySite> | undefined,
): Record<string, LaunchRecoverySite> {
  return Object.fromEntries(Object.entries(sites ?? {})
    .map(([recordKey, site]): [string, LaunchRecoverySite] => {
      const id = site.id?.trim() || recordKey
      return [id, { ...site, id, position: clonePosition(site.position) }]
    })
    .sort(([left], [right]) => left.localeCompare(right)))
}

function routeForDrone(scenario: ScenarioConfig, droneId: string): Waypoint[] {
  return (scenario.perDroneWaypoints?.[droneId] ?? scenario.waypoints).map((waypoint) => ({
    ...waypoint,
    position: clonePosition(waypoint.position),
  }))
}

function recoveryForDrone(
  situation: LaunchDoctrineSituation,
  droneId: string,
  route: readonly Waypoint[],
): { id: string; site: LaunchRecoverySite } | null {
  const preferredId = situation.scenario.defaultRecoveryAssignments?.[droneId]
  if (preferredId && situation.recoverySites[preferredId]) {
    return { id: preferredId, site: situation.recoverySites[preferredId] }
  }
  if (situation.recoverySites[droneId]) {
    return { id: droneId, site: situation.recoverySites[droneId] }
  }
  const entries = Object.entries(situation.recoverySites)
  if (entries.length === 0) return null
  const from = route.at(-1)?.position ?? situation.scenario.startPosition
  const [id, site] = entries.sort((left, right) => (
    haversineDistanceM(from, left[1].position) - haversineDistanceM(from, right[1].position)
      || left[0].localeCompare(right[0])
  ))[0]
  return { id, site }
}

function climboutBreaches(
  scenario: ScenarioConfig,
  droneId: string,
  start: LatLng,
  firstWaypoint: Waypoint,
): boolean {
  return auditScenarioRoutes(scenario, {
    routes: { [droneId]: [firstWaypoint] },
    startPositions: { [droneId]: start },
    includeRtb: false,
  }).some((finding) => finding.droneId === droneId && finding.kind === 'segment')
}

function missionMetrics(
  scenario: ScenarioConfig,
  weather: WeatherVariantState,
  droneId: string,
  launch: LatLng,
  route: readonly Waypoint[],
  recovery: LatLng | undefined,
): {
  firstTaskDistanceM: number
  transitSec: number
  routeDistanceM: number
  batteryRequiredPct: number
  reserveMarginPct: number
} {
  const firstTaskDistanceM = route[0] ? haversineDistanceM(launch, route[0].position) : 0
  let routeDistanceM = 0
  let cursor = launch
  for (const waypoint of route) {
    routeDistanceM += haversineDistanceM(cursor, waypoint.position)
    cursor = waypoint.position
  }
  if (recovery && haversineDistanceM(cursor, recovery) > 10) {
    routeDistanceM += haversineDistanceM(cursor, recovery)
  }
  const speedMs = Math.max(0.1, platformForDrone(scenario, droneId).maxSpeedMs * weather.speedCapMultiplier)
  const transitSec = firstTaskDistanceM / speedMs
  const durationSec = routeDistanceM / speedMs
  const batteryRequiredPct = durationSec
    * effectiveBatteryDrainRateForDrone(scenario, droneId)
    * weather.batteryDrainMultiplier
  const reserveMarginPct = scenario.batteryStartPct
    - batteryReservePctForDrone(scenario, droneId)
    - batteryRequiredPct
  return { firstTaskDistanceM, transitSec, routeDistanceM, batteryRequiredPct, reserveMarginPct }
}

function candidateScore(input: {
  scenario: ScenarioConfig
  droneId: string
  site: LaunchRecoverySite
  firstTaskDistanceM: number
  transitSec: number
  recoveryDistanceM: number
  dispersionPenalty: number
}): LaunchDoctrineScore {
  const deadLegKm = input.firstTaskDistanceM / 1_000
  const transitMinutes = input.transitSec / 60
  const transitEfficiency = -Math.min(40, deadLegKm * 8 + transitMinutes * 2)
  const doctrineFit = doctrineFitScore(input.scenario, input.droneId, input.site)
  const recoverySymmetry = -Math.min(20, input.recoveryDistanceM / 1_000 * 4)
  const authoredIntent = authoredIntentScore(input.scenario, input.droneId, input.site)
  const total = transitEfficiency + doctrineFit + recoverySymmetry + authoredIntent + input.dispersionPenalty
  return {
    transitEfficiency: round(transitEfficiency),
    doctrineFit,
    recoverySymmetry: round(recoverySymmetry),
    authoredIntent,
    dispersionPenalty: input.dispersionPenalty,
    total: round(total),
  }
}

function doctrineFitScore(scenario: ScenarioConfig, droneId: string, site: LaunchRecoverySite): number {
  const role = `${scenario.droneRouteBriefs?.[droneId]?.role ?? scenario.perDroneMissionRoles?.[droneId] ?? ''}`.toLowerCase()
  const kind = site.kind
  const elevated = ['building_rooftop', 'rooftop', 'police_rooftop', 'helipad'].includes(kind)
  const mobile = ['mobile_command', 'field_icp'].includes(kind)
  if (/maritime|vessel|coast|sarops|drift|swimmer/.test(role)) return kind === 'vessel' ? 25 : 0
  if (/relay|c2|overwatch|standoff/.test(role)) return elevated ? 25 : (mobile ? 12 : 0)
  if (/rapid|intercept|response|shadow|pursuit|breach/.test(role)) return mobile ? 25 : 0
  return 0
}

function authoredIntentScore(scenario: ScenarioConfig, droneId: string, site: LaunchRecoverySite): number {
  return scenario.defaultLaunchAssignments?.[droneId] === site.id ? 15 : 0
}

function withDispersion(score: LaunchDoctrineScore, dispersionPenalty: number): LaunchDoctrineScore {
  return {
    ...score,
    dispersionPenalty,
    total: round(score.total - score.dispersionPenalty + dispersionPenalty),
  }
}

function compareAdjustedCandidates(
  left: LaunchDoctrineCandidate,
  right: LaunchDoctrineCandidate,
  loads: ReadonlyMap<string, number>,
): number {
  const leftTotal = left.score.total - DISPERSION_INCREMENT * (loads.get(left.siteId) ?? 0)
  const rightTotal = right.score.total - DISPERSION_INCREMENT * (loads.get(right.siteId) ?? 0)
  return rightTotal - leftTotal
    || right.reserveMarginPct - left.reserveMarginPct
    || left.transitSec - right.transitSec
    || left.id.localeCompare(right.id)
}

function improveAssignments(
  assignments: Record<string, string>,
  candidatesByDrone: Record<string, LaunchDoctrineCandidate[]>,
): void {
  const droneIds = Object.keys(assignments).sort()
  for (let pass = 0; pass < 2; pass++) {
    for (let leftIndex = 0; leftIndex < droneIds.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < droneIds.length; rightIndex++) {
        const leftId = droneIds[leftIndex]
        const rightId = droneIds[rightIndex]
        const leftSite = assignments[leftId]
        const rightSite = assignments[rightId]
        if (leftSite === rightSite) continue
        const current = (candidateFor(candidatesByDrone, leftId, leftSite)?.score.total ?? -Infinity)
          + (candidateFor(candidatesByDrone, rightId, rightSite)?.score.total ?? -Infinity)
        const swapped = (candidateFor(candidatesByDrone, leftId, rightSite)?.score.total ?? -Infinity)
          + (candidateFor(candidatesByDrone, rightId, leftSite)?.score.total ?? -Infinity)
        if (swapped > current) {
          assignments[leftId] = rightSite
          assignments[rightId] = leftSite
        }
      }
    }
  }
}

function candidateFor(
  candidatesByDrone: Record<string, LaunchDoctrineCandidate[]>,
  droneId: string,
  siteId: string,
): LaunchDoctrineCandidate | undefined {
  return candidatesByDrone[droneId]?.find((candidate) => candidate.siteId === siteId)
}

function buildBayStatuses(
  situation: LaunchDoctrineSituation,
  assignments: Readonly<Record<string, string>>,
): LaunchBayStatus[] {
  return Object.entries(situation.launchSites).map(([siteId, site]) => {
    const weatherClosed = weatherGateForSite(site, situation.weather) !== null
    return {
      siteId,
      capacityDrones: site.capacityDrones ?? 2,
      effectiveCapacityDrones: effectiveSiteCapacity(site),
      assignedDroneIds: situation.droneIds.filter((droneId) => assignments[droneId] === siteId),
      weatherClosed,
      exposure: site.exposure ?? 'semi',
      closureReason: weatherClosed
        ? `Bay closed for ${(site.exposure ?? 'semi')} exposure in current conditions`
        : undefined,
    }
  }).sort((left, right) => left.siteId.localeCompare(right.siteId))
}

function applySiteFans(
  situation: LaunchDoctrineSituation,
  details: Record<string, LaunchDoctrineAssignmentDetail>,
): void {
  for (const [siteId, site] of Object.entries(situation.launchSites)) {
    const assigned = Object.values(details)
      .filter((detail) => detail.siteId === siteId)
      .sort((left, right) => left.droneId.localeCompare(right.droneId))
    if (assigned.length === 0) continue
    const bearings = assigned.map((detail) => bearingDeg(site.position, routeForDrone(situation.scenario, detail.droneId)[0]?.position ?? site.position))
    const fanAxis = (meanBearingDeg(bearings) + 90) % 360
    assigned.forEach((detail, index) => {
      const offsetIndex = index - (assigned.length - 1) / 2
      const distanceM = Math.abs(offsetIndex) * BAY_SPACING_M
      const direction = offsetIndex >= 0 ? fanAxis : (fanAxis + 180) % 360
      detail.bay = distanceM < 0.01 ? clonePosition(site.position) : offsetLatLng(site.position, direction, distanceM)
    })
  }
}

function rankAssignments(details: Record<string, LaunchDoctrineAssignmentDetail>): void {
  Object.values(details)
    .sort((left, right) => right.score.total - left.score.total || left.id.localeCompare(right.id))
    .forEach((detail, index) => { detail.rank = index + 1 })
}

function assignmentLoads(assignments: Readonly<Record<string, string>>): Map<string, number> {
  const loads = new Map<string, number>()
  Object.values(assignments).forEach((siteId) => loads.set(siteId, (loads.get(siteId) ?? 0) + 1))
  return loads
}

function meanBearingDeg(bearings: number[]): number {
  if (bearings.length === 0) return 0
  const vector = bearings.reduce((sum, bearing) => {
    const radians = bearing * Math.PI / 180
    return { x: sum.x + Math.cos(radians), y: sum.y + Math.sin(radians) }
  }, { x: 0, y: 0 })
  return (Math.atan2(vector.y, vector.x) * 180 / Math.PI + 360) % 360
}

function rationale(
  site: LaunchRecoverySite,
  metrics: ReturnType<typeof missionMetrics>,
  score: LaunchDoctrineScore,
  rejectedBy: LaunchDoctrineRejectCode[],
): string {
  if (rejectedBy.length) return `${site.label} rejected: ${rejectedBy.join(', ')}`
  return `${site.label} · ${(metrics.firstTaskDistanceM / 1_000).toFixed(1)} km to task · ${(metrics.transitSec / 60).toFixed(1)} min transit · ${metrics.reserveMarginPct.toFixed(1)}% reserve margin · ${site.exposure ?? 'semi'} · score ${score.total.toFixed(1)}`
}

function missingSiteCandidate(
  droneId: string,
  siteId: string,
  rejected: Set<LaunchDoctrineRejectCode>,
): LaunchDoctrineCandidate {
  rejected.add('capacity')
  const score: LaunchDoctrineScore = {
    transitEfficiency: 0,
    doctrineFit: 0,
    recoverySymmetry: 0,
    authoredIntent: 0,
    dispersionPenalty: 0,
    total: 0,
  }
  return {
    id: `${droneId}|${siteId}`,
    droneId,
    siteId,
    recoverySiteId: null,
    launchPosition: { lat: 0, lng: 0 },
    firstTaskDistanceM: 0,
    transitSec: 0,
    routeDistanceM: 0,
    batteryRequiredPct: 0,
    reserveMarginPct: 0,
    score,
    rejectedBy: [...rejected].sort(),
    rationale: `Unknown launch site ${siteId}`,
  }
}

function clonePosition(position: LatLng): LatLng {
  return { lat: position.lat, lng: position.lng }
}

function round(value: number): number {
  return Number(value.toFixed(4))
}
