import {
  FEATURES_PER_TARGET,
  LANE_TARGET_COUNT,
  LANE_TIME_LIMIT_SEC,
  type NistLaneDefinition,
  type NistLaneTarget,
} from '@/sim/mission/laneScoring'
import type { LatLng, ScenarioConfig } from '@/types'

// NIST standard test-method lanes (REALISM_ROADMAP WP-9).
//
// NIST's Standard Test Methods for small Unmanned Aircraft Systems, developed with DHS Science &
// Technology support, define basic proficiency lanes for remote pilots: OPEN, OBSTRUCTED and
// CONFINED. They are referenced as Job Performance Requirements in NFPA 2400 (sUAS for Public
// Safety Operations) and ASTM F38.03 (Training for Remote Pilot in Command endorsement).
//
// WHAT IS AND IS NOT CLAIMED. These lanes implement the published *rubric* — 20 targets, five
// increasingly small features each, 100 points, 20-minute limit — and the acuity basis those
// targets are dimensioned against. They are NOT a reproduction of any specific NIST apparatus
// drawing, and the target coordinates here are this project's own layout at real locations. The
// defensible claim is "implements the NIST sUAS standard test-method rubric", not "is a certified
// NIST lane", and the after-action package cites it exactly that way.
//
// THE OBSTRUCTED LANE IS ONLY BUILDABLE BECAUSE OF WP-4. Its whole content is that terrain hides
// targets until the aircraft repositions — which requires real elevation data and a real
// line-of-sight service. It sits in the demo_wildfire AO precisely because that is the one AO
// carrying a committed DEM and building footprints.

const OPEN_LANE_ORIGIN: LatLng = { lat: 37.6688, lng: -122.0810 }
/** Grizzly Peak / East Bay Hills — the AO with committed terrain and buildings. */
const OBSTRUCTED_LANE_ORIGIN: LatLng = { lat: 37.8992, lng: -122.2432 }

const M_PER_DEG_LAT = 111_320

/**
 * Lay out `LANE_TARGET_COUNT` targets on a 5 × 4 grid.
 *
 * Spacing is wide enough that no single hover resolves two targets' fine features at once — the
 * finest feature needs ~17 m standoff, so 60 m spacing forces the aircraft to actually work the
 * lane rather than park in the middle and collect everything.
 */
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
  // 120 m spacing keeps every target inside the largest feature's 275 m acuity range from the
  // centre transect, so RANGE never decides the outcome — only terrain does.
  targets: gridTargets(OBSTRUCTED_LANE_ORIGIN, 120, 1.5, 'obs'),
  timeLimitSec: LANE_TIME_LIMIT_SEC,
  standardRef: 'NIST Standard Test Methods for sUAS (DHS S&T) · referenced by NFPA 2400 and ASTM F38.03',
}

const LANES: NistLaneDefinition[] = [NIST_OPEN_LANE, NIST_OBSTRUCTED_LANE]

/** The lane a scenario is scored against, or undefined when it is not a lane trial. */
export function laneForScenario(scenarioId: string | undefined): NistLaneDefinition | undefined {
  return scenarioId ? LANES.find((lane) => lane.scenarioId === scenarioId) : undefined
}

export function allLanes(): NistLaneDefinition[] {
  return LANES
}

/**
 * OPEN lane route: boustrophedon directly over the grid at a safe altitude.
 *
 * Deliberately not a route that scores well. MEASURED: flying the brief unchanged earns 80/100
 * with no target completed — the finest feature needs ~17 m standoff, so the last point on every
 * target has to be bought with a deliberate descent. Deciding where to spend the clock doing that
 * is the trial.
 *
 * NOTE ON ALTITUDE. The authored 200 ft is the brief's safe altitude, but it is not necessarily
 * what gets flown: `DeconflictEngine.getAssignedAltitude` assigns each aircraft a cruise band by
 * fleet index, and that band wins. That is pre-existing fleet behaviour and WP-9 does not override
 * it — the lane is scored on where the aircraft actually was, never on where the brief said.
 */
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

/**
 * OBSTRUCTED lane route: a single straight transect through the middle of the target field.
 *
 * MEASURED: the same rubric and the same aircraft score 44/100 here against 80/100 on the open
 * lane, with a per-target spread of 1-4 features. That 36-point gap is entirely terrain.
 *
 * This is the whole design of the obstructed lane, and it is why the route is NOT an overflight.
 * An aircraft directly above a target always has line of sight — terrain cannot mask a nadir
 * view — so an overflight route would make the obstructed lane score identically to the open
 * one no matter how much relief the DEM carries. Observing from a transect means every target
 * off the centreline is seen at a slant, across whatever the East Bay terrain puts in the way.
 *
 * Targets are inside the largest feature's acuity range from the centreline by construction, so
 * anything missed was missed because the ridge was in the way — not because it was too far. The
 * trainee earns those targets by repositioning, which is exactly the skill the lane tests.
 */
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
    // A proficiency trial is flown on one standard airframe — the fleet's general-purpose X10 —
    // so the score reflects the pilot rather than the payload.
    dronePlatforms: { 'uav-01': 'skydio_x10' },
    missionType: 'waypoint',
    waypoints,
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    // A trial must fit one battery charge — that is why NIST sets the time limit where it does,
    // so the battery is sized to make the clock the binding constraint, not an artificial cutoff.
    batteryDrainRatePerSec: 100 / (lane.timeLimitSec * 1.15),
    commsLossWindows: [],
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
    + 'Finer features require closer standoff, so the trial is a decision about where to spend the '
    + 'clock. Implements the NIST rubric referenced by NFPA 2400 and ASTM F38.03. SIMULATION ONLY.',
  seed: 90001,
  startPosition: { lat: 37.6676, lng: -122.0822 },
  rfClutter: 'open',
})

export const nistObstructedLane: ScenarioConfig = laneScenario(NIST_OBSTRUCTED_LANE, transectWaypoints(NIST_OBSTRUCTED_LANE, 200), {
  id: 'nist_obstructed_lane',
  name: 'NIST — Obstructed Test Lane (Terrain Masking)',
  description:
    'Obstructed-lane proficiency trial in the East Bay Hills. Same 100-point rubric as the open '
    + 'lane, but real terrain masks targets from the standard approach: line of sight must be '
    + 'earned by repositioning, not assumed. Buildable only because the AO carries a committed '
    + 'DEM and building footprints. Implements the NIST rubric referenced by NFPA 2400 and '
    + 'ASTM F38.03. SIMULATION ONLY.',
  seed: 90002,
  startPosition: { lat: 37.8975, lng: -122.2455 },
  rfClutter: 'suburban',
})

export const NIST_LANE_SCENARIOS: ScenarioConfig[] = [nistOpenLane, nistObstructedLane]
