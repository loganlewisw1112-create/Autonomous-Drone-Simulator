import { demoBasic, demoSAR } from '@/scenarios/demoBasic'
import { sarCoastal, portPerimeter, wildfireRecon } from '@/scenarios/demoScenarios'
import {
  calFireDixieComplex,
  dhsPortLAChemical,
  lapdSkidRowWelfare,
  uscgCapeCodeSAR,
} from '@/scenarios/extremeScenarios'
import { capRouteDwells, offsetM, parallelLanes, relayRoute, refreshScenario } from '@/scenarios/scenarioBuilder'
import { mixedFleet } from '@/scenarios/platformAssignments'
import type { ScenarioConfig } from '@/types'

const uscgMaritime = refreshScenario(uscgCapeCodeSAR, {
  id: 'train_uscg_maritime_sar',
  name: 'USCG — Atlantic Mariner SAR (Training)',
  missionClass: 'maritime_sar',
  agencies: ['USCG'],
  perDroneWaypoints: capRouteDwells({
    ...uscgCapeCodeSAR.perDroneWaypoints!,
    'uav-05': relayRoute({ lat: 41.6755, lng: -70.2845 }, 400, 'uscg-05', 250),
  }),
})

const hazmatPlume = refreshScenario(dhsPortLAChemical, {
  id: 'train_hazmat_plume',
  name: 'LAFD / USCG — Port Hazmat Plume (Training)',
  missionClass: 'hazmat_recon',
  agencies: ['LAFD', 'USCG', 'DHS'],
  authorizationProfile: {
    kind: 'field_incident_command',
    requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'hot_zone_ack'],
    label: 'Hazmat incident airspace coordination',
    reference: 'Simulated ICS airspace cell for hot-zone standoff drills.',
  },
  perDroneWaypoints: capRouteDwells({
    ...dhsPortLAChemical.perDroneWaypoints!,
    'uav-05': relayRoute({ lat: 33.7335, lng: -118.2698 }, 350, 'dhs-05', 240),
  }),
})

const welfareGrid = refreshScenario(lapdSkidRowWelfare, {
  id: 'train_welfare_grid',
  name: 'LAPD / LAHSA — Heat Welfare Grid (Training)',
  missionClass: 'welfare_response',
  agencies: ['LAPD', 'LAHSA', 'LA County DMH'],
})

const wildfireFlank = refreshScenario(calFireDixieComplex, {
  id: 'train_wildfire_flank',
  name: 'CAL FIRE / USFS — Wildfire Flank Recon (Training)',
  missionClass: 'wildfire_recon',
  agencies: ['CAL FIRE', 'USFS'],
  terrainFixtureId: 'train_wildfire_flank',
})

