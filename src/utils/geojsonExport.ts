import type { DroneState, LatLng, ScenarioConfig, ThermalDetection } from '@/types'

type GeoJSONFeature = {
  type: 'Feature'
  geometry:
    | { type: 'Point'; coordinates: [number, number] | [number, number, number] }
    | { type: 'LineString'; coordinates: Array<[number, number, number]> }
    | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }
  properties: Record<string, unknown>
}

function pt(pos: LatLng, altM?: number): [number, number] | [number, number, number] {
  return altM !== undefined ? [pos.lng, pos.lat, altM] : [pos.lng, pos.lat]
}

/**
 * Exports a GeoJSON FeatureCollection with:
 * - drone_path LineString per drone (from position history)
 * - waypoint Points
 * - geofence Polygons
 * - search_area Polygon
 * - thermal_detection Points (deduplicated by sourceId)
 * - base Point
 */
export function buildGeoJSON(
  drones: DroneState[],
  positionHistory: Record<string, LatLng[]>,
  scenario: ScenarioConfig,
  thermalDetections: ThermalDetection[],
): string {
  const features: GeoJSONFeature[] = []
  const ts = new Date().toISOString()

  // Base position
  features.push({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [scenario.startPosition.lng, scenario.startPosition.lat] },
    properties: { feature_type: 'base', label: 'Launch/Recovery', scenario: scenario.id },
  })

  // Flight paths
  for (const drone of drones) {
    const positions = positionHistory[drone.id] ?? []
    if (positions.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: positions.map((p) => pt(p, drone.altitudeFt * 0.3048) as [number, number, number]),
        },
        properties: {
          feature_type: 'drone_path',
          drone_id: drone.id,
          drone_label: drone.label,
          color: drone.color,
          final_battery_pct: Math.round(drone.batteryPct),
          final_state: drone.missionState,
          point_count: positions.length,
          exported_at: ts,
        },
      })
    }

    // Final position
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pt(drone.position, drone.altitudeFt * 0.3048) as [number, number, number] },
      properties: {
        feature_type: 'drone_final_position',
        drone_id: drone.id,
        label: drone.label,
        state: drone.missionState,
        battery_pct: Math.round(drone.batteryPct),
        altitude_ft: Math.round(drone.altitudeFt),
        signal_dbm: drone.signalDbm,
      },
    })
  }

  // Waypoints
  for (const wp of scenario.waypoints) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: pt(wp.position, wp.altitudeFt * 0.3048) as [number, number, number] },
      properties: {
        feature_type: 'waypoint',
        id: wp.id,
        label: wp.label ?? wp.id,
        altitude_ft: wp.altitudeFt,
      },
    })
  }

  // Geofences
  for (const gf of scenario.geofences) {
    const ring = [...gf.polygon, gf.polygon[0]].map((p) => [p.lng, p.lat] as [number, number])
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        feature_type: 'geofence',
        id: gf.id,
        label: gf.label,
        type: gf.type,
        max_altitude_ft: gf.maxAltitudeFt,
      },
    })
  }

  // SAR search area
  if (scenario.searchArea && scenario.searchArea.length >= 3) {
    const ring = [...scenario.searchArea, scenario.searchArea[0]].map((p) => [p.lng, p.lat] as [number, number])
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [ring] },
      properties: {
        feature_type: 'search_area',
        scenario: scenario.id,
        mission_type: scenario.missionType,
      },
    })
  }

  // Thermal heat sources (scenario-defined)
  for (const hs of scenario.heatSources) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [hs.position.lng, hs.position.lat] },
      properties: {
        feature_type: 'heat_source',
        id: hs.id,
        class: hs.class,
        temp_c: hs.tempC,
        radius_m: hs.radiusM,
      },
    })
  }

  // Thermal detections (deduplicated by sourceId — latest detection wins)
  const bySource = new Map<string, ThermalDetection>()
  for (const det of thermalDetections) bySource.set(det.sourceId, det)
  for (const det of bySource.values()) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [det.position.lng, det.position.lat] },
      properties: {
        feature_type: 'thermal_detection',
        source_id: det.sourceId,
        class: det.class,
        confidence: Math.round(det.confidence * 100),
        tick: det.tick,
      },
    })
  }

  const collection = {
    type: 'FeatureCollection',
    name: `Mission: ${scenario.name}`,
    description: `SIMULATION ONLY — Seed: ${scenario.seed} — Exported: ${ts}`,
    features,
  }

  return JSON.stringify(collection, null, 2)
}
