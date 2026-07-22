/**
 * Determinism verification — proves two independent simulation runs with the same
 * seed produce byte-identical outputs. This is a core requirement for:
 *   - After-action replay (DoD)
 *   - Evidence chain integrity (SFPD/OPD)
 *   - Audit reproducibility
 */
import { describe, it, expect } from 'vitest'
import { mulberry32 } from '@/utils/rng'
import { createDroneState, stepDrone } from '@/sim/drone/DroneEntity'
import { getNextCommand } from '@/sim/mission/MissionManager'
import { generatePerDroneWaypoints } from '@/sim/mission/SARPlanner'
import { checkThermalDetections } from '@/sim/sensors/ThermalSim'
import { getAssignedAltitude } from '@/sim/safety/DeconflictEngine'
import { createTerrainOcclusionService, occlusionEpoch } from '@/sim/terrain/OcclusionService'
import type { TerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import type { Point3D } from '@/sim/terrain/terrainRaster'
import { terrainRasterFor } from '@/scenarios/terrainFixtures'
import type { MissionManagerState } from '@/sim/mission/MissionManager'
import type { DroneState, Waypoint } from '@/types'

const SEED = 7331
const BASE = { lat: 37.7694, lng: -122.4862 }
const BASE_WP: Waypoint = { id: 'base', position: BASE, altitudeFt: 0, label: 'Base' }
const SEARCH_AREA = [
  { lat: 37.7700, lng: -122.4880 },
  { lat: 37.7720, lng: -122.4880 },
  { lat: 37.7720, lng: -122.4840 },
  { lat: 37.7700, lng: -122.4840 },
]
const HEAT_SOURCES = [
  { id: 'hs-1', class: 'generic-person' as const, position: { lat: 37.7712, lng: -122.4862 }, tempC: 37, radiusM: 2 },
  { id: 'hs-2', class: 'vehicle' as const, position: { lat: 37.7707, lng: -122.4848 }, tempC: 90, radiusM: 4 },
]

/** Run N ticks of the pure simulation, return final drone states. */
function runHeadlessSim(ticks: number): DroneState[] {
  const colors = ['#00d4ff', '#44ff88', '#ffaa00']

  let drones: DroneState[] = [0, 1, 2].map((i) => ({
    ...createDroneState(`uav-0${i + 1}`, `UAV-0${i + 1}`, colors[i], {
      lat: BASE.lat + i * 0.00005,
      lng: BASE.lng + i * 0.00005,
    }),
    missionState: 'launch' as const,
    batteryPct: 100,
    signalDbm: -55,
  }))

  const droneWaypoints: Record<string, Waypoint[]> = {}
  drones.forEach((d, i) => {
    droneWaypoints[d.id] = generatePerDroneWaypoints(SEARCH_AREA, 50, i, 3, 100 + i * 20)
  })

  let elapsedSec = 0

  for (let tick = 0; tick < ticks; tick++) {
    const updatedDrones = drones.map((drone) => {
      const mm: MissionManagerState = {
        waypoints: [],
        basePosition: BASE_WP,
        elapsedSec,
        tick,
        assignedAltitudeFt: getAssignedAltitude(drone.id, drones),
        droneWaypoints,
      }
      const { cmd, nextState, nextWaypointIndex } = getNextCommand(drone, mm)
      return stepDrone(
        { ...drone, missionState: nextState, currentWaypointIndex: nextWaypointIndex },
        cmd,
        0.05,
      )
    })

    // Thermal checks (same as SimulationLoop)
    if (tick % 50 === 0) {
      for (const d of updatedDrones) {
        checkThermalDetections(d, HEAT_SOURCES, tick, SEED)
      }
    }

    drones = updatedDrones
    elapsedSec += 0.05
  }

  return drones
}

describe('Determinism verification', () => {
  it('two runs with same seed produce identical final drone positions', () => {
    const run1 = runHeadlessSim(500)
    const run2 = runHeadlessSim(500)

    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].position.lat).toBe(run2[i].position.lat)
      expect(run1[i].position.lng).toBe(run2[i].position.lng)
      expect(run1[i].altitudeFt).toBe(run2[i].altitudeFt)
      expect(run1[i].batteryPct).toBe(run2[i].batteryPct)
      expect(run1[i].missionState).toBe(run2[i].missionState)
    }
  })

  it('two runs produce identical headings and speeds', () => {
    const run1 = runHeadlessSim(200)
    const run2 = runHeadlessSim(200)

    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].headingDeg).toBe(run2[i].headingDeg)
      expect(run1[i].speedMs).toBe(run2[i].speedMs)
    }
  })

  it('RNG produces same sequence for same seed across two instances', () => {
    const rng1 = mulberry32(SEED)
    const rng2 = mulberry32(SEED)
    const N = 1000
    const seq1 = Array.from({ length: N }, () => rng1())
    const seq2 = Array.from({ length: N }, () => rng2())
    expect(seq1).toEqual(seq2)
  })

  it('RNG produces different sequences for different seeds', () => {
    const rng1 = mulberry32(SEED)
    const rng2 = mulberry32(SEED + 1)
    const seq1 = Array.from({ length: 100 }, () => rng1())
    const seq2 = Array.from({ length: 100 }, () => rng2())
    expect(seq1).not.toEqual(seq2)
  })

  it('SAR grid generation is deterministic', () => {
    const wps1 = generatePerDroneWaypoints(SEARCH_AREA, 50, 0, 3, 100)
    const wps2 = generatePerDroneWaypoints(SEARCH_AREA, 50, 0, 3, 100)
    expect(wps1).toEqual(wps2)
  })

  it('thermal detections are deterministic with same tick and seed', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#fff', { lat: 37.7712, lng: -122.4862 }, 100)
    const activeState = { ...drone, missionState: 'navigate' as const }
    const det1 = checkThermalDetections(activeState, HEAT_SOURCES, 100, SEED)
    const det2 = checkThermalDetections(activeState, HEAT_SOURCES, 100, SEED)
    expect(det1).toEqual(det2)
  })

  it('thermal detections differ with different tick (different PRNG state)', () => {
    const drone = createDroneState('uav-01', 'UAV-01', '#fff', { lat: 37.7712, lng: -122.4862 }, 100)
    const activeState = { ...drone, missionState: 'navigate' as const }
    const det1 = checkThermalDetections(activeState, HEAT_SOURCES, 100, SEED)
    const det2 = checkThermalDetections(activeState, HEAT_SOURCES, 200, SEED)
    // Confidence values should differ since tick changes the RNG state
    if (det1.length > 0 && det2.length > 0) {
      expect(det1[0].confidence).not.toBe(det2[0].confidence)
    }
  })
})

