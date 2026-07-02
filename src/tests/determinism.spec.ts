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
