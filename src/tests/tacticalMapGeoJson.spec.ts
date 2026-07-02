import { describe, expect, it } from 'vitest'
import { buildConflictFeatures, buildNextWpFeatures } from '@/components/tacticalMapGeoJson'
import type { DroneState, Waypoint } from '@/types'

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
})