/**
 * Terrain-active determinism (REALISM_ROADMAP WP-4 / §21).
 *
 * §21 lists "terrain breaks determinism tests" as a named risk and is explicit that the
 * mitigation — pinned in-repo fixtures plus a terrain-active determinism case — belongs *in*
 * WP-4 rather than being deferred to the packages that consume it. This is that case.
 *
 * What makes terrain a genuine determinism risk is that WP-4 puts an elevation lookup inside
 * every altitude computation, and §4.5 then caches occlusion at 1 Hz instead of on the 50 ms
 * tick. A cache is exactly the kind of thing that turns a pure kernel into an order-dependent
 * one: if a warm lookup could differ from a cold one — by a rounding path, by an epoch derived
 * from the wall clock, by an eviction that quietly changes an answer — replay, sub-stepping and
 * frame catch-up would all diverge, and the divergence would be intermittent.
 *
 * So the strong form is tested: the second run is deliberately served from the cache the first
 * run populated, and must still be byte-identical to a run that never sees a cache at all.
 */
const TERRAIN_SCENARIO = 'demo_wildfire'
const TERRAIN_BASE = { lat: 37.8992, lng: -122.2432 } // CAL FIRE staging, Tilden Park
const TERRAIN_BASE_WP: Waypoint = { id: 'base', position: TERRAIN_BASE, altitudeFt: 0, label: 'Base' }
const TERRAIN_SEARCH_AREA = [
  { lat: 37.8955, lng: -122.2445 },
  { lat: 37.9020, lng: -122.2445 },
  { lat: 37.9020, lng: -122.2320 },
  { lat: 37.8955, lng: -122.2320 },
]
/** The north-east spotfire from the demo_wildfire scenario — a fixed ground contact to look at. */
const TERRAIN_CONTACT = { lat: 37.9005, lng: -122.2335 }
const FT_PER_M = 3.280839895

