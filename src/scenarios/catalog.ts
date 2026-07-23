import { demoBasic, demoSAR } from '@/scenarios/demoBasic'
import { suspectSearch, vehiclePursuit, sarCoastal, portPerimeter, wildfireRecon } from '@/scenarios/demoScenarios'
import { EXTREME_SCENARIOS } from '@/scenarios/extremeScenarios'
import { NIST_LANE_SCENARIOS } from '@/scenarios/nistLanes'
import { auditScenarioRoutes, buildSafeDroneRoutes, droneIdForIndex, relocatePointOutsideGeofences } from '@/sim/mission/routeAudit'
import { getWeatherProfile } from '@/sim/weather/weatherEngine'
import { haversineDistanceM } from '@/utils/geometry'
import { BAY_SPACING_M } from '@/sim/mission/LaunchCoordinator'
import { launchSiteForDrone, recoverySiteForDrone } from '@/sim/mission/siteAssignments'
import type {
  DispatchTimelineCategory,
  DispatchTimelineEntry,
  DroneRouteBrief,
  LatLng,
  LaunchRecoverySite,
  MissionBrief,
  OperationalFeature,
  RechargeStation,
  ScenarioConfig,
  ScenarioWeatherProfile,
  Waypoint,
  WeatherLocationTag,
} from '@/types'

const RAW_SCENARIOS: ScenarioConfig[] = [
  demoBasic,
  demoSAR,
  suspectSearch,
  vehiclePursuit,
  sarCoastal,
  portPerimeter,
  wildfireRecon,
  ...EXTREME_SCENARIOS,
  ...NIST_LANE_SCENARIOS,
]

// Recognized agency tokens, scanned in name-then-description order. This replaces a fragile
// name-prefix split that produced non-agencies like "SAR — COASTAL" as the commanding agency.
// NOTE: declared BEFORE ALL_SCENARIOS below — enhanceScenarioForOperations runs at module
// evaluation time and reads this via deriveAgencies.
const KNOWN_AGENCIES = [
  'SFPD', 'OPD', 'CHP', 'BART PD', 'LAPD', 'NYPD', 'FDNY', 'USCG', 'CAL FIRE', 'USFS',
  'CBP', 'FBI', 'ATF', 'USSS', 'DHS', 'FEMA', 'LAHSA', 'DMH',
] as const

const MOBILE_SITE_DEFAULTS: Partial<Record<LaunchRecoverySite['kind'], { radiusM: number; timeSec: number }>> = {
  mobile_command: { radiusM: 5_000, timeSec: 300 },
  field_icp: { radiusM: 2_000, timeSec: 180 },
  vessel: { radiusM: 10_000, timeSec: 600 },
}

export const ALL_SCENARIOS: ScenarioConfig[] = RAW_SCENARIOS.map((scenario) => enhanceScenarioForOperations(scenario))

/**
 * Incident scenarios — everything except the WP-9 NIST proficiency lanes.
 *
 * The lanes are standardised skills trials, not incidents: they have no commanding agency, no
 * dispatch timeline and no observed weather, and asserting incident invariants over them would
 * force fabricated metadata onto a scenario whose whole value is that it is standards-defined.
 */
export const INCIDENT_SCENARIOS: ScenarioConfig[] = ALL_SCENARIOS.filter(
  (scenario) => !NIST_LANE_SCENARIOS.some((lane) => lane.id === scenario.id),
)

export const SCENARIO_OPTIONS = ALL_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  label: scenario.name,
  config: scenario,
}))

