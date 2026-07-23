import { describe, expect, it } from 'vitest'
import { buildSuggestedRouteFeatures } from '@/components/TacticalMap'
import {
  buildingRenderMode,
  buildConflictFeatures,
  buildNextWpFeatures,
} from '@/components/tacticalMapGeoJson'
import type { DroneState, RouteSuggestion, Waypoint } from '@/types'

const baseDrone: DroneState = {
  id: 'uav-01',
  label: 'UAV-01',
  color: '#00d4ff',
  position: { lat: 37.7908, lng: -122.3933 },
  altitudeFt: 120,
  headingDeg: 0,
  speedMs: 0,
  batteryPct: 100,
  signalDbm: -55,
  missionState: 'navigate',
  currentWaypointIndex: 0,
  conflictFlag: false,
  geofenceBreachFlag: false,
  bvlosFlag: false,
  sortieCount: 0,
}

const fallbackWaypoints: Waypoint[] = [
  { id: 'fallback-1', position: { lat: 37.8000, lng: -122.3800 }, altitudeFt: 120 },
]

describe('TacticalMap GeoJSON builders', () => {
  it('uses 2.5D buildings only on desktop and 2D footprints in both phone modes', () => {
    expect(buildingRenderMode('desktop')).toBe('fill-extrusion')
    expect(buildingRenderMode('phone-portrait')).toBe('fill')
    expect(buildingRenderMode('phone-landscape')).toBe('fill')
  })

  it('builds next-waypoint line features from per-drone waypoints first', () => {
    const features = buildNextWpFeatures(
      [
        baseDrone,
        { ...baseDrone, id: 'uav-02', color: '#44ff88', missionState: 'hover' },
        { ...baseDrone, id: 'uav-03', color: '#ffaa00', missionState: 'launch' },
      ],
      {
        'uav-01': [
          { id: 'sf-01-bb-mid', position: { lat: 37.8058, lng: -122.3565 }, altitudeFt: 80 },
        ],
      },
      fallbackWaypoints,
    )

    expect(features).toHaveLength(2)
    expect(features[0]).toMatchObject({
      geometry: { type: 'LineString', coordinates: [[-122.3933, 37.7908], [-122.3565, 37.8058]] },
      properties: { color: '#00d4ff' },
    })
    expect(features[1]).toMatchObject({
      geometry: { type: 'LineString', coordinates: [[-122.3933, 37.7908], [-122.3800, 37.8000]] },
      properties: { color: '#44ff88' },
    })
  })

  it('builds conflict point features only for drones with active conflict flags', () => {
    const features = buildConflictFeatures([
      { ...baseDrone, conflictFlag: true },
      { ...baseDrone, id: 'uav-02', position: { lat: 37.8, lng: -122.35 }, conflictFlag: false },
    ])

    expect(features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-122.3933, 37.7908] },
        properties: { id: 'uav-01' },
      },
    ])
  })

  it('builds one proposal line per valid route across multiple drones', () => {
    const features = buildSuggestedRouteFeatures([
      suggestion('suggestion-a', 'uav-01', 'urgent', [
        waypoint('a1', 37.7908, -122.3933),
        waypoint('a2', 37.8058, -122.3565),
      ]),
      suggestion('suggestion-b', 'uav-02', 'routine', [
        waypoint('b1', 37.8000, -122.3800),
        waypoint('b2', 37.8100, -122.3700),
        waypoint('b3', 37.8200, -122.3600),
      ]),
    ])

    expect(features).toEqual([
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-122.3933, 37.7908], [-122.3565, 37.8058]] },
        properties: { droneId: 'uav-01', priority: 'urgent', suggestionId: 'suggestion-a' },
      },
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [[-122.38, 37.8], [-122.37, 37.81], [-122.36, 37.82]] },
        properties: { droneId: 'uav-02', priority: 'routine', suggestionId: 'suggestion-b' },
      },
    ])
  })

  it('renders proposals without selected-drone context and excludes invalid short routes', () => {
    const features = buildSuggestedRouteFeatures([
      suggestion('valid', 'uav-03', 'critical', [
        waypoint('c1', 37.79, -122.39),
        waypoint('c2', 37.80, -122.38),
      ]),
      suggestion('short', 'uav-01', 'advisory', [waypoint('short-1', 37.79, -122.39)]),
      suggestion('invalid', 'uav-02', 'routine', [
        waypoint('invalid-1', 37.79, -122.39),
        waypoint('invalid-2', Number.NaN, -122.38),
      ]),
    ])

    expect(features).toHaveLength(1)
    expect(features[0].properties).toEqual({
      droneId: 'uav-03', priority: 'critical', suggestionId: 'valid',
    })
  })
})

function suggestion(
  id: string,
  droneId: string,
  priority: RouteSuggestion['priority'],
  route: Waypoint[],
): RouteSuggestion {
  return {
    id,
    droneId,
    source: 'TACTICAL ADVISOR',
    priority,
    title: id,
    rationale: 'test',
    riskLevel: priority,
    route,
    requiresApproval: true,
    createdAtSec: 1,
  }
}

function waypoint(id: string, lat: number, lng: number): Waypoint {
  return { id, position: { lat, lng }, altitudeFt: 120 }
}