/**
 * Fly the real headless step over the real DEM, sampling terrain the way WP-4's consumers will:
 * an elevation/AGL lookup every tick, and LOS + sky visibility on the §4.5 1 Hz epoch boundary.
 * Returns a full-precision trace, so any divergence anywhere shows up as an unequal string.
 */
function runTerrainActiveSim(ticks: number, occlusion: TerrainOcclusionService): string[] {
  const colors = ['#00d4ff', '#44ff88', '#ffaa00']
  let drones: DroneState[] = [0, 1, 2].map((i) => ({
    ...createDroneState(`uav-0${i + 1}`, `UAV-0${i + 1}`, colors[i], {
      lat: TERRAIN_BASE.lat + i * 0.00005,
      lng: TERRAIN_BASE.lng + i * 0.00005,
    }),
    missionState: 'launch' as const,
    batteryPct: 100,
    signalDbm: -55,
  }))

  const droneWaypoints: Record<string, Waypoint[]> = {}
  drones.forEach((d, i) => {
    droneWaypoints[d.id] = generatePerDroneWaypoints(TERRAIN_SEARCH_AREA, 50, i, 3, 150 + i * 30)
  })

  const trace: string[] = []
  let elapsedSec = 0
  let lastEpoch = -1

  for (let tick = 0; tick < ticks; tick++) {
    const updatedDrones = drones.map((drone) => {
      const mm: MissionManagerState = {
        waypoints: [],
        basePosition: TERRAIN_BASE_WP,
        elapsedSec,
        tick,
        assignedAltitudeFt: getAssignedAltitude(drone.id, drones),
        droneWaypoints,
      }
      const { cmd, nextState, nextWaypointIndex } = getNextCommand(drone, mm)
      return stepDrone(
        { ...drone, missionState: nextState, currentWaypointIndex: nextWaypointIndex },
        cmd,
        0.05,
      )
    })

    // Per-tick terrain lookups — the cost §4.7 warns about, and the purity requirement.
    for (const d of updatedDrones) {
      const ground = occlusion.groundElevation(d.position.lat, d.position.lng)
      const point: Point3D = {
        lat: d.position.lat,
        lng: d.position.lng,
        altMslM: ground + d.altitudeFt / FT_PER_M,
      }
      trace.push(`${tick}|${d.id}|g=${ground}|agl=${occlusion.heightAboveGround(point)}`)
    }

    // Occlusion runs on the 1 Hz epoch, not the 50 ms tick (§4.5). The epoch comes from sim
    // time — tick x dt — so a replay lands on exactly the same boundaries as the first run.
    const epoch = occlusionEpoch(elapsedSec)
    if (epoch !== lastEpoch) {
      lastEpoch = epoch
      occlusion.setEpoch(epoch)

      const airborne = (d: DroneState): Point3D => ({
        lat: d.position.lat,
        lng: d.position.lng,
        altMslM: occlusion.groundElevation(d.position.lat, d.position.lng) + d.altitudeFt / FT_PER_M,
      })
      const contact: Point3D = {
        lat: TERRAIN_CONTACT.lat,
        lng: TERRAIN_CONTACT.lng,
        altMslM: occlusion.groundElevation(TERRAIN_CONTACT.lat, TERRAIN_CONTACT.lng) + 1.8,
      }
      const lead = airborne(updatedDrones[0])

      for (const d of updatedDrones) {
        const from = airborne(d)
        // Thermal (WP-5): can this ship see the ground contact across the ridge line?
        const toContact = occlusion.hasLineOfSight(from, contact)
        // RF (WP-8): is the relay path back to the lead ship line-of-sight?
        const toLead = occlusion.hasLineOfSight(from, lead)
        // §4.1's point is that four consumers share one geometry, so the same pair genuinely
        // does get asked more than once per epoch. Ask it reciprocally: it must hit the cache
        // (canonicalised key) and it must return exactly the same object-equal answer.
        const reciprocal = occlusion.hasLineOfSight(contact, from)
        trace.push(
          `${epoch}|${d.id}|clear=${toContact.clear}|by=${toContact.blockedBy}` +
            `|h=${toContact.blockHeight}|c=${toContact.clearanceM}` +
            `|relay=${toLead.clear}|relayC=${toLead.clearanceM}` +
            `|recip=${reciprocal.clear}|recipC=${reciprocal.clearanceM}` +
            `|sky=${occlusion.skyVisibility(from, 45, 12)}${occlusion.skyVisibility(from, 225, 12)}`,
        )
      }
    }

    drones = updatedDrones
    elapsedSec += 0.05
  }

  return trace
}