export function enhanceScenarioForOperations(scenario: ScenarioConfig): ScenarioConfig {
  const safeStart = relocatePointOutsideGeofences(scenario.startPosition, scenario.geofences, 120)
  const rechargeStations = scenario.rechargeStations?.map((station) => ({
    ...station,
    position: relocatePointOutsideGeofences(station.position, scenario.geofences, 120),
  }))
  const stationsById = new Map((rechargeStations ?? []).map((station) => [station.id, station]))
  const perDroneRechargeStations = scenario.perDroneRechargeStations
    ? Object.fromEntries(
        Object.entries(scenario.perDroneRechargeStations).map(([droneId, stations]) => [
          droneId,
          stations.map((station) => relocatePointOutsideGeofences(station, scenario.geofences, 120)),
        ]),
      )
    : undefined
  const rechargeStationsByDroneIds = scenario.perDroneRechargeStationIds
    ? Object.fromEntries(
        Object.entries(scenario.perDroneRechargeStationIds).map(([droneId, stationIds]) => [
          droneId,
          stationIds
            .map((stationId) => stationsById.get(stationId)?.position)
            .filter((position): position is LatLng => Boolean(position)),
        ]),
      )
    : undefined

  const baseScenario: ScenarioConfig = {
    ...scenario,
    startPosition: safeStart,
    rechargeStations,
    perDroneRechargeStations: rechargeStationsByDroneIds ?? perDroneRechargeStations,
  }

  const launchPool = deriveLaunchSites(baseScenario)
  const launchSites = launchPool.sites
  const recoveryPool = deriveRecoverySites(baseScenario, launchSites, launchPool.assignments, stationsById)
  const recoverySites = recoveryPool.sites
  const perDroneStartPositions: Record<string, LatLng> = {}

  for (let i = 0; i < scenario.droneCount; i++) {
    const id = droneIdForIndex(i)
    const launch = launchSites[launchPool.assignments[id]]
    perDroneStartPositions[id] = launch?.position ?? safeStart
  }

  const prepared: ScenarioConfig = {
    ...baseScenario,
    perDroneStartPositions,
    launchSites,
    recoverySites,
    defaultLaunchAssignments: launchPool.assignments,
    defaultRecoveryAssignments: recoveryPool.assignments,
  }

  // Custom missions carry operator-authored routes: honor them verbatim (after a safety
  // audit) instead of generating derived safe routes. Everything downstream — briefs,
  // operational features, and initFleet's route derivation — then reflects the authored
  // geometry rather than an overwrite.
  const routes = scenario.isCustom && scenario.authoredRoutes
    ? honorAuthoredRoutes(prepared, scenario.authoredRoutes)
    : buildSafeDroneRoutes(prepared)

  return {
    ...prepared,
    perDroneWaypoints: routes,
    missionBrief: scenario.missionBrief ?? deriveMissionBrief(prepared),
    dispatchTimeline: scenario.dispatchTimeline ?? deriveDispatchTimeline(prepared),
    droneRouteBriefs: scenario.droneRouteBriefs ?? deriveDroneRouteBriefs(prepared, routes),
    operationalFeatures: scenario.operationalFeatures ?? deriveOperationalFeatures(prepared, routes),
    weatherProfile: scenario.weatherProfile ?? deriveWeatherProfile(scenario),
  }
}

/**
 * Custom-mission routes are drawn by the operator in the designer, so they must round-trip
 * unchanged (the registry spec asserts per-drone waypoints match the authored input exactly).
 * We keep every waypoint verbatim but run the standard geofence audit so an authored breach is
 * surfaced rather than silently flown — the audit is advisory here and never rewrites the route.
 */
function honorAuthoredRoutes(
  scenario: ScenarioConfig,
  authoredRoutes: Record<string, Waypoint[]>,
): Record<string, Waypoint[]> {
  const routes: Record<string, Waypoint[]> = {}
  for (let i = 0; i < scenario.droneCount; i++) {
    const id = droneIdForIndex(i)
    routes[id] = authoredRoutes[id] ?? scenario.perDroneWaypoints?.[id] ?? []
  }
  auditScenarioRoutes(scenario, { routes, includeRtb: false })
  return routes
}

/** Derive the location-appropriate weather profile from scenario metadata. */
function deriveWeatherProfile(scenario: ScenarioConfig): ScenarioWeatherProfile {
  const text = `${scenario.id} ${scenario.name} ${scenario.description}`.toLowerCase()
  let tag: WeatherLocationTag = 'generic'
  if (/coastal|harbor|vessel|uscg|bay|swimmer|port|maritime/.test(text)) tag = 'coastal'
  else if (/fire|wildfire|smoke|plume|hazmat/.test(text))               tag = 'wildfire'
  else if (/mountain|sierra|alpine|snowpack/.test(text))                tag = 'mountain'
  else if (/border|cbp|rio grande|desert|eagle pass/.test(text))        tag = 'desert_border'
  else if (/urban|city|sfpd|opd|nypd|lapd|pursuit|suspect/.test(text)) tag = 'urban'
  return getWeatherProfile(tag)
}

interface SitePool {
  sites: Record<string, LaunchRecoverySite>
  assignments: Record<string, string>
}

function exposureForKind(kind: LaunchRecoverySite['kind']): LaunchRecoverySite['exposure'] {
  if (['building_rooftop', 'rooftop', 'police_rooftop', 'vessel', 'helipad'].includes(kind)) return 'exposed'
  if (kind === 'mobile_command') return 'semi'
  return 'sheltered'
}

