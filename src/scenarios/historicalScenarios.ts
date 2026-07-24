import { capRouteDwells, offsetM, parallelLanes, relayRoute } from '@/scenarios/scenarioBuilder'
import { mixedFleet } from '@/scenarios/platformAssignments'
import type { BacktestAnchor, HistoricalCase, ScenarioConfig } from '@/types'

function histCase(partial: HistoricalCase): HistoricalCase {
  return partial
}

function anchors(items: BacktestAnchor[]): BacktestAnchor[] {
  return items
}

function baseHistorical(
  id: string,
  name: string,
  description: string,
  seed: number,
  origin: { lat: number; lng: number },
  missionClass: ScenarioConfig['missionClass'],
  agencies: string[],
  historicalCase: HistoricalCase,
  backtestAnchors: BacktestAnchor[],
  extras: Partial<ScenarioConfig> = {},
): ScenarioConfig {
  const droneCount = extras.droneCount ?? 4
  const routes = extras.perDroneWaypoints ?? parallelLanes(origin, droneCount, 130, 650, id.slice(0, 8), 120)
  return {
    id,
    name,
    description: `${description} SIMULATION ONLY — capability analysis only; no real victim names or addresses.`,
    seed,
    droneCount,
    missionClass,
    agencies,
    historicalCase,
    backtestAnchors,
    dronePlatforms: mixedFleet(droneCount, 'skydio_x10d', 'freefly_astro_max'),
    missionType: 'waypoint',
    startPosition: origin,
    waypoints: [],
    perDroneWaypoints: capRouteDwells(routes),
    geofences: extras.geofences ?? [],
    heatSources: extras.heatSources ?? [
      { id: `${id}-hs-a`, class: 'generic-person', position: offsetM(origin, 90, 180), tempC: 36, radiusM: 2 },
    ],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.02,
    commsLossWindows: extras.commsLossWindows ?? [{ startSec: 80, durationSec: 18 }],
    authorizationProfile: extras.authorizationProfile,
    terrainFixtureId: extras.terrainFixtureId,
    perDroneMissionRoles: extras.perDroneMissionRoles,
    ...extras,
  }
}

