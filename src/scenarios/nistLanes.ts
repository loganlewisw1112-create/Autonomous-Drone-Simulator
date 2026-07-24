import {
  FEATURES_PER_TARGET,
  LANE_TARGET_COUNT,
  LANE_TIME_LIMIT_SEC,
  type NistLaneDefinition,
  type NistLaneTarget,
} from '@/sim/mission/laneScoring'
import type { LatLng, ScenarioConfig } from '@/types'

const OPEN_LANE_ORIGIN: LatLng = { lat: 37.6688, lng: -122.0810 }
const OBSTRUCTED_LANE_ORIGIN: LatLng = { lat: 37.8992, lng: -122.2432 }
const CONFINED_LANE_ORIGIN: LatLng = { lat: 37.7705, lng: -122.4495 }
const MARITIME_LANE_ORIGIN: LatLng = { lat: 37.7695, lng: -122.5120 }
const URBAN_MASK_ORIGIN: LatLng = { lat: 37.7840, lng: -122.4095 }

const M_PER_DEG_LAT = 111_320

function gridTargets(origin: LatLng, spacingM: number, heightAglM: number, prefix: string): NistLaneTarget[] {
  const targets: NistLaneTarget[] = []
  const cols = 5
  const metersPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)
  for (let i = 0; i < LANE_TARGET_COUNT; i += 1) {
    const row = Math.floor(i / cols)
    const col = i % cols
    targets.push({
      id: `${prefix}-t${String(i + 1).padStart(2, '0')}`,
      label: `Target ${i + 1}`,
      heightAglM,
      position: {
        lat: origin.lat + (row * spacingM) / M_PER_DEG_LAT,
        lng: origin.lng + (col * spacingM) / metersPerDegLng,
      },
    })
  }
  return targets
}