function normalizeSite(siteId: string, site: LaunchRecoverySite): LaunchRecoverySite {
  const capacityDrones = site.capacityDrones ?? 2
  const mobileDefaults = MOBILE_SITE_DEFAULTS[site.kind]
  const mobile = site.mobile ?? Boolean(mobileDefaults)
  return {
    ...site,
    id: site.id ?? siteId,
    exposure: site.exposure ?? exposureForKind(site.kind),
    mobile,
    repositionRadiusM: mobile ? site.repositionRadiusM ?? mobileDefaults?.radiusM : undefined,
    repositionTimeSec: mobile ? site.repositionTimeSec ?? mobileDefaults?.timeSec : undefined,
    capacityDrones,
    padFootprintM: site.padFootprintM ?? Math.max(0, capacityDrones - 1) * BAY_SPACING_M,
  }
}

function deriveLaunchSites(scenario: ScenarioConfig): SitePool {
  const sites: Record<string, LaunchRecoverySite> = {}
  const assignments: Record<string, string> = {}

  const authoredEntries = Object.entries(scenario.launchSites ?? {})
  if (authoredEntries.length > 0) {
    for (const [recordKey, raw] of authoredEntries) {
      const siteId = raw.id ?? recordKey
      sites[siteId] = {
        ...normalizeSite(siteId, raw),
        position: relocatePointOutsideGeofences(raw.position, scenario.geofences, 120),
      }
    }
    for (let i = 0; i < scenario.droneCount; i++) {
      const droneId = droneIdForIndex(i)
      const requested = scenario.defaultLaunchAssignments?.[droneId]
      const fallback = scenario.launchSites?.[droneId]?.id ?? (scenario.launchSites?.[droneId] ? droneId : undefined)
      const siteId = requested && sites[requested] ? requested : fallback
      if (siteId && sites[siteId]) assignments[droneId] = siteId
    }
    return { sites, assignments }
  }

  const siteId = `${scenario.id}-launch-primary`
  const raw = defaultLaunchSiteFor(scenario, siteId, scenario.startPosition)
  sites[siteId] = normalizeSite(siteId, {
    ...raw,
    capacityDrones: scenario.droneCount,
    padFootprintM: Math.max(0, scenario.droneCount - 1) * BAY_SPACING_M,
    position: relocatePointOutsideGeofences(raw.position, scenario.geofences, 120),
  })
  for (let i = 0; i < scenario.droneCount; i++) {
    assignments[droneIdForIndex(i)] = siteId
  }

  return { sites, assignments }
}

function deriveRecoverySites(
  scenario: ScenarioConfig,
  launchSites: Record<string, LaunchRecoverySite>,
  launchAssignments: Record<string, string>,
  stationsById: Map<string, RechargeStation>,
): SitePool {
  const sites: Record<string, LaunchRecoverySite> = {}
  const assignments: Record<string, string> = {}

  for (let i = 0; i < scenario.droneCount; i++) {
    const droneId = droneIdForIndex(i)
    const requested = scenario.defaultRecoveryAssignments?.[droneId]
    const legacyRaw = scenario.recoverySites?.[droneId]
    const authoredRaw = requested ? scenario.recoverySites?.[requested] : legacyRaw
    const raw = authoredRaw
      ?? recoveryFromRechargeStation(scenario, droneId, stationsById)
      ?? recoveryFromLaunchSite(launchSites[launchAssignments[droneId]])
    if (!raw) continue
    const siteId = raw.id ?? requested ?? legacyRaw?.id ?? (legacyRaw ? droneId : `${launchAssignments[droneId]}-recovery`)
    sites[siteId] = normalizeSite(siteId, {
      ...raw,
      position: relocatePointOutsideGeofences(raw.position, scenario.geofences, 120),
      isPrimaryRecovery: raw.isPrimaryRecovery ?? true,
    })
    assignments[droneId] = siteId
  }

  return { sites, assignments }
}

