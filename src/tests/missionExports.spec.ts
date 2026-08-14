// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { buildFullKML } from '@/utils/kmlExport'
import { buildGeoJSON } from '@/utils/geojsonExport'
import type { DroneState, LatLng, ScenarioConfig, ThermalDetection } from '@/types'

// Audit F-09: the KML/GeoJSON export builders had zero direct coverage. They are the
// evidence hand-off surface (mission review in Google Earth / GIS tools), so a silently
// malformed document — bad escaping, an unclosed ring, wrong coordinate order — would
// ship without failing any test. jsdom environment so DOMParser can prove the KML is
// well-formed XML rather than just string-matching fragments.

const BASE: LatLng = { lat: 47.6, lng: -122.33 }

// Names deliberately carry every XML-special character the exporter must escape.
const HOSTILE_NAME = 'Export <Test> & "Quotes" & \'Apos\''

function syntheticScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'test_export',
    name: HOSTILE_NAME,
    description: 'synthetic export fixture',
    seed: 7,
    droneCount: 2,
    missionType: 'sar_parallel',
    startPosition: BASE,
    waypoints: [
      { id: 'wp-1', position: { lat: 47.61, lng: -122.32 }, altitudeFt: 200, label: 'Ingress <A> & B' },
      { id: 'wp-2', position: { lat: 47.62, lng: -122.31 }, altitudeFt: 250 }, // no label -> fallback naming
    ],
    searchArea: [
      { lat: 47.6, lng: -122.34 },
      { lat: 47.63, lng: -122.34 },
      { lat: 47.63, lng: -122.3 },
    ],
    geofences: [{
      id: 'gf-1',
      label: 'Zone <No-Fly> & Hospital',
      polygon: [
        { lat: 47.59, lng: -122.35 },
        { lat: 47.595, lng: -122.35 },
        { lat: 47.595, lng: -122.345 },
      ],
      maxAltitudeFt: 400,
      type: 'no_fly',
    }],
    heatSources: [{
      id: 'hs-1', class: 'generic-person', position: { lat: 47.615, lng: -122.325 }, tempC: 36, radiusM: 3,
    }],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.05,
    commsLossWindows: [],
    ...overrides,
  }
}

function drone(id: string, overrides: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: `${id.toUpperCase()} <lead> & "wing"`,
    color: '#00d4ff',
    position: { lat: 47.605, lng: -122.328 },
    altitudeFt: 180,
    headingDeg: 90,
    speedMs: 12,
    batteryPct: 76.4,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 1,
    ...overrides,
  }
}

const HISTORY: Record<string, LatLng[]> = {
  // uav-1 has a real track; uav-2 has a single sample, below the 2-point LineString minimum.
  'uav-1': [BASE, { lat: 47.602, lng: -122.329 }, { lat: 47.605, lng: -122.328 }],
  'uav-2': [BASE],
}

// Same sourceId twice: exports must deduplicate, latest detection winning.
const DETECTIONS: ThermalDetection[] = [
  { sourceId: 'hs-1', class: 'generic-person', position: { lat: 47.6149, lng: -122.3251 }, confidence: 0.4, tick: 100 },
  { sourceId: 'hs-1', class: 'generic-person', position: { lat: 47.615, lng: -122.325 }, confidence: 0.9, tick: 250 },
]

function parseKml(kml: string): Document {
  const doc = new DOMParser().parseFromString(kml, 'application/xml')
  // jsdom (like browsers) reports XML syntax errors as a parsererror element
  // instead of throwing — an unescaped '<' or '&' in a name would surface here.
  expect(doc.querySelector('parsererror')).toBeNull()
  return doc
}

function placemarkNames(scope: Element | Document): string[] {
  return Array.from(scope.querySelectorAll('Placemark > name')).map((n) => n.textContent ?? '')
}