export const NIST_OPEN_LANE: NistLaneDefinition = {
  id: 'nist-open-lane',
  kind: 'open',
  label: 'NIST Open Test Lane — Basic Proficiency',
  scenarioId: 'nist_open_lane',
  targets: gridTargets(OPEN_LANE_ORIGIN, 60, 1.5, 'open'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

export const NIST_OBSTRUCTED_LANE: NistLaneDefinition = {
  id: 'nist-obstructed-lane',
  kind: 'obstructed',
  label: 'NIST Obstructed Test Lane — Terrain Masking',
  scenarioId: 'nist_obstructed_lane',
  targets: gridTargets(OBSTRUCTED_LANE_ORIGIN, 120, 1.5, 'obs'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

export const NIST_CONFINED_LANE: NistLaneDefinition = {
  id: 'nist-confined-lane',
  kind: 'confined',
  label: 'NIST Confined Test Lane — Close-Quarters Acuity',
  scenarioId: 'nist_confined_lane',
  targets: gridTargets(CONFINED_LANE_ORIGIN, 35, 1.2, 'conf'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

export const NIST_NIGHT_LANE: NistLaneDefinition = {
  id: 'nist-night-lane',
  kind: 'night',
  label: 'NIST Night Acuity Lane — Low-Light Feature ID',
  scenarioId: 'nist_night_acuity_lane',
  targets: gridTargets(OPEN_LANE_ORIGIN, 55, 1.5, 'night'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

export const NIST_MARITIME_LANE: NistLaneDefinition = {
  id: 'nist-maritime-lane',
  kind: 'maritime',
  label: 'NIST Maritime Lane — Coastal Feature ID',
  scenarioId: 'nist_maritime_lane',
  targets: gridTargets(MARITIME_LANE_ORIGIN, 70, 1.5, 'mar'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

export const NIST_URBAN_MASK_LANE: NistLaneDefinition = {
  id: 'nist-urban-mask-lane',
  kind: 'urban',
  label: 'NIST Urban Mask Lane — Clutter & RF Degradation',
  scenarioId: 'nist_urban_mask_lane',
  targets: gridTargets(URBAN_MASK_ORIGIN, 50, 1.5, 'urb'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

const LANES: NistLaneDefinition[] = [
  NIST_OPEN_LANE,
  NIST_OBSTRUCTED_LANE,
  NIST_CONFINED_LANE,
  NIST_NIGHT_LANE,
  NIST_MARITIME_LANE,
  NIST_URBAN_MASK_LANE,
]

function overflightWaypoints(lane: NistLaneDefinition, altitudeFt: number) {
  const rows: NistLaneTarget[][] = []
  for (let i = 0; i < lane.targets.length; i += 5) rows.push(lane.targets.slice(i, i + 5))
  return rows.flatMap((row, index) => {
    const ordered = index % 2 === 0 ? row : [...row].reverse()
    return ordered.map((target) => ({
      id: `wp-${target.id}`,
      position: target.position,
      altitudeFt,
      label: target.label,
    }))
  })
}

function transectWaypoints(lane: NistLaneDefinition, altitudeFt: number) {
  const lats = lane.targets.map((t) => t.position.lat)
  const lngs = lane.targets.map((t) => t.position.lng)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const west = Math.min(...lngs)
  const east = Math.max(...lngs)
  const steps = 6
  return Array.from({ length: steps + 1 }, (_, i) => ({
    id: `wp-transect-${i}`,
    position: { lat: midLat, lng: west + ((east - west) * i) / steps },
    altitudeFt,
    label: `Transect ${i + 1}`,
  }))
}

function laneScenario(
  lane: NistLaneDefinition,
  waypoints: ScenarioConfig['waypoints'],
  overrides: Partial<ScenarioConfig> & Pick<ScenarioConfig, 'id' | 'name' | 'description' | 'seed' | 'startPosition'>,
): ScenarioConfig {
  return {
    droneCount: 1,
    dronePlatforms: { 'uav-01': 'skydio_x10' },
    missionType: 'waypoint',
    waypoints,
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 100 / (lane.timeLimitSec * 1.15),
    commsLossWindows: [],
    missionClass: 'nist_skills',
    ...overrides,
  }
}

export const nistOpenLane: ScenarioConfig = laneScenario(NIST_OPEN_LANE, overflightWaypoints(NIST_OPEN_LANE, 200), {
  id: 'nist_open_lane',
  name: 'NIST — Open Test Lane (Proficiency)',
  description:
    `Standard proficiency trial on the NIST sUAS open test lane. ${LANE_TARGET_COUNT} targets, `
    + `${FEATURES_PER_TARGET} increasingly small features each, 1 point per feature, `
    + `${LANE_TIME_LIMIT_SEC / 60} minute limit — scored 0-100 against the published rubric. `
    + 'Finer features require closer standoff. SIMULATION ONLY.',
  seed: 90001,
  startPosition: { lat: 37.6676, lng: -122.0822 },
  rfClutter: 'open',
})

export const nistObstructedLane: ScenarioConfig = laneScenario(NIST_OBSTRUCTED_LANE, transectWaypoints(NIST_OBSTRUCTED_LANE, 200), {
  id: 'nist_obstructed_lane',
  name: 'NIST — Obstructed Test Lane (Terrain Masking)',
  description:
    'Obstructed-lane proficiency trial in the East Bay Hills — terrain masks targets until repositioning. SIMULATION ONLY.',
  seed: 90002,
  startPosition: { lat: 37.8975, lng: -122.2455 },
  rfClutter: 'suburban',
})

export const nistConfinedLane: ScenarioConfig = laneScenario(
  NIST_CONFINED_LANE,
  overflightWaypoints(NIST_CONFINED_LANE, 120),
  {
    id: 'nist_confined_lane',
    name: 'NIST — Confined Test Lane (Close Quarters)',
    description: 'Confined-lane proficiency trial with tight target spacing. SIMULATION ONLY.',
    seed: 90003,
    startPosition: { lat: 37.7698, lng: -122.4508 },
    rfClutter: 'dense_urban',
  },
)

export const nistNightAcuityLane: ScenarioConfig = laneScenario(
  NIST_NIGHT_LANE,
  overflightWaypoints(NIST_NIGHT_LANE, 180),
  {
    id: 'nist_night_acuity_lane',
    name: 'NIST — Night Acuity Lane (Low Light)',
    description: 'Night-acuity proficiency trial with night authorization training steps. SIMULATION ONLY.',
    seed: 90004,
    startPosition: { lat: 37.6676, lng: -122.0822 },
    rfClutter: 'suburban',
    authorizationProfile: {
      kind: 'field_incident_command',
      requiredSteps: ['remote_id', 'airspace_request', 'ceiling_check', 'night_ops'],
      label: 'Night lane waiver practice',
      reference: 'Night waiver steps for proficiency lane.',
    },
  },
)

export const nistMaritimeLane: ScenarioConfig = laneScenario(
  NIST_MARITIME_LANE,
  overflightWaypoints(NIST_MARITIME_LANE, 160),
  {
    id: 'nist_maritime_lane',
    name: 'NIST — Maritime Lane (Coastal Acuity)',
    description: 'Maritime-environment proficiency trial with coastal RF/clutter characteristics. SIMULATION ONLY.',
    seed: 90005,
    startPosition: { lat: 37.7682, lng: -122.5135 },
    rfClutter: 'open',
  },
)

export const nistUrbanMaskLane: ScenarioConfig = laneScenario(
  NIST_URBAN_MASK_LANE,
  transectWaypoints(NIST_URBAN_MASK_LANE, 180),
  {
    id: 'nist_urban_mask_lane',
    name: 'NIST — Urban Mask Lane (Clutter)',
    description: 'Urban masking proficiency trial — dense clutter and transect geometry. SIMULATION ONLY.',
    seed: 90006,
    startPosition: { lat: 37.7832, lng: -122.4108 },
    rfClutter: 'dense_urban',
  },
)

export const NIST_LANE_SCENARIOS: ScenarioConfig[] = [
  nistOpenLane,
  nistObstructedLane,
  nistConfinedLane,
  nistNightAcuityLane,
  nistMaritimeLane,
  nistUrbanMaskLane,
]

export function laneForScenario(scenarioId: string | undefined): NistLaneDefinition | undefined {
  return scenarioId ? LANES.find((lane) => lane.scenarioId === scenarioId) : undefined
}

export function allLanes(): NistLaneDefinition[] {
  return LANES
}