function defaultLaunchSiteFor(scenario: ScenarioConfig, droneId: string, position: LatLng): LaunchRecoverySite {
  const agency = primaryAgencyFor(scenario)
  const pad = droneId.toUpperCase()

  if (isCityScenario(scenario)) {
    return {
      id: droneId,
      exposure: 'semi',
      kind: 'mobile_command',
      label: `${agency} mobile command — pad ${pad}`,
      agency,
      position,
      surfaceNote: `Mobile command vehicle pad; ${missionClassFor(scenario)} launch crew staged.`,
    }
  }

  if (isMaritimeScenario(scenario)) {
    return {
      id: droneId,
      exposure: 'exposed',
      kind: 'vessel',
      label: `${agency} vessel deck — pad ${pad}`,
      agency,
      position,
      surfaceNote: 'Aft deck launch surface; deck recovery crew assigned.',
    }
  }

  if (scenario.name.toLowerCase().includes('airport')) {
    return {
      id: droneId,
      exposure: 'exposed',
      kind: 'helipad',
      label: `${agency} helipad — pad ${pad}`,
      agency,
      position,
      surfaceNote: 'Helipad surface inside the incident command footprint.',
    }
  }

  return {
    id: droneId,
    exposure: 'sheltered',
    kind: 'field_icp',
    label: `${agency} field ICP — pad ${pad}`,
    agency,
    position,
    surfaceNote: `Field ICP launch lane; ${missionClassFor(scenario)} crew staged.`,
  }
}

function recoveryFromRechargeStation(
  scenario: ScenarioConfig,
  droneId: string,
  stationsById: Map<string, RechargeStation>,
): LaunchRecoverySite | undefined {
  const stationIds = scenario.perDroneRechargeStationIds?.[droneId]
  const station = stationIds?.length ? stationsById.get(stationIds[stationIds.length - 1]) : undefined
  const position = scenario.perDroneRechargeStations?.[droneId]?.at(-1)
  const matchedStation = station ?? (position ? nearestStation(position, Array.from(stationsById.values())) : undefined)
  if (!position && !matchedStation) return undefined

  const agency = matchedStation?.agency ?? primaryAgencyFor(scenario)
  const label = matchedStation?.label ?? `${agency} forward recovery site`
  const kind = isCityScenario(scenario) ? 'mobile_command' : 'field_icp'
  return {
    id: `${matchedStation?.id ?? droneId}-recovery`,
    exposure: exposureForKind(kind),
    kind,
    label: `${label} — primary recovery`,
    agency,
    position: matchedStation?.position ?? position ?? scenario.startPosition,
    surfaceNote: `Forward recovery point at ${matchedStation?.road ?? 'the forward ICP route'}; battery swap and airframe check staged.`,
    isPrimaryRecovery: true,
  }
}

function recoveryFromLaunchSite(launchSite: LaunchRecoverySite): LaunchRecoverySite {
  return {
    ...launchSite,
    id: `${launchSite.id}-recovery`,
    label: `${launchSite.label} (recovery)`,
    surfaceNote: 'RTB recovery lane colocated with the launch surface.',
    isPrimaryRecovery: true,
  }
}

function nearestStation(position: LatLng, stations: RechargeStation[]): RechargeStation | undefined {
  let best: RechargeStation | undefined
  let bestDist = Infinity
  for (const station of stations) {
    const dist = haversineDistanceM(station.position, position)
    if (dist < bestDist) {
      bestDist = dist
      best = station
    }
  }
  return best
}

function deriveMissionBrief(scenario: ScenarioConfig): MissionBrief {
  const agencies = deriveAgencies(scenario)
  const missionClass = missionClassFor(scenario)
  return {
    agencies,
    situation: firstSentence(scenario.description),
    commandIntent:
      `Coordinate ${missionClass} UAS coverage with route discipline, geofence compliance, and ground-resource handoff. SIMULATION ONLY.`,
    coordinationModel:
      agencies.length > 1
        ? `${agencies[0]} holds incident command with ${agencies.slice(1).join(' / ')} liaison updates through the dispatch feed.`
        : `${agencies[0]} operates under single-agency air unit control with PIC approval for all retasks.`,
    primaryObjective: primaryObjectiveFor(scenario),
    successCondition: `Mission succeeds when assigned sectors are scanned, critical contacts are cued to ground units, and all drones recover or hold safely.`,
    operationalConstraints: [
      'Maintain scenario geofence and altitude constraints.',
      'Use standoff observation for protected assets and hazard zones.',
      'Log all operator retasks and route changes for chain-of-custody review.',
      'Simulation only: no real personal data, no weapon targeting, no real-world dispatching.',
    ],
  }
}

