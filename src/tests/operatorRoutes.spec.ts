import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildingFixtureFor } from '@/scenarios/buildingFixtures'
import { buildOperatorCommandRoute, buildRouteSuggestions, validateOperatorRoute } from '@/sim/mission/operatorRoutes'
import {
  auditTerrainClearance,
  defaultDroneStartPosition,
  REQUIRED_STRUCTURE_CLEARANCE_FT,
} from '@/sim/mission/routeAudit'
import { createTerrainOcclusionService } from '@/sim/terrain/OcclusionService'
import type { TerrainRaster } from '@/sim/terrain/terrainRaster'
import type { ScenarioConfig, Waypoint } from '@/types'

const portScenario = ALL_SCENARIOS.find((s) => s.id === 'demo_perimeter') ?? ALL_SCENARIOS[0]
const rioGrande = ALL_SCENARIOS.find((s) => s.id === 'extreme_cbp_rio_grande_longrange') ?? ALL_SCENARIOS[0]
const livePosition = { lat: 37, lng: -122 }
const liveTarget = { lat: 37, lng: -121.99 }
const liveOriginScenario: ScenarioConfig = {
  ...portScenario,
  id: 'live-origin-test',
  droneCount: 1,
  startPosition: { lat: 37.01, lng: -122 },
  launchSites: undefined,
  recoverySites: undefined,
  perDroneStartPositions: undefined,
  perDroneWaypoints: undefined,
  waypoints: [],
  operationalFeatures: undefined,
  heatSources: [],
  geofences: [{
    id: 'live-leg-blocker',
    label: 'Live Leg Blocker',
    type: 'no_fly',
    maxAltitudeFt: 400,
    polygon: [
      { lat: 36.999, lng: -121.996 },
      { lat: 36.999, lng: -121.994 },
      { lat: 37.001, lng: -121.994 },
      { lat: 37.001, lng: -121.996 },
    ],
  }],
}

describe('operator retasking and route suggestions', () => {
  it('blocks an operator route that crosses a non-authorized geofence', () => {
    const route = [
      { id: 'unsafe-a', label: 'Unsafe A', position: { lat: 37.7995, lng: -122.2875 }, altitudeFt: 100 },
      { id: 'unsafe-b', label: 'Unsafe B', position: { lat: 37.7995, lng: -122.2820 }, altitudeFt: 100 },
    ]

    const result = validateOperatorRoute(portScenario, 'uav-01', route)

    expect(result.accepted).toBe(false)
    expect(result.findings.some((f) => f.geofenceId === 'gf-cranes')).toBe(true)
  })

  it('creates a safe deep-scan route around the selected location', () => {
    const route = buildOperatorCommandRoute({
      command: 'deep_scan',
      scenario: portScenario,
      droneId: 'uav-01',
      center: { lat: 37.7968, lng: -122.2845 },
      altitudeFt: 120,
    })

    expect(route.length).toBeGreaterThanOrEqual(5)
    expect(validateOperatorRoute(portScenario, 'uav-01', route).accepted).toBe(true)
  })

  it('preserves launch-origin planning when fromPosition is omitted', () => {
    const input = {
      command: 'route_lkl' as const,
      scenario: liveOriginScenario,
      droneId: 'uav-01',
      center: liveTarget,
      altitudeFt: 120,
    }

    expect(buildOperatorCommandRoute(input)).toEqual(buildOperatorCommandRoute({
      ...input,
      fromPosition: defaultDroneStartPosition(liveOriginScenario, 0),
    }))
  })

  it('plans and validates the first leg from the live aircraft position', () => {
    const input = {
      command: 'route_lkl' as const,
      scenario: liveOriginScenario,
      droneId: 'uav-01',
      center: liveTarget,
      altitudeFt: 120,
    }
    const legacyRoute = buildOperatorCommandRoute(input)
    const liveRoute = buildOperatorCommandRoute({ ...input, fromPosition: livePosition })

    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', legacyRoute).accepted).toBe(true)
    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', legacyRoute, livePosition).accepted).toBe(false)
    expect(liveRoute.length).toBeGreaterThan(legacyRoute.length)
    expect(validateOperatorRoute(liveOriginScenario, 'uav-01', liveRoute, livePosition).accepted).toBe(true)
  })

  it('generates deterministic route suggestions that require operator approval', () => {
    const input = {
      scenario: portScenario,
      droneId: 'uav-01',
      elapsedSec: 90,
      thermalDetections: [{ sourceId: 'hs-poi', class: 'generic-person' as const, position: { lat: 37.7985, lng: -122.2822 }, confidence: 0.8, tick: 90 }],
      warnings: ['thermal_contact'] as const,
    }

    const first = buildRouteSuggestions(input)
    const second = buildRouteSuggestions(input)

    expect(first).toEqual(second)
    expect(first[0]?.requiresApproval).toBe(true)
    expect(first[0]?.route.length).toBeGreaterThan(0)
  })

  it('suggests the next forward Rio Grande recharge route by sortie progress', () => {
    const suggestions = buildRouteSuggestions({
      scenario: rioGrande,
      droneId: 'uav-03',
      elapsedSec: 180,
      thermalDetections: [],
      warnings: [],
      sortieCount: 2,
      currentWaypointIndex: 0,
    })

    expect(suggestions[0]?.title).toBe('Forward recharge staging')
    expect(suggestions[0]?.rationale).toContain('Rio Grande City / US-83 Recharge')
    expect(suggestions[0]?.route[0]?.label).toContain('Rio Grande City / US-83 Recharge')
  })

  it('suggests a visible Rio Grande recharge route for the default selected drone', () => {
    const suggestions = buildRouteSuggestions({
      scenario: rioGrande,
      droneId: 'uav-01',
      elapsedSec: 0,
      thermalDetections: [],
      warnings: [],
      sortieCount: 0,
      currentWaypointIndex: 0,
    })

    expect(suggestions[0]?.title).toBe('Forward recharge staging')
    expect(suggestions[0]?.route.length).toBeGreaterThan(0)
  })
})