const mountainOrigin = { lat: 39.7392, lng: -104.9903 }
const trainMountainSar: ScenarioConfig = {
  id: 'train_mountain_sar',
  name: 'SAR — Mountain Trail Missing Hiker',
  description:
    'Front Range SAR teams deploy three drones along a ridgeline search corridor after a missing hiker report. '
    + 'Terrain masking and altitude discipline required. SIMULATION ONLY.',
  seed: 21001,
  droneCount: 3,
  missionClass: 'search_rescue',
  agencies: ['SAR', 'USFS'],
  dronePlatforms: mixedFleet(3, 'skydio_x10d'),
  missionType: 'waypoint',
  startPosition: mountainOrigin,
  waypoints: [],
  perDroneWaypoints: parallelLanes(mountainOrigin, 3, 120, 600, 'mtn', 160),
  geofences: [
    {
      id: 'gf-mtn-cliff',
      label: 'Cliff Drop — Restricted',
      polygon: [
        offsetM(mountainOrigin, 200, -200),
        offsetM(mountainOrigin, 200, 200),
        offsetM(mountainOrigin, 400, 200),
        offsetM(mountainOrigin, 400, -200),
      ],
      maxAltitudeFt: 100,
      type: 'restricted',
    },
  ],
  heatSources: [
    { id: 'hs-mtn-person', class: 'generic-person', position: offsetM(mountainOrigin, 180, 120), tempC: 36, radiusM: 2 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.018,
  commsLossWindows: [{ startSec: 120, durationSec: 20 }],
  terrainFixtureId: 'train_mountain_sar',
}

const floodOrigin = { lat: 29.763, lng: -95.365 }
const trainFloodCorridor: ScenarioConfig = {
  id: 'train_flood_corridor',
  name: 'FEMA — Urban Flood Corridor Triage',
  description:
    'Post-storm urban flood corridor search along Buffalo Bayou-style waterways. '
    + 'Four drones sweep parallel blocks while a relay maintains LOS to a field ICP. SIMULATION ONLY.',
  seed: 21002,
  droneCount: 4,
  missionClass: 'flood_response',
  agencies: ['FEMA', 'USCG', 'NWS'],
  dronePlatforms: mixedFleet(4, 'skydio_x10d', 'freefly_astro_max'),
  missionType: 'waypoint',
  startPosition: floodOrigin,
  waypoints: [],
  perDroneWaypoints: {
    ...parallelLanes(floodOrigin, 3, 140, 700, 'fld', 120),
    'uav-04': relayRoute(offsetM(floodOrigin, 0, -300), 500, 'fld-04', 200),
  },
  geofences: [
    {
      id: 'gf-fld-helo',
      label: 'Manned SAR Helo Corridor',
      polygon: [
        offsetM(floodOrigin, -150, -250),
        offsetM(floodOrigin, -150, 250),
        offsetM(floodOrigin, 150, 250),
        offsetM(floodOrigin, 150, -250),
      ],
      maxAltitudeFt: 200,
      type: 'restricted',
      bypassForMission: true,
    },
  ],
  heatSources: [
    { id: 'hs-fld-a', class: 'generic-person', position: offsetM(floodOrigin, 80, 200), tempC: 36, radiusM: 2 },
    { id: 'hs-fld-b', class: 'generic-person', position: offsetM(floodOrigin, -60, 320), tempC: 35, radiusM: 2 },
    { id: 'hs-fld-boat', class: 'vehicle', position: offsetM(floodOrigin, 40, -180), tempC: 28, radiusM: 5 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.02,
  commsLossWindows: [{ startSec: 90, durationSec: 25 }, { startSec: 300, durationSec: 20 }],
  authorizationProfile: {
    kind: 'field_incident_command',
    requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'tfr_conflict_ack'],
    label: 'Flood-response TFR coordination',
    reference: 'Practice manned-rescue deconfliction under an active disaster TFR.',
    tfrExercise: {
      id: 'tfr-flood-training',
      label: 'Disaster TFR / rotor-wing deconfliction',
      summary: 'Acknowledge temporary flight restrictions and manned rescue corridors before UAS entry.',
      requireAcknowledgment: true,
    },
  },
}

const usarOrigin = { lat: 37.8044, lng: -122.2712 }
const trainUrbanUsar: ScenarioConfig = {
  id: 'train_urban_usar',
  name: 'USAR — Urban Collapse Grid (Training)',
  description:
    'Urban USAR task force grids a simulated collapse zone with thermal void search and structure standoff. SIMULATION ONLY.',
  seed: 21003,
  droneCount: 4,
  missionClass: 'structural_collapse',
  agencies: ['FEMA', 'FDNY'],
  dronePlatforms: mixedFleet(4, 'skydio_x10d', 'freefly_astro_max'),
  missionType: 'waypoint',
  startPosition: usarOrigin,
  waypoints: [],
  perDroneWaypoints: parallelLanes(usarOrigin, 4, 100, 500, 'usar', 100),
  geofences: [
    {
      id: 'gf-usar-pile',
      label: 'Unstable Pile — No Fly',
      polygon: [
        offsetM(usarOrigin, 50, -80),
        offsetM(usarOrigin, 50, 80),
        offsetM(usarOrigin, 200, 80),
        offsetM(usarOrigin, 200, -80),
      ],
      maxAltitudeFt: 0,
      type: 'no_fly',
    },
  ],
  heatSources: [
    { id: 'hs-usar-void', class: 'generic-person', position: offsetM(usarOrigin, 120, 40), tempC: 36, radiusM: 1 },
    { id: 'hs-usar-debris', class: 'heat-source', position: offsetM(usarOrigin, 90, -30), tempC: 48, radiusM: 8 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.02,
  commsLossWindows: [{ startSec: 75, durationSec: 15 }],
}

const tornadoOrigin = { lat: 37.084, lng: -94.513 }
const trainTornadoSector: ScenarioConfig = {
  id: 'train_tornado_sector',
  name: 'NIST-Aligned — Tornado Damage Path Grid',
  description:
    'Linear EF-scale damage path grid search with sector assignment and triage-by-damage cues. SIMULATION ONLY.',
  seed: 21004,
  droneCount: 4,
  missionClass: 'tornado_damage',
  agencies: ['FEMA', 'NWS'],
  dronePlatforms: mixedFleet(4, 'skydio_x10'),
  missionType: 'waypoint',
  startPosition: tornadoOrigin,
  waypoints: [],
  perDroneWaypoints: parallelLanes(tornadoOrigin, 4, 150, 900, 'tor', 140),
  geofences: [],
  heatSources: [
    { id: 'hs-tor-a', class: 'generic-person', position: offsetM(tornadoOrigin, 100, 250), tempC: 36, radiusM: 2 },
    { id: 'hs-tor-b', class: 'generic-person', position: offsetM(tornadoOrigin, -80, 480), tempC: 35, radiusM: 2 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.019,
  commsLossWindows: [{ startSec: 60, durationSec: 18 }],
}

const nightOrigin = { lat: 47.606, lng: -122.332 }
const trainNightRelaySar: ScenarioConfig = {
  id: 'train_night_relay_sar',
  name: 'SAR — Night Urban Relay Search',
  description:
    'Night SAR with comms-degraded urban canyon — relay drone maintains C2 while search lanes work grid sectors. SIMULATION ONLY.',
  seed: 21005,
  droneCount: 4,
  missionClass: 'search_rescue',
  agencies: ['SAR', 'FDNY'],
  dronePlatforms: mixedFleet(4, 'skydio_x10d'),
  missionType: 'waypoint',
  startPosition: nightOrigin,
  waypoints: [],
  perDroneWaypoints: {
    ...parallelLanes(nightOrigin, 3, 130, 550, 'night', 120),
    'uav-04': relayRoute(offsetM(nightOrigin, 0, -200), 450, 'night-04', 220),
  },
  geofences: [],
  heatSources: [
    { id: 'hs-night', class: 'generic-person', position: offsetM(nightOrigin, 60, 180), tempC: 36, radiusM: 2 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.02,
  commsLossWindows: [{ startSec: 45, durationSec: 35 }, { startSec: 240, durationSec: 25 }],
  authorizationProfile: {
    kind: 'field_incident_command',
    requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'night_ops'],
    label: 'Night SAR authorization',
    reference: 'Night waiver and airspace coordination for urban SAR.',
  },
}

const bridgeOrigin = { lat: 37.798, lng: -122.377 }
const trainInfraInspection: ScenarioConfig = {
  id: 'train_infra_inspection',
  name: 'DOT — Bridge Approach Inspection',
  description:
    'Infrastructure inspection of a simulated bridge approach with standoff lanes and pier thermal scan. SIMULATION ONLY.',
  seed: 21006,
  droneCount: 3,
  missionClass: 'infrastructure_inspection',
  agencies: ['USGS', 'FEMA'],
  dronePlatforms: mixedFleet(3, 'skydio_x10'),
  missionType: 'inspection',
  startPosition: bridgeOrigin,
  waypoints: [],
  perDroneWaypoints: parallelLanes(bridgeOrigin, 3, 90, 400, 'br', 110),
  geofences: [
    {
      id: 'gf-br-traffic',
      label: 'Active Deck — Restricted',
      polygon: [
        offsetM(bridgeOrigin, -40, -120),
        offsetM(bridgeOrigin, -40, 120),
        offsetM(bridgeOrigin, 40, 120),
        offsetM(bridgeOrigin, 40, -120),
      ],
      maxAltitudeFt: 80,
      type: 'restricted',
    },
  ],
  heatSources: [
    { id: 'hs-br-spall', class: 'heat-source', position: offsetM(bridgeOrigin, 20, 60), tempC: 42, radiusM: 4 },
  ],
  batteryStartPct: 100,
  batteryDrainRatePerSec: 0.017,
  commsLossWindows: [],
}

export const TRAINING_SCENARIOS: ScenarioConfig[] = [
  { ...demoBasic, missionClass: 'training_basic', agencies: ['SFPD TRAINING'] },
  { ...demoSAR, missionClass: 'search_rescue', agencies: ['SAR', 'SFPD'] },
  { ...sarCoastal, missionClass: 'search_rescue', agencies: ['SAR', 'USCG'] },
  { ...portPerimeter, missionClass: 'perimeter_security', agencies: ['USCG', 'SFPD'] },
  { ...wildfireRecon, missionClass: 'wildfire_recon', agencies: ['CAL FIRE'], terrainFixtureId: 'demo_wildfire' },
  uscgMaritime,
  hazmatPlume,
  welfareGrid,
  wildfireFlank,
  trainMountainSar,
  trainFloodCorridor,
  trainUrbanUsar,
  trainTornadoSector,
  trainNightRelaySar,
  trainInfraInspection,
]