function deriveDispatchTimeline(scenario: ScenarioConfig): DispatchTimelineEntry[] {
  if (scenario.id === 'extreme_multiagency_sf_pursuit') return sfPursuitDispatchTimeline(scenario)

  const localDispatch = localDispatchSourcesFor(scenario)
  const supportSource = supportDispatchSourceFor(scenario)
  const leadUnit = leadFieldUnitFor(scenario)
  const operatorDrone = droneIdForIndex(Math.min(1, scenario.droneCount - 1))
  const entries: DispatchTimelineEntry[] = [
    entry(scenario, 'dispatch-0', 0, localDispatch[0], 'routine', 'dispatch',
      `${scenario.name}: local dispatch opened the simulation incident; PIC verify launch and recovery surfaces before takeoff.`),
    entry(scenario, 'field-14', 14, supportSource, 'advisory', 'field_unit',
      `${leadUnit} en route to command post; ground team staging at the named launch/recovery site.`),
    entry(scenario, 'agency-26', 26, localDispatch[1] ?? supportSource, 'advisory', 'agency_update',
      `${missionClassFor(scenario)} sectors assigned by drone role; responding unit status will update through this feed.`),
    entry(scenario, 'operator-42', 42, 'OPERATOR TASK', 'advisory', 'operator_task',
      `OPERATOR TASK: review ${operatorDrone.toUpperCase()} suggested route and hold until field unit status confirms the next move.`),
    entry(scenario, 'safety-58', 58, 'SAFETY', 'advisory', 'safety',
      'Safety monitor active: maintain geofence, altitude, battery reserve, and recovery-lane discipline.'),
  ]

  if (scenario.batteryProfile) {
    entries.push(entry(scenario, 'battery-kit', 8, 'AIR UNIT', 'advisory', 'agency_update',
      `${scenario.batteryProfile.label} installed; ${scenario.batteryProfile.reservePct} percent reserve threshold active for staged recovery.`))
  }

  if (scenario.rechargeStations?.length) {
    entries.push(entry(scenario, 'recharge-network', 32, 'MOBILE SUPPORT', 'advisory', 'agency_update',
      `${scenario.rechargeStations.length} mobile recharge stations staged on ${scenario.rechargeStations[0].road}; drones should advance station-to-station instead of returning to origin.`))
    scenario.rechargeStations.forEach((station, index) => {
      entries.push(entry(scenario, `${station.id}-ready`, 60 + index * 35, station.agency, station.priority ?? 'advisory', 'field_unit',
        `${station.label} reports battery swap kit, landing lane, and comms check ready for forward recovery.`))
    })
  }

  scenario.commsLossWindows.forEach((window, index) => {
    entries.push(entry(scenario, `comms-${index}`, window.startSec, 'COMMS', 'advisory', 'safety',
      'Predicted comms degradation window opening; relay drone should hold line-of-sight coverage.'))
  })

  return entries.sort((a, b) => a.timeSec - b.timeSec)
}

function sfPursuitDispatchTimeline(scenario: ScenarioConfig): DispatchTimelineEntry[] {
  return [
    entry(scenario, 'sfpd-open', 0, 'SFPD DISPATCH', 'urgent', 'dispatch',
      'SFPD DISPATCH: pursuit package opened from Financial District LKL; SFPD shadows launch from Embarcadero staging.'),
    entry(scenario, 'opd-roof', 10, 'OPD DISPATCH', 'urgent', 'agency_update',
      'OPD DISPATCH: OPD air liaison confirms Jack London Square simulated rooftop staging for UAV-03 and UAV-04.'),
    entry(scenario, 'chp-roof', 20, 'CHP GOLDEN GATE', 'advisory', 'agency_update',
      'CHP GOLDEN GATE: CHP East Bay intercept cell confirms UAV-05 rooftop launch and I-580 corridor handoff.'),
    entry(scenario, 'field-units', 32, 'OPD FIELD UNITS', 'urgent', 'field_unit',
      'OPD units en route from Jack London Square toward I-880; officer status two minutes out, CHP unit staging at I-580 hold.'),
    entry(scenario, 'operator-uav05', 42, 'OPERATOR TASK', 'urgent', 'operator_task',
      'OPERATOR TASK: move UAV-05 to I-580 hold point; OPD units are two minutes out.'),
    entry(scenario, 'bart-perimeter', 66, 'BART PD', 'advisory', 'field_unit',
      'BART PD unit on scene at Berkeley station perimeter; update LKL if suspect diverts toward transit access.'),
    entry(scenario, 'safety-bridge', 60, 'SAFETY', 'advisory', 'safety',
      'Safety note: Bay Bridge superstructure comms window active; relay and intercept drones must maintain approved corridor altitude.'),
    entry(scenario, 'mission-update', 96, 'FEDERAL LIAISON', 'advisory', 'agency_update',
      'Mission update: East Bay intercept logic active, perimeter sealers hold Albany Hills exits until field units report current status.'),
  ]
}

