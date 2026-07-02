import type { DroneState, LatLng, ScenarioConfig, ThermalDetection } from '@/types'

function hexToKmlColor(hex: string): string {
  // KML color is aabbggrr
  const c = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  return `ff${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`
}

function isoNow(): string {
  return new Date().toISOString()
}

function coordStr(pos: LatLng, altM = 0): string {
  return `${pos.lng},${pos.lat},${altM.toFixed(1)}`
}

/**
 * Exports a full KML document with:
 * - LineString flight path per drone (with timestamps)
 * - Final position placemarks
 * - Waypoint placemarks
 * - Geofence polygons
 * - SAR search area polygon
 * - Thermal detection markers
 */
export function buildFullKML(
  drones: DroneState[],
  positionHistory: Record<string, LatLng[]>,
  scenario: ScenarioConfig,
  thermalDetections: ThermalDetection[],
): string {
  const ts = isoNow()

  // Style defs for each drone
  const droneStyles = drones.map((d) => `
    <Style id="drone-${d.id}">
      <IconStyle>
        <color>${hexToKmlColor(d.color)}</color>
        <scale>0.8</scale>
        <Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
      </IconStyle>
      <LineStyle>
        <color>${hexToKmlColor(d.color)}</color>
        <width>3</width>
      </LineStyle>
    </Style>`).join('')

  // Flight path LineString per drone
  const paths = drones.map((d) => {
    const positions = positionHistory[d.id] ?? []
    if (positions.length < 2) return ''
    const coords = positions.map((p) => {
      const altM = (d.altitudeFt * 0.3048)
      return coordStr(p, altM)
    }).join('\n          ')
    return `
    <Placemark>
      <name>${d.label} — Flight Path</name>
      <description>Sampled flight track — ${positions.length} points</description>
      <styleUrl>#drone-${d.id}</styleUrl>
      <TimeSpan><begin>${ts}</begin></TimeSpan>
      <LineString>
        <tessellate>1</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>
          ${coords}
        </coordinates>
      </LineString>
    </Placemark>`
  }).join('')

  // Final position placemarks
  const finalPos = drones.map((d) => `
    <Placemark>
      <name>${d.label} — Final Position</name>
      <description>State: ${d.missionState} | Battery: ${Math.round(d.batteryPct)}% | Alt: ${Math.round(d.altitudeFt)}ft</description>
      <styleUrl>#drone-${d.id}</styleUrl>
      <Point>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${coordStr(d.position, d.altitudeFt * 0.3048)}</coordinates>
      </Point>
    </Placemark>`).join('')

  // Waypoints
  const waypoints = scenario.waypoints.map((wp, i) => `
    <Placemark>
      <name>${wp.label ?? `WP${i + 1}`}</name>
      <description>Alt: ${wp.altitudeFt}ft AGL</description>
      <Style><IconStyle><color>ff00aaff</color><scale>0.7</scale></IconStyle></Style>
      <Point>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>${coordStr(wp.position, wp.altitudeFt * 0.3048)}</coordinates>
      </Point>
    </Placemark>`).join('')

  // Geofence polygons
  const geofences = scenario.geofences.map((gf) => {
    const ring = [...gf.polygon, gf.polygon[0]].map((p) => coordStr(p)).join(' ')
    return `
    <Placemark>
      <name>${gf.label}</name>
      <description>Type: ${gf.type} | Max Alt: ${gf.maxAltitudeFt}ft</description>
      <Style>
        <LineStyle><color>ff4444ff</color><width>2</width></LineStyle>
        <PolyStyle><color>224444ff</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`
  }).join('')

  // SAR search area
  const searchArea = scenario.searchArea && scenario.searchArea.length >= 3 ? (() => {
    const ring = [...scenario.searchArea, scenario.searchArea[0]].map((p) => coordStr(p)).join(' ')
    return `
    <Placemark>
      <name>SAR Search Area</name>
      <description>Scenario: ${scenario.name}</description>
      <Style>
        <LineStyle><color>ff00aaff</color><width>2</width></LineStyle>
        <PolyStyle><color>1100aaff</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`
  })() : ''

  // Thermal detections (unique by sourceId)
  const bySource = new Map<string, ThermalDetection>()
  for (const det of thermalDetections) bySource.set(det.sourceId, det)
  const thermalMarkers = Array.from(bySource.values()).map((det) => `
    <Placemark>
      <name>THERMAL: ${det.class}</name>
      <description>Confidence: ${Math.round(det.confidence * 100)}% | Tick: ${det.tick}</description>
      <Style><IconStyle><color>ff0066ff</color><scale>0.9</scale></IconStyle></Style>
      <Point><coordinates>${coordStr(det.position)}</coordinates></Point>
    </Placemark>`).join('')

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>Mission: ${scenario.name}</name>
    <description>Exported from Autonomous Drone Mission Simulator — SIMULATION ONLY — Seed: ${scenario.seed} — ${ts}</description>
    ${droneStyles}
    <Folder>
      <name>Flight Paths</name>${paths}
    </Folder>
    <Folder>
      <name>Final Positions</name>${finalPos}
    </Folder>
    <Folder>
      <name>Waypoints</name>${waypoints}
    </Folder>
    <Folder>
      <name>Airspace</name>${geofences}${searchArea}
    </Folder>
    <Folder>
      <name>Thermal Contacts (${bySource.size})</name>${thermalMarkers}
    </Folder>
  </Document>
</kml>`
}