function folderByName(doc: Document, prefix: string): Element {
  const folder = Array.from(doc.querySelectorAll('Folder')).find((f) =>
    f.querySelector(':scope > name')?.textContent?.startsWith(prefix))
  expect(folder, `folder "${prefix}" present`).toBeTruthy()
  return folder!
}

describe('buildFullKML', () => {
  const scenario = syntheticScenario()
  const drones = [drone('uav-1'), drone('uav-2', { missionState: 'landed', batteryPct: 12.6 })]
  const kml = buildFullKML(drones, HISTORY, scenario, DETECTIONS)

  it('produces well-formed XML with hostile characters escaped and round-tripped intact', () => {
    const doc = parseKml(kml)
    // The raw string must be escaped (source-level guard)...
    expect(kml).not.toContain(`<name>${HOSTILE_NAME}`)
    expect(kml).toContain('&amp;')
    // ...and the parsed document must recover the original text exactly.
    expect(doc.querySelector('Document > name')?.textContent).toBe(`Mission: ${HOSTILE_NAME}`)
    expect(placemarkNames(doc)).toContain('Ingress <A> & B')
  })

  it('emits one flight path per drone with >=2 samples, and final positions for all drones', () => {
    const doc = parseKml(kml)
    // uav-2 has a single history point: no LineString for it, but its final Point remains.
    const paths = folderByName(doc, 'Flight Paths').querySelectorAll('Placemark')
    expect(paths).toHaveLength(1)
    const coords = paths[0].querySelector('LineString > coordinates')?.textContent?.trim().split(/\s+/)
    expect(coords).toHaveLength(HISTORY['uav-1'].length)
    // KML coordinate order is lng,lat[,alt] — a swap here renders tracks in the ocean.
    expect(coords![0].startsWith(`${BASE.lng},${BASE.lat}`)).toBe(true)

    const finals = folderByName(doc, 'Final Positions').querySelectorAll('Placemark')
    expect(finals).toHaveLength(2)
    expect(placemarkNames(doc)).toContain(`${drones[1].label} — Final Position`)
  })

  it('exports waypoints (with fallback names), a closed geofence ring, and the search area', () => {
    const doc = parseKml(kml)
    const names = placemarkNames(folderByName(doc, 'Waypoints'))
    expect(names).toEqual(['Ingress <A> & B', 'WP2'])

    const airspace = folderByName(doc, 'Airspace')
    const rings = Array.from(airspace.querySelectorAll('LinearRing > coordinates'))
    expect(rings).toHaveLength(2) // geofence + SAR search area
    for (const ring of rings) {
      const pts = ring.textContent!.trim().split(/\s+/)
      // Polygons must close (first point repeated) or GIS tools reject/misdraw them.
      expect(pts[0]).toBe(pts[pts.length - 1])
      expect(pts.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('deduplicates thermal detections by sourceId', () => {
    const doc = parseKml(kml)
    const folder = folderByName(doc, 'Thermal Contacts')
    expect(folder.querySelector(':scope > name')?.textContent).toBe('Thermal Contacts (1)')
    const marks = folder.querySelectorAll('Placemark')
    expect(marks).toHaveLength(1)
    // Latest detection wins — its confidence/tick are what the reviewer sees.
    expect(marks[0].querySelector('description')?.textContent).toContain('Confidence: 90%')
  })

  it('stays well-formed for an empty run (no history, no detections, no search area)', () => {
    const bare = syntheticScenario({ searchArea: undefined })
    const doc = parseKml(buildFullKML([drone('uav-1')], {}, bare, []))
    expect(folderByName(doc, 'Flight Paths').querySelectorAll('Placemark')).toHaveLength(0)
    expect(folderByName(doc, 'Airspace').querySelectorAll('LinearRing')).toHaveLength(1)
    expect(folderByName(doc, 'Final Positions').querySelectorAll('Placemark')).toHaveLength(1)
  })
})

interface ParsedFeature {
  type: string
  geometry: { type: string; coordinates: unknown }
  properties: Record<string, unknown>
}

function parseGeoJson(json: string): { type: string; name: string; features: ParsedFeature[] } {
  return JSON.parse(json) as { type: string; name: string; features: ParsedFeature[] }
}

function byType(features: ParsedFeature[], featureType: string): ParsedFeature[] {
  return features.filter((f) => f.properties.feature_type === featureType)
}

describe('buildGeoJSON', () => {
  const scenario = syntheticScenario()
  const drones = [drone('uav-1'), drone('uav-2', { missionState: 'landed' })]
  const collection = parseGeoJson(buildGeoJSON(drones, HISTORY, scenario, DETECTIONS))

  it('emits a FeatureCollection with the expected feature census', () => {
    expect(collection.type).toBe('FeatureCollection')
    // JSON needs no XML escaping, but hostile characters must still survive verbatim.
    expect(collection.name).toBe(`Mission: ${HOSTILE_NAME}`)
    expect(collection.features.every((f) => f.type === 'Feature')).toBe(true)

    expect(byType(collection.features, 'base')).toHaveLength(1)
    expect(byType(collection.features, 'drone_path')).toHaveLength(1) // uav-2 lacks 2 samples
    expect(byType(collection.features, 'drone_final_position')).toHaveLength(2)
    expect(byType(collection.features, 'waypoint')).toHaveLength(2)
    expect(byType(collection.features, 'geofence')).toHaveLength(1)
    expect(byType(collection.features, 'search_area')).toHaveLength(1)
    expect(byType(collection.features, 'heat_source')).toHaveLength(1)
    expect(byType(collection.features, 'thermal_detection')).toHaveLength(1) // deduped by sourceId
  })

  it('uses GeoJSON [lng, lat] coordinate order and the right geometry type per feature', () => {
    const base = byType(collection.features, 'base')[0]
    expect(base.geometry.type).toBe('Point')
    expect(base.geometry.coordinates).toEqual([BASE.lng, BASE.lat])

    const path = byType(collection.features, 'drone_path')[0]
    expect(path.geometry.type).toBe('LineString')
    const coords = path.geometry.coordinates as [number, number, number][]
    expect(coords).toHaveLength(HISTORY['uav-1'].length)
    expect(coords[0][0]).toBe(BASE.lng)
    expect(coords[0][1]).toBe(BASE.lat)
    expect(path.properties.drone_id).toBe('uav-1')
    expect(path.properties.point_count).toBe(3)

    for (const poly of [...byType(collection.features, 'geofence'), ...byType(collection.features, 'search_area')]) {
      expect(poly.geometry.type).toBe('Polygon')
      const ring = (poly.geometry.coordinates as [number, number][][])[0]
      expect(ring[0]).toEqual(ring[ring.length - 1]) // closed ring, RFC 7946 §3.1.6
      expect(ring.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('keeps waypoint fallback labels and the latest thermal detection after dedupe', () => {
    const waypoints = byType(collection.features, 'waypoint')
    expect(waypoints.map((w) => w.properties.label)).toEqual(['Ingress <A> & B', 'wp-2'])

    const detection = byType(collection.features, 'thermal_detection')[0]
    expect(detection.properties.tick).toBe(250)
    expect(detection.properties.confidence).toBe(90)
  })

  it('handles an empty run: no paths or search area, but base and final positions remain', () => {
    const bare = parseGeoJson(buildGeoJSON([drone('uav-1')], {}, syntheticScenario({ searchArea: undefined }), []))
    expect(byType(bare.features, 'drone_path')).toHaveLength(0)
    expect(byType(bare.features, 'search_area')).toHaveLength(0)
    expect(byType(bare.features, 'thermal_detection')).toHaveLength(0)
    expect(byType(bare.features, 'base')).toHaveLength(1)
    expect(byType(bare.features, 'drone_final_position')).toHaveLength(1)
  })
})