function entry(
  scenario: ScenarioConfig,
  id: string,
  timeSec: number,
  source: string,
  priority: DispatchTimelineEntry['priority'],
  category: DispatchTimelineCategory,
  message: string,
  linkedDroneId?: string,
): DispatchTimelineEntry {
  return { id: `${scenario.id}-${id}`, timeSec, source, priority, category, message, linkedDroneId }
}

function deriveDroneRouteBriefs(scenario: ScenarioConfig, routes: Record<string, import('@/types').Waypoint[]>): Record<string, DroneRouteBrief> {
  const briefs: Record<string, DroneRouteBrief> = {}

  for (let i = 0; i < scenario.droneCount; i++) {
    const id = droneIdForIndex(i)
    const route = routes[id] ?? []
    const role = scenario.perDroneMissionRoles?.[id] ?? defaultRoleFor(scenario, i)
    const altitudes = route.map((wp) => wp.altitudeFt)
    const minAlt = altitudes.length ? Math.min(...altitudes) : 100
    const maxAlt = altitudes.length ? Math.max(...altitudes) : 140
    const launchSite = launchSiteForDrone(scenario, id)
    const recoverySite = recoverySiteForDrone(scenario, id)

    briefs[id] = {
      role,
      launchRationale: launchSite
        ? `Launches from ${launchSite.label}. ${launchSite.surfaceNote}`
        : 'Starts from the closest safe staging point for its assigned sector.',
      routePattern: routePatternFor(scenario, role),
      altitudeBand: `${minAlt}-${maxAlt}ft AGL`,
      standoffOrRelayLogic: role.toLowerCase().includes('relay')
        ? 'Maintains elevated line-of-sight relay coverage while avoiding hazard overflight.'
        : 'Uses standoff turns and corridor-following legs to avoid protected zones.',
      recoveryPlan: recoverySite
        ? `RTB to ${recoverySite.label} when route complete, reserve threshold reached, or operator commands RTB.`
        : scenario.rechargeStations?.length
          ? `RTB or divert to the next forward ${scenario.rechargeStations[0].road} recharge station when route complete, reserve threshold reached, or operator commands RTB.`
          : 'RTB to assigned base or recharge station when route complete, battery threshold reached, or operator commands RTB.',
    }
  }

  return briefs
}

function deriveOperationalFeatures(scenario: ScenarioConfig, routes: Record<string, import('@/types').Waypoint[]>): OperationalFeature[] {
  const features: OperationalFeature[] = [
    {
      id: `${scenario.id}-base`,
      type: 'standoff',
      label: 'Primary safe staging point',
      points: [scenario.startPosition],
      priority: 'routine',
    },
  ]

  Object.entries(scenario.launchSites ?? {}).forEach(([droneId, site]) => {
    features.push({
      id: `${scenario.id}-${droneId}-launch-site`,
      type: site.kind === 'vessel' ? 'shoreline' : 'lz',
      label: `${droneId.toUpperCase()} launch: ${site.label}`,
      points: [site.position],
      priority: 'routine',
    })
  })

  Object.entries(scenario.recoverySites ?? {}).forEach(([droneId, site]) => {
    features.push({
      id: `${scenario.id}-${droneId}-recovery-site`,
      type: site.kind === 'vessel' ? 'shoreline' : 'lz',
      label: `${droneId.toUpperCase()} recovery: ${site.label}`,
      points: [site.position],
      priority: site.isPrimaryRecovery ? 'advisory' : 'routine',
    })
  })

  if (scenario.searchArea && scenario.searchArea.length >= 3) {
    features.push({
      id: `${scenario.id}-search-area`,
      type: 'search_sector',
      label: 'Primary search sector',
      points: scenario.searchArea,
      priority: 'advisory',
    })
  }

  scenario.geofences.forEach((gf) => {
    features.push({
      id: gf.id,
      type: gf.type === 'no_fly' ? 'hazard' : 'standoff',
      label: gf.label,
      points: gf.polygon,
      priority: gf.bypassForMission ? 'advisory' : 'urgent',
    })
  })

  scenario.heatSources.slice(0, 3).forEach((source) => {
    features.push({
      id: `${scenario.id}-${source.id}`,
      type: source.class === 'vehicle' ? 'gate' : 'last_known',
      label: source.class === 'vehicle' ? `Vehicle/contact cue ${source.id}` : `Last known/contact cue ${source.id}`,
      points: [source.position],
      priority: 'advisory',
    })
  })

  scenario.rechargeStations?.forEach((station) => {
    features.push({
      id: station.id,
      type: 'recharge_station',
      label: station.label,
      points: [station.position],
      priority: station.priority ?? 'advisory',
    })
  })

  Object.entries(routes).forEach(([droneId, route]) => {
    if (route.length === 0) return
    const brief = scenario.perDroneMissionRoles?.[droneId] ?? ''
    const type = brief.toLowerCase().includes('relay') ? 'relay' : featureTypeFor(scenario)
    features.push({
      id: `${scenario.id}-${droneId}-route`,
      type,
      label: `${droneId.toUpperCase()} tactical route`,
      points: route.map((wp) => wp.position),
      priority: 'routine',
    })
  })

  return features
}