const kilauea = baseHistorical(
  'hist_kilauea_leilani_2018',
  'HIST — Kīlauea Leilani Estates Guidance (2018)',
  'USGS/DOI UAS team models precision lava-front tracking and resident guidance along Luana Street during the 2018 lower East Rift Zone eruption. Response window T+48h after initial fissure activity.',
  30001,
  { lat: 19.469, lng: -154.917 },
  'volcanic_response',
  ['USGS', 'USGS HVO', 'Hawaii County'],
  histCase({
    eventName: 'Kīlauea lower East Rift Zone — Leilani Estates',
    eventDate: '2018-05-27',
    location: 'Leilani Estates, Hawaiʻi Island',
    responseWindow: 'T+48 hours — guided extraction window',
    humanCostSummary: 'Major evacuations; structures destroyed by lava flows.',
    situation:
      'Fast-moving pāhoehoe breakout threatened a trapped resident; UAS provided live video to the county EOC and guided extraction.',
    capabilityGap: 'Ground teams lacked real-time lava-front geometry at night.',
    documentedContribution:
      'Documented UAS guidance of a resident using a phone flashlight; live feed informed evacuation decisions.',
    sources: [
      { label: 'USGS — Kīlauea UAS rescue mission', url: 'https://www.usgs.gov/media/videos/kilauea-volcano-uas-mission-aid-rescue' },
    ],
    instructorNotes: 'Emphasize moving geofence (lava front) and night precision guidance — not pursuit.',
    discussionPrompts: [
      'How would you score time-to-first-contact vs the documented extraction?',
      'What altitude band keeps LOS to EOC while staying clear of gas plumes?',
    ],
  }),
  anchors([
    { id: 'time-to-contact', label: 'Time to first thermal contact', unit: 'min', documentedValue: 12, description: 'Representative EOC reporting cadence from public accounts.' },
    { id: 'sectors-mapped', label: 'Lava-front sectors mapped per hour', unit: 'sectors/hr', documentedValue: 2, description: 'Approximate mapping cadence for moving geofence updates.' },
  ]),
  {
    geofences: [{
      id: 'gf-kilauea-lava',
      label: 'Active Lava Channel — No Fly',
      polygon: [
        { lat: 19.468, lng: -154.918 },
        { lat: 19.468, lng: -154.915 },
        { lat: 19.471, lng: -154.915 },
        { lat: 19.471, lng: -154.918 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    }],
    authorizationProfile: {
      kind: 'field_incident_command',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'night_ops'],
      label: 'Volcanic incident airspace',
      reference: 'Night volcanic response coordination.',
    },
  },
)

const oso = baseHistorical(
  'hist_oso_sr530_2014',
  'HIST — Oso SR-530 Landslide Recon (2014)',
  'CRASAR-style sUAS recon over the SR-530 debris field — responder-safety hazard monitoring and rapid area mapping.',
  30002,
  { lat: 48.283, lng: -121.849 },
  'landslide_monitoring',
  ['CRASAR', 'USGS', 'Snohomish County'],
  histCase({
    eventName: 'Oso / SR-530 landslide',
    eventDate: '2014-03-22',
    location: 'Oso, Washington',
    responseWindow: 'T+24 hours — primary debris assessment',
    humanCostSummary: 'Deadliest US landslide on record.',
    situation: 'Responders needed rapid debris-field mapping to judge secondary slide risk.',
    capabilityGap: 'Manned aircraft could not safely provide persistent low-altitude recon.',
    documentedContribution: 'Public literature cites ~30–40 acres mapped in under an hour from low altitude.',
    sources: [
      { label: 'Murphy et al. — SR-530 UAS recon', url: 'https://onlinelibrary.wiley.com/doi/abs/10.1002/rob.21586' },
      { label: 'USGS — Oso landslide', url: 'https://www.usgs.gov/news/featured-story/five-years-later-oso-sr-530-landslide-washington' },
    ],
  }),
  anchors([
    { id: 'area-rate', label: 'Area mapped per hour', unit: 'acres/hr', documentedValue: 30, description: 'Documented AirRobot coverage rate from after-action literature.' },
    { id: 'altitude', label: 'Mapping altitude', unit: 'ft AGL', documentedValue: 140, description: 'Representative CRASAR flight altitude.' },
  ]),
  { terrainFixtureId: 'hist_oso_sr530_2014' },
)

const harvey = baseHistorical(
  'hist_harvey_houston_2017',
  'HIST — Hurricane Harvey TFR Deconfliction (2017)',
  'Houston/Buffalo Bayou flood response under active TFR with manned SAR helicopters — airspace coordination exercise.',
  30003,
  { lat: 29.760, lng: -95.370 },
  'flood_response',
  ['FEMA', 'FAA', 'USCG'],
  histCase({
    eventName: 'Hurricane Harvey — Houston flood response',
    eventDate: '2017-08-28',
    location: 'Houston, Texas',
    responseWindow: 'T+72 hours — peak UAS authorization surge',
    humanCostSummary: 'Catastrophic flooding across the Houston metro.',
    situation: 'FAA issued dozens of disaster UAS authorizations under active TFRs alongside manned rescue.',
    capabilityGap: 'Operators lacked practice deconflicting rotor-wing SAR corridors.',
    documentedContribution: 'FAA reported 43+ authorizations by 31 Aug 2017, rising to 137+ by mid-September.',
    sources: [
      { label: 'FAA — disaster UAS authorizations', url: 'https://medium.com/faa/drone-authorizations-soar-through-hurricanes-wildfires-8548ea4a2c75' },
      { label: 'PLOS One — 2017 hurricane UAS assessment', url: 'https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0227808' },
    ],
  }),
  anchors([
    { id: 'auth-count', label: 'UAS authorizations (first week)', unit: 'authorizations', documentedValue: 43, description: 'FAA-published authorization count by 31 Aug 2017.' },
    { id: 'sector-coverage', label: 'Flood sectors cleared before dark', unit: 'sectors', documentedValue: 3, description: 'Operator target for parallel bayou lanes.' },
  ]),
  {
    perDroneWaypoints: {
      ...parallelLanes({ lat: 29.760, lng: -95.370 }, 3, 140, 700, 'harv', 120),
      'uav-04': relayRoute({ lat: 29.762, lng: -95.368 }, 500, 'harv-04', 200),
    },
    authorizationProfile: {
      kind: 'field_incident_command',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'tfr_conflict_ack'],
      label: 'Harvey-class TFR coordination',
      reference: 'Disaster TFR with manned SAR deconfliction.',
      tfrExercise: {
        id: 'tfr-harvey-houston',
        label: 'Harvey TFR / manned SAR corridor',
        summary: 'Acknowledge TFR and rotor-wing rescue corridors before flood-sector entry.',
        requireAcknowledgment: true,
      },
    },
    commsLossWindows: [{ startSec: 70, durationSec: 30 }, { startSec: 280, durationSec: 22 }],
  },
)

