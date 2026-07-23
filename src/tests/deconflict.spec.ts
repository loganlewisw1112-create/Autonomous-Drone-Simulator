import { describe, it, expect, vi } from 'vitest'
import { detectConflicts, applyConflictFlags, getAssignedAltitude, ALTITUDE_BANDS } from '@/sim/safety/DeconflictEngine'
import { createDroneState } from '@/sim/drone/DroneEntity'
import { createTerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import type { TerrainRaster } from '@/sim/terrain/terrainRaster'

const BASE = { lat: 37.7695, lng: -122.4862 }

const SLOPED_TERRAIN: TerrainRaster = {
  width: 2,
  height: 2,
  bounds: {
    west: BASE.lng - 0.0001,
    south: BASE.lat - 0.0001,
    east: BASE.lng + 0.0001,
    north: BASE.lat + 0.0001,
  },
  metersPerPixel: 10,
  surface: 'bare-earth',
  minElevationM: 100,
  maxElevationM: 110,
  elevations: new Float32Array([110, 110, 100, 100]),
}

function makeDrone(id: string, lat: number, lng: number, altFt: number, state = 'navigate' as const) {
  return {
    ...createDroneState(id, id.toUpperCase(), '#fff', { lat, lng }, altFt),
    missionState: state,
    speedMs: 8,
    headingDeg: 0,
  }
}

describe('DeconflictEngine', () => {
  it('assigns unique altitude bands per drone index', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 100),
      makeDrone('uav-02', BASE.lat, BASE.lng, 120),
      makeDrone('uav-03', BASE.lat, BASE.lng, 140),
    ]
    expect(getAssignedAltitude('uav-01', drones)).toBe(ALTITUDE_BANDS[0].cruise)
    expect(getAssignedAltitude('uav-02', drones)).toBe(ALTITUDE_BANDS[1].cruise)
    expect(getAssignedAltitude('uav-03', drones)).toBe(ALTITUDE_BANDS[2].cruise)
  })

  it('detects conflict between same-altitude co-located drones', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 120),
      makeDrone('uav-02', BASE.lat + 0.0001, BASE.lng, 120), // ~11m away
    ]
    const conflicts = detectConflicts(drones)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].idA).toBe('uav-01')
    expect(conflicts[0].idB).toBe('uav-02')
  })

  it('no conflict when drones are vertically separated', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 100),
      makeDrone('uav-02', BASE.lat, BASE.lng, 140), // 40ft separation > V_SEP_FT
    ]
    const conflicts = detectConflicts(drones)
    expect(conflicts.length).toBe(0)
  })

  it('no conflict when drones are far apart horizontally', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 120),
      makeDrone('uav-02', BASE.lat + 0.005, BASE.lng, 120), // ~556m away
    ]
    const conflicts = detectConflicts(drones)
    expect(conflicts.length).toBe(0)
  })

  it('compares physical MSL separation when both predictions have terrain coverage', () => {
    const terrain = createTerrainOcclusionService(SLOPED_TERRAIN)
    const drones = [
      { ...makeDrone('uav-01', BASE.lat - 0.00005, BASE.lng, 120), speedMs: 0 },
      { ...makeDrone('uav-02', BASE.lat + 0.00005, BASE.lng, 120), speedMs: 0 },
    ]

    expect(detectConflicts(drones)).toHaveLength(1)
    expect(detectConflicts(drones, terrain)).toHaveLength(0)
  })

  it('preserves the AGL comparison when either predicted position is outside coverage', () => {
    const terrain = createTerrainOcclusionService(SLOPED_TERRAIN)
    const ground = vi.spyOn(terrain, 'groundElevation')
    const drones = [
      { ...makeDrone('uav-01', BASE.lat + 0.00005, BASE.lng, 120), speedMs: 0 },
      { ...makeDrone('uav-02', BASE.lat + 0.00011, BASE.lng, 120), speedMs: 0 },
    ]

    expect(detectConflicts(drones, terrain)).toHaveLength(1)
    expect(ground).not.toHaveBeenCalled()
  })

  it('landed drones are excluded from conflict detection', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 0),
      { ...makeDrone('uav-02', BASE.lat, BASE.lng, 0), missionState: 'landed' as const },
    ]
    const conflicts = detectConflicts(drones)
    expect(conflicts.length).toBe(0)
  })

  it('applyConflictFlags stamps both drones in a conflict', () => {
    const drones = [
      makeDrone('uav-01', BASE.lat, BASE.lng, 120),
      makeDrone('uav-02', BASE.lat + 0.0001, BASE.lng, 120),
    ]
    const conflicts = detectConflicts(drones)
    const flagged = applyConflictFlags(drones, conflicts)
    expect(flagged[0].conflictFlag).toBe(true)
    expect(flagged[1].conflictFlag).toBe(true)
  })

  it('applyConflictFlags clears flags when no conflict', () => {
    const drones = [
      { ...makeDrone('uav-01', BASE.lat, BASE.lng, 100), conflictFlag: true },
      makeDrone('uav-02', BASE.lat + 0.005, BASE.lng, 140),
    ]
    const flagged = applyConflictFlags(drones, [])
    expect(flagged[0].conflictFlag).toBe(false)
    expect(flagged[1].conflictFlag).toBe(false)
  })
})