function deriveAgencies(scenario: ScenarioConfig): string[] {
  const text = `${scenario.name} ${scenario.description}`
  const found = KNOWN_AGENCIES.filter((agency) =>
    new RegExp(`\\b${agency.replace(/ /g, '\\s+')}\\b`, 'i').test(text),
  )
  if (found.length > 0) return [...found]
  // Fall back to the name prefix only when it looks like an actual org token (short, no dashes).
  const first = scenario.name.split(/[—-]/)[0]?.trim()
  if (first && first.length <= 12 && /^[A-Z0-9 /]+$/.test(first)) {
    return first.split('/').map((a) => a.trim()).filter(Boolean)
  }
  return ['UAS OPERATIONS']
}

function primaryAgencyFor(scenario: ScenarioConfig): string {
  return deriveAgencies(scenario)[0]?.toUpperCase() ?? 'UAS OPERATIONS'
}

function firstSentence(text: string): string {
  return text.split(/[.!?]/)[0]?.trim() || text
}

function missionClassFor(scenario: ScenarioConfig): string {
  const text = `${scenario.name} ${scenario.description}`.toLowerCase()
  if (text.includes('sar') || text.includes('missing') || text.includes('search')) return 'search-and-rescue'
  if (text.includes('pursuit') || text.includes('suspect') || text.includes('vehicle')) return 'pursuit/locate'
  if (text.includes('fire')) return 'wildfire reconnaissance'
  if (text.includes('hazmat') || text.includes('chemical')) return 'hazmat reconnaissance'
  if (text.includes('perimeter') || text.includes('security')) return 'perimeter security'
  if (text.includes('welfare') || text.includes('hurricane') || text.includes('usar')) return 'disaster/welfare response'
  return scenario.missionType.replace(/_/g, ' ')
}

function primaryObjectiveFor(scenario: ScenarioConfig): string {
  const missionClass = missionClassFor(scenario)
  if (missionClass.includes('search')) return 'Locate simulated persons or vessels, cue rescue resources, and clear assigned probability sectors.'
  if (missionClass.includes('pursuit')) return 'Maintain safe aerial observation, support route handoffs, and cue ground units to last known location.'
  if (missionClass.includes('wildfire')) return 'Map fire edge, identify spotfires, and maintain standoff from the active column.'
  if (missionClass.includes('hazmat')) return 'Characterize the simulated source, track plume sectors, and maintain hot-zone standoff.'
  if (missionClass.includes('perimeter')) return 'Maintain layered standoff coverage of gates, protected assets, and perimeter chokepoints.'
  return 'Complete assigned drone sectors while preserving safety, evidence, and recovery discipline.'
}

function defaultRoleFor(scenario: ScenarioConfig, index: number): string {
  const roles = ['Primary sector', 'Secondary sector', 'Overwatch relay', 'Forward intercept', 'Perimeter support', 'Reserve support', 'North sector', 'C2 relay']
  return `${roles[index] ?? 'Mission support'} - ${missionClassFor(scenario)}`
}