describe('Determinism with terrain active (WP-4 §21)', () => {
  const raster = terrainRasterFor(TERRAIN_SCENARIO)!

  it('decodes the same DEM every time it is loaded', () => {
    // The fixture is committed bytes, and the decode is memoised on those bytes. Two loads must
    // be the identical object, not merely an equal one — a second decode would mean the memo key
    // is wrong and the "warm equals cold" guarantee below rests on nothing.
    expect(terrainRasterFor(TERRAIN_SCENARIO)).toBe(raster)
    expect(raster.elevations.length).toBe(raster.width * raster.height)
  })

  it('produces an identical trace across two runs sharing one warmed cache', () => {
    const occlusion = createTerrainOcclusionService(raster)
    const run1 = runTerrainActiveSim(400, occlusion) // populates the cache
    const run2 = runTerrainActiveSim(400, occlusion) // served from it
    expect(occlusion.cacheStats().hits).toBeGreaterThan(0)
    expect(run2).toEqual(run1)
  })

  it('produces an identical trace on a cold service with no usable cache', () => {
    const warmService = createTerrainOcclusionService(raster)
    const warm = runTerrainActiveSim(400, warmService)
    runTerrainActiveSim(400, warmService)

    const coldService = createTerrainOcclusionService(raster, { cacheLimit: 1 })
    const cold = runTerrainActiveSim(400, coldService)

    expect(cold).toEqual(warm)
    expect(coldService.cacheStats().size).toBeLessThanOrEqual(1)
  })

  it('exercises terrain hard enough for the comparison to mean something', () => {
    // A determinism test over a constant is worthless. Assert the trace actually varies: the
    // drones cross real relief, and the LOS results include both blocked and clear outcomes.
    const trace = runTerrainActiveSim(400, createTerrainOcclusionService(raster))
    const grounds = new Set(trace.filter((t) => t.includes('|g=')).map((t) => t.split('|g=')[1]))
    expect(grounds.size).toBeGreaterThan(20)
    const losLines = trace.filter((t) => t.includes('clear='))
    expect(losLines.length).toBeGreaterThan(10)
    // The ridge between staging and the north-east spotfire genuinely masks the contact…
    expect(losLines.some((t) => t.includes('clear=false'))).toBe(true)
    // …while the short relay hop between ships in the same flight stays line-of-sight. Both
    // outcomes have to appear or this whole comparison is over a constant.
    expect(losLines.some((t) => t.includes('relay=true'))).toBe(true)
  })

  it('keeps elevation lookup pure — repeated queries never drift', () => {
    const occlusion = createTerrainOcclusionService(raster)
    const samples = [
      TERRAIN_BASE,
      TERRAIN_CONTACT,
      { lat: 37.902, lng: -122.2385 },
      { lat: 37.8955, lng: -122.2395 },
    ]
    for (const s of samples) {
      const first = occlusion.groundElevation(s.lat, s.lng)
      for (let i = 0; i < 50; i++) {
        expect(occlusion.groundElevation(s.lat, s.lng)).toBe(first)
      }
    }
  })
})