const campFire = baseHistorical(
  'hist_camp_fire_paradise_2018',
  'HIST — Camp Fire Paradise Mapping (2018)',
  'Two-phase wildfire response: evacuation-corridor overwatch then systematic post-fire grid mapping over Paradise.',
  30004,
  { lat: 39.759, lng: -121.622 },
  'wildfire_recon',
  ['CAL FIRE', 'USFS', 'FEMA'],
  histCase({
    eventName: 'Camp Fire — Paradise, California',
    eventDate: '2018-11-12',
    location: 'Paradise, California',
    responseWindow: 'T+96 hours — systematic mapping phase',
    humanCostSummary: '85 fatalities; 18,000+ structures destroyed.',
    situation: 'Coordinated multi-agency drone mapping produced massive orthomosaic coverage.',
    capabilityGap: 'Ground teams could not safely enter wide areas for systematic damage assessment.',
    documentedContribution: 'Public reports cite 518 mapping flights, 70k images, 17k acres — largest coordinated drone disaster response of its era.',
    sources: [
      { label: 'sUAS News — Camp Fire mapping lessons', url: 'https://www.suasnews.com/2019/01/mapping-camp-fire-with-drones-lessons-learnt/' },
      { label: 'NBC Bay Area — Paradise mapping', url: 'https://www.nbcbayarea.com/news/local/how-a-squadron-of-drones-mapped-the-entire-paradise-camp-fire-zone-in-two-days/201896/' },
    ],
  }),
  anchors([
    { id: 'flights', label: 'Mapping flights (documented campaign)', unit: 'flights', documentedValue: 518, description: 'Public after-action mapping flight count.' },
    { id: 'acre-rate', label: 'Acres mapped per day', unit: 'acres/day', documentedValue: 8500, description: 'Approximate daily mapping throughput.' },
  ]),
  { terrainFixtureId: 'hist_camp_fire_paradise_2018', droneCount: 5 },
)