function routePatternFor(scenario: ScenarioConfig, role: string): string {
  // Match on the DRONE'S ROLE first — matching free scenario text here once mislabeled a
  // primary search drone as a "relay hold" because the description mentioned a relay drone.
  const r = role.toLowerCase()
  if (r.includes('relay') || r.includes('c2')) return 'High standoff relay hold with short reposition legs.'
  if (r.includes('intercept') || r.includes('shadow') || r.includes('pursuit')) return 'Corridor-following pursuit shadow/intercept route.'
  if (r.includes('perimeter') || r.includes('gate') || r.includes('seal')) return 'Layered perimeter/standoff observation loop.'
  if (r.includes('overwatch') || r.includes('standoff')) return 'Elevated overwatch orbit with standoff spacing.'

  // Otherwise describe the pattern by mission class (a scenario-level property).
  const missionClass = missionClassFor(scenario)
  if (missionClass.includes('search')) return 'Patterned search sweep around last-known and probability-sector cues.'
  if (missionClass.includes('pursuit')) return 'Corridor-following pursuit shadow/intercept route.'
  if (missionClass.includes('perimeter')) return 'Layered perimeter/standoff observation loop.'
  if (missionClass.includes('wildfire') || missionClass.includes('hazmat')) return 'Hazard standoff lane with flank or plume-edge checks.'
  return 'Mission-specific corridor route with standoff turns and RTB recovery.'
}

function featureTypeFor(scenario: ScenarioConfig): OperationalFeature['type'] {
  const text = `${scenario.name} ${scenario.description}`.toLowerCase()
  if (text.includes('bridge')) return 'bridge'
  if (text.includes('beach') || text.includes('coastal')) return 'shoreline'
  if (text.includes('fire')) return 'fireline'
  if (text.includes('perimeter') || text.includes('port')) return 'perimeter'
  if (text.includes('street') || text.includes('pursuit') || text.includes('vehicle')) return 'street'
  return 'search_sector'
}

function isCityScenario(scenario: ScenarioConfig): boolean {
  return /\b(SFPD|OPD|CHP|BART PD|LAPD|NYPD|ATF|DMH|Oakland|Hollywood|Times Square|Seattle|SF|city|urban|hotel|BART)\b/i
    .test(`${scenario.name} ${scenario.description}`)
}

function isMaritimeScenario(scenario: ScenarioConfig): boolean {
  return /\b(USCG|coastal|harbor|marine|vessel|bay|swimmer|shoreline|port)\b/i.test(`${scenario.name} ${scenario.description}`)
}

function localDispatchSourcesFor(scenario: ScenarioConfig): string[] {
  const text = `${scenario.name} ${scenario.description}`
  if (/NYPD|Times Square/i.test(text)) return ['NYPD DISPATCH', 'FDNY DISPATCH']
  if (/LAPD|Hollywood/i.test(text)) return ['LAPD DISPATCH', 'LAFD DISPATCH']
  if (/SFPD|OPD|CHP|BART PD|SF|Oakland/i.test(text)) return ['SFPD DISPATCH', 'OPD DISPATCH']
  if (/USCG|coastal|harbor|marine|vessel/i.test(text)) return ['USCG SECTOR', 'HARBOR OPS']
  if (/fire|wildfire/i.test(text)) return ['FIRE OPS', 'ICP']
  if (/FEMA|hurricane|USAR|welfare/i.test(text)) return ['ICP', 'FEMA LIAISON']
  if (/CBP|Border|Rio Grande|Eagle Pass/i.test(text)) return ['CBP DISPATCH', 'FEDERAL LIAISON']
  if (/ATF/i.test(text)) return ['ATF DISPATCH', 'FEDERAL LIAISON']
  return ['LOCAL DISPATCH', 'ICP']
}

function supportDispatchSourceFor(scenario: ScenarioConfig): string {
  const text = `${scenario.name} ${scenario.description}`.toLowerCase()
  if (text.includes('uscg') || text.includes('harbor') || text.includes('coastal')) return 'USCG SECTOR'
  if (text.includes('fire')) return 'FIRE OPS'
  if (text.includes('fema') || text.includes('hurricane') || text.includes('usar')) return 'ICP'
  if (text.includes('cbp') || text.includes('atf')) return 'FEDERAL LIAISON'
  return 'ICP'
}

function leadFieldUnitFor(scenario: ScenarioConfig): string {
  const text = `${scenario.name} ${scenario.description}`
  if (/police|SFPD|OPD|LAPD|NYPD|officer|pursuit|suspect/i.test(text)) return 'Officer unit'
  if (/USCG|harbor|vessel|coastal/i.test(text)) return 'Harbor unit'
  if (/fire|wildfire|hazmat/i.test(text)) return 'Fire unit'
  if (/FEMA|USAR|welfare|hurricane/i.test(text)) return 'Ground team'
  return 'Responding unit'
}