describe('operator terrain route warnings', () => {
  function raster(elevations?: Float32Array): TerrainRaster {
    const width = 101
    const height = 11
    const values = elevations ?? new Float32Array(width * height).fill(100)
    return {
      width,
      height,
      bounds: { west: 0, south: -0.001, east: 0.01, north: 0.001 },
      metersPerPixel: 100,
      surface: 'dtm-approx',
      minElevationM: Math.min(...values),
      maxElevationM: Math.max(...values),
      elevations: values,
    }
  }

  const waypoint = (id: string, lng: number, altitudeFt: number): Waypoint => ({
    id,
    position: { lat: 0, lng },
    altitudeFt,
  })

  it('reports missing fixture coverage without rejecting an otherwise legal route', () => {
    const scenario: ScenarioConfig = {
      ...liveOriginScenario,
      id: 'no-terrain-fixture',
      geofences: [],
    }
    const route = [{
      id: 'legal',
      position: scenario.startPosition,
      altitudeFt: 40,
    }]
    const result = validateOperatorRoute(scenario, 'uav-01', route)

    expect(result.accepted).toBe(true)
    expect(result.findings).toEqual([])
    expect(result.terrainWarnings).toMatchObject([{
      kind: 'no_fixture',
      requiredClearanceFt: REQUIRED_STRUCTURE_CLEARANCE_FT,
      surfaceClearanceFt: null,
    }])
  })

  it('samples at raster resolution and reports the deepest structure-clearance warning', () => {
    let surfaceLookups = 0
    const service = createTerrainOcclusionService(raster(), {
      structures: {
        topAt: (_lat, lng) => {
          surfaceLookups++
          return lng >= 0.004 && lng <= 0.006 ? 115 : null
        },
        maxTopM: 115,
      },
    })
    const warnings = auditTerrainClearance(
      'synthetic',
      'uav-01',
      [waypoint('cross-building', 0.008, 50)],
      { fromPosition: { lat: 0, lng: 0.002 }, service },
    )

    expect(surfaceLookups).toBeGreaterThanOrEqual(8)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({
      kind: 'structure_clearance',
      segmentId: 'start->cross-building',
      altitudeAglFt: 50,
      requiredClearanceFt: 20,
    })
    expect(warnings[0].structureHeightFt).toBeCloseTo(49.21, 1)
    expect(warnings[0].surfaceClearanceFt).toBeCloseTo(0.79, 1)
  })

  it('keeps AGL canonical over rising terrain and warns on a low bare-ground route', () => {
    const width = 101
    const height = 11
    const elevations = new Float32Array(width * height)
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) elevations[row * width + col] = 100 + col
    }
    const service = createTerrainOcclusionService(raster(elevations))
    const warnings = auditTerrainClearance(
      'synthetic-slope',
      'uav-01',
      [waypoint('slope-end', 0.009, 5)],
      { fromPosition: { lat: 0, lng: 0.001 }, service },
    )

    expect(warnings).toMatchObject([{
      kind: 'ground_clearance',
      surfaceClearanceFt: 5,
      requiredClearanceFt: REQUIRED_STRUCTURE_CLEARANCE_FT,
    }])
  })

  it('warns explicitly when any sampled part of a route leaves fixture coverage', () => {
    const service = createTerrainOcclusionService(raster())
    const warnings = auditTerrainClearance(
      'synthetic-outside',
      'uav-01',
      [waypoint('outside', 0.012, 120)],
      { fromPosition: { lat: 0, lng: 0.008 }, service },
    )

    expect(warnings).toMatchObject([{
      kind: 'outside_coverage',
      segmentId: 'start->outside',
      surfaceClearanceFt: null,
      structureHeightFt: null,
    }])
  })

  it('detects a committed demo_wildfire building using real terrain and Overture data', () => {
    const fixture = buildingFixtureFor('demo_wildfire')!
    const feature = fixture.features[0]
    const coordinate = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates[0][0]
      : feature.geometry.coordinates[0][0][0]
    const [lng, lat] = coordinate
    const altitudeFt = feature.properties.h / 0.3048
    const warnings = auditTerrainClearance(
      'demo_wildfire',
      'uav-01',
      [{ id: 'real-building', position: { lat, lng }, altitudeFt }],
      { fromPosition: { lat, lng } },
    )

    expect(warnings.some((warning) => warning.kind === 'structure_clearance')).toBe(true)
    const warning = warnings.find((candidate) => candidate.kind === 'structure_clearance')!
    expect(warning.requiredClearanceFt).toBe(20)
    // Fixture base is rounded independently from the decoded DEM, so roof-level AGL is close
    // to, rather than bit-exactly, zero clearance.
    expect(warning.surfaceClearanceFt).toBeLessThan(REQUIRED_STRUCTURE_CLEARANCE_FT)
    expect(Math.abs(warning.surfaceClearanceFt!)).toBeLessThan(2)
  })
})