const surfside = baseHistorical(
  'hist_surfside_cts_2021',
  'HIST — Surfside Champlain Towers Collapse (2021)',
  'Structured-collapse revisit cadence with multi-operator deconfliction and void-space thermal search.',
  30005,
  { lat: 25.887, lng: -80.122 },
  'structural_collapse',
  ['FDNY', 'FEMA', 'MDFR'],
  histCase({
    eventName: 'Champlain Towers South collapse — Surfside',
    eventDate: '2021-06-24',
    location: 'Surfside, Florida',
    responseWindow: 'T+12 hours — daylight orthomosaic cadence begins',
    humanCostSummary: 'Partial collapse with prolonged USAR response.',
    situation: 'Teams flew 300+ sorties with 2–4 hour orthomosaic revisit in daylight.',
    capabilityGap: 'Single-site multi-operator coordination and TFR management.',
    documentedContribution: 'Public sources cite 300+ flights and 2–4 hour orthomosaic cadence in the first two weeks.',
    sources: [
      { label: 'NIST — Champlain Towers study', url: 'https://www.nist.gov/disaster-and-failure-studies/champlain-towers-south-collapse' },
      { label: 'Firehouse — drones at Surfside', url: 'https://www.firehouse.com/technology/drones/article/21260858/fire-technology-champlain-towers-south-collapse-drones-value-soars' },
    ],
  }),
  anchors([
    { id: 'revisit', label: 'Orthomosaic revisit cadence', unit: 'hours', documentedValue: 3, description: 'Documented daylight revisit interval.' },
    { id: 'flights', label: 'Total UAS flights (response phase)', unit: 'flights', documentedValue: 300, description: 'Public flight-count estimate.' },
  ]),
  {
    droneCount: 5,
    terrainFixtureId: 'hist_surfside_cts_2021',
    perDroneWaypoints: capRouteDwells(parallelLanes({ lat: 25.887, lng: -80.122 }, 5, 80, 400, 'surf', 90)),
    geofences: [{
      id: 'gf-surf-pile',
      label: 'Collapse Pile — Standoff',
      polygon: [
        { lat: 25.886, lng: -80.123 },
        { lat: 25.886, lng: -80.121 },
        { lat: 25.888, lng: -80.121 },
        { lat: 25.888, lng: -80.123 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    }],
  },
)

const helene = baseHistorical(
  'hist_helene_asheville_2024',
  'HIST — Hurricane Helene Asheville Comms Denial (2024)',
  'Mountain SAR with total comms failure — relay placement and SD-card-only data path exercise.',
  30006,
  { lat: 35.595, lng: -82.551 },
  'disaster_response',
  ['Asheville PD', 'FEMA', 'NCEM'],
  histCase({
    eventName: 'Hurricane Helene — Asheville / Swannanoa',
    eventDate: '2024-09-27',
    location: 'Asheville, North Carolina',
    responseWindow: 'T+48 hours — cut-off community access',
    humanCostSummary: 'Widespread infrastructure failure across western NC.',
    situation: 'Cellular, fiber, and radio failed; thermal SAR reached terrain ground teams could not.',
    capabilityGap: 'Comms-denied mountain SAR with relay placement.',
    documentedContribution: 'Public reports describe thermal night SAR and private heavy-lift supply runs to cut-off communities.',
    sources: [
      { label: 'DroneLife — Helene UAV response', url: 'https://dronelife.com/2025/03/11/lessons-from-hurricane-helene-how-uavs-supported-emergency-response-in-western-north-carolina/' },
    ],
  }),
  anchors([
    { id: 'comms-out', label: 'Comms denial duration modeled', unit: 'min', documentedValue: 45, description: 'Simulated total C2 outage window.' },
    { id: 'relay-hops', label: 'Relay reposition events', unit: 'events', documentedValue: 2, description: 'Target relay legs to restore LOS.' },
  ]),
  {
    terrainFixtureId: 'hist_helene_asheville_2024',
    perDroneWaypoints: {
      ...parallelLanes({ lat: 35.595, lng: -82.551 }, 3, 150, 800, 'hel', 140),
      'uav-04': relayRoute({ lat: 35.597, lng: -82.549 }, 600, 'hel-04', 220),
    },
    commsLossWindows: [{ startSec: 30, durationSec: 45 }, { startSec: 200, durationSec: 35 }],
  },
)

const katrina = baseHistorical(
  'hist_katrina_lower_ninth_2005',
  'HIST — Katrina Lower Ninth Triage (2005)',
  'Large-area rooftop triage under endurance constraints — coverage rate, not sensor quality, is binding.',
  30007,
  { lat: 29.964, lng: -90.067 },
  'flood_response',
  ['FEMA', 'USCG', 'NWS'],
  histCase({
    eventName: 'Hurricane Katrina — Lower Ninth Ward / 17th Street Canal',
    eventDate: '2005-08-29',
    location: 'New Orleans, Louisiana',
    responseWindow: 'T+72 hours — flooded-city triage window',
    humanCostSummary: 'Catastrophic levee failures and prolonged flooding.',
    situation: 'Rooftop survivor triage took days across a flooded city with collapsed comms.',
    capabilityGap: 'No persistent aerial triage at scale — endurance and coverage rate dominated.',
    documentedContribution: 'Counterfactual backtest — operators supply capability that did not exist at scale in 2005.',
    sources: [
      { label: 'FAA — disaster UAS authorizations (Harvey precedent policy)', url: 'https://medium.com/faa/drone-authorizations-soar-through-hurricanes-wildfires-8548ea4a2c75' },
    ],
    instructorNotes: 'Handle with care — capability gap framing only, never blame assignment.',
  }),
  anchors([
    { id: 'rooftops-hr', label: 'Rooftop sectors triaged per hour', unit: 'sectors/hr', documentedValue: 4, description: 'Operator target under endurance budget.' },
    { id: 'coverage', label: 'AO fraction covered before RTB', unit: 'percent', documentedValue: 35, description: 'Realistic partial coverage under battery limits.' },
  ]),
  { droneCount: 5, commsLossWindows: [{ startSec: 50, durationSec: 40 }] },
)

const joplin = baseHistorical(
  'hist_joplin_ef5_2011',
  'HIST — Joplin EF-5 Damage Path (2011)',
  'Linear tornado damage-path grid with structured sector assignment (NIST SP-1139 aligned).',
  30008,
  { lat: 37.084, lng: -94.513 },
  'tornado_damage',
  ['FEMA', 'NIST'],
  histCase({
    eventName: 'Joplin EF-5 tornado',
    eventDate: '2011-05-22',
    location: 'Joplin, Missouri',
    responseWindow: 'T+24 hours — damage path assessment',
    humanCostSummary: '161 fatalities; thousands of structures on a defined damage path.',
    situation: 'NIST technical investigation documented linear damage swath requiring sectorized search.',
    capabilityGap: 'Rapid damage-path segmentation from the air.',
    documentedContribution: 'Counterfactual — structured aerial sector assignment against NIST-documented path geometry.',
    sources: [
      { label: 'NIST SP-1139 — Joplin tornado', url: 'https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.1139.pdf' },
    ],
  }),
  anchors([
    { id: 'path-km', label: 'Damage path length', unit: 'km', documentedValue: 35, description: 'NIST-documented approximate path scale.' },
    { id: 'sectors', label: 'Sectors assigned before dark', unit: 'sectors', documentedValue: 4, description: 'Operator sector-coverage target.' },
  ]),
)

const marshall = baseHistorical(
  'hist_marshall_fire_2021',
  'HIST — Marshall Fire No-Launch Decision (2021)',
  'Wind-driven urban conflagration — correct answer partly includes refusing to launch. Peak-wind day preserved intentionally.',
  30009,
  { lat: 39.959, lng: -105.165 },
  'wildfire_recon',
  ['CAL FIRE', 'FEMA'],
  histCase({
    eventName: 'Marshall Fire — Boulder County',
    eventDate: '2021-12-30',
    location: 'Superior / Louisville, Colorado',
    responseWindow: 'Peak wind hours — intentional no-launch lesson',
    humanCostSummary: 'Wind-driven urban conflagration destroyed 1,000+ structures.',
    situation: 'Extreme winds largely precluded safe UAS flight during peak spread.',
    capabilityGap: 'Operators must recognize when weather correctly grounds the fleet.',
    documentedContribution: 'Teaches refusal discipline — documented ERA5 winds may close launch bays by design.',
    sources: [
      { label: 'Representative wildfire weather doctrine (Fort Myers/Ian precedent)', url: 'https://www.nbcbayarea.com/news/local/how-a-squadron-of-drones-mapped-the-entire-paradise-camp-fire-zone-in-two-days/201896/' },
    ],
    instructorNotes: 'Marshall keeps peak-wind conditions — launch refusal IS the realism.',
  }),
  anchors([
    { id: 'wind-gust', label: 'Peak gust threshold', unit: 'kts', documentedValue: 30, description: 'Launch-bay closing gust reference.' },
    { id: 'safe-hold', label: 'Fleet held on ground', unit: 'boolean', documentedValue: 1, description: '1 = correct no-launch when bays closed.' },
  ]),
)

const eastPalestine = baseHistorical(
  'hist_east_palestine_2023',
  'HIST — East Palestine Rail Hazmat (2023)',
  'Vinyl-chloride release — plume standoff, evacuation support, and persistent culvert monitoring.',
  30010,
  { lat: 40.834, lng: -80.541 },
  'hazmat_recon',
  ['EPA', 'FEMA', 'NTSB'],
  histCase({
    eventName: 'East Palestine train derailment',
    eventDate: '2023-02-03',
    location: 'East Palestine, Ohio',
    responseWindow: 'T+48 hours — plume mapping and monitoring',
    humanCostSummary: 'Hazmat release with community evacuation and long-tail environmental monitoring.',
    situation: 'EPA used daily drone mapping and robotic culvert surveys through the response tail.',
    capabilityGap: 'Persistent plume standoff and multi-day monitoring cadence.',
    documentedContribution: 'Public EPA updates describe daily aerial mapping during the response.',
    sources: [
      { label: 'US EPA — East Palestine operational updates', url: 'https://www.epa.gov/east-palestine-oh-train-derailment/operational-updates' },
    ],
  }),
  anchors([
    { id: 'plume-sectors', label: 'Downwind plume sectors tracked', unit: 'sectors', documentedValue: 3, description: 'Minimum plume-edge characterization target.' },
    { id: 'standoff', label: 'Hot-zone standoff maintained', unit: 'm', documentedValue: 150, description: 'Minimum standoff from simulated source.' },
  ]),
  {
    authorizationProfile: {
      kind: 'field_incident_command',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'hot_zone_ack'],
      label: 'Hazmat rail incident coordination',
      reference: 'EPA/NTSB airspace coordination for hazmat standoff.',
    },
    geofences: [{
      id: 'gf-ep-hot',
      label: 'Vent Stack Hot Zone',
      polygon: [
        { lat: 40.833, lng: -80.542 },
        { lat: 40.833, lng: -80.540 },
        { lat: 40.835, lng: -80.540 },
        { lat: 40.835, lng: -80.542 },
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    }],
  },
)

export const HISTORICAL_SCENARIOS: ScenarioConfig[] = [
  kilauea,
  oso,
  harvey,
  campFire,
  surfside,
  helene,
  katrina,
  joplin,
  marshall,
  eastPalestine,
]
