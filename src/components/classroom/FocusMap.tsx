import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { DroneState, LatLng } from '@/types'
import { offsetLatLng } from '@/utils/geometry'
import { stateColor } from '@/components/classroom/tileRenderer'
import { stateToCode } from '@/classroom/gridFrame'
import type { BackdropGeometry } from '@/components/classroom/tileRenderer'

// Real MapLibre basemap for the FOCUSED student (COORDINATOR_BUILD_PLAN §16.2:
// "The focused single-student view uses a real MapLibre map and gets the desktop treatment").
//
// WHY THIS IS SAFE HERE AND NOT ON THE WALL. Browsers cap live WebGL contexts at roughly 8-16,
// so a class of 40 tiles cannot each own a map — that is why the wall is Canvas 2D. But exactly
// ONE student is ever focused, so the focus pane costs exactly one context. The constraint was
// never "no maps in the console", it was "no map PER TILE".
//
// The instructor now sees the same streets, the same buildings and the same terrain the student
// is flying over, instead of geometry floating on a flat field.

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const FALLBACK_MS = 4500

/** Same flat background the wall tiles use, so a failed basemap degrades to a familiar look. */
const LOCAL_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Local demo fallback',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b0f17' } }],
}

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

/** Length of the heading tick, in metres, so it scales with the map rather than the screen. */
const HEADING_TICK_M = 55

function lineFeature(points: LatLng[], props: Record<string, unknown> = {}): GeoJSON.Feature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: points.map((p) => [p.lng, p.lat]) },
    properties: props,
  }
}

function polygonFeature(ring: LatLng[], props: Record<string, unknown> = {}): GeoJSON.Feature {
  const coords = ring.map((p) => [p.lng, p.lat])
  if (coords.length > 0) coords.push(coords[0])
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: props }
}

function collection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features }
}

/** Static mission geometry — drawn once per class, exactly what the wall backdrop shows. */
function geometryCollections(geo: BackdropGeometry) {
  return {
    geofences: collection((geo.geofences ?? []).map((ring) => polygonFeature(ring))),
    searchAreas: collection((geo.searchAreas ?? []).map((ring) => polygonFeature(ring))),
    routes: collection((geo.routes ?? []).filter((r) => r.length > 1).map((r) => lineFeature(r))),
    sites: collection((geo.sites ?? []).map((s) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      properties: {},
    }))),
  }
}

function droneCollections(drones: readonly DroneState[]) {
  const bodies: GeoJSON.Feature[] = []
  const headings: GeoJSON.Feature[] = []
  for (const d of drones) {
    const color = stateColor(stateToCode(d.missionState))
    bodies.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [d.position.lng, d.position.lat] },
      properties: { color, label: d.label ?? d.id },
    })
    // A short tick rather than a rotated sprite: no icon image to load, so it renders identically
    // on the real basemap and on the offline fallback, and it can never trip a missing-image error.
    const tip = offsetLatLng(d.position, d.headingDeg, HEADING_TICK_M)
    headings.push(lineFeature([d.position, tip], { color }))
  }
  return { bodies: collection(bodies), headings: collection(headings) }
}

export interface FocusMapProps {
  geometry: BackdropGeometry
  drones: readonly DroneState[]
  /** Mission extents the map frames on load. */
  fitPoints: LatLng[]
  /**
   * Rendered instead of the map when WebGL is unavailable. Not a nicety: locked-down machines,
   * remote-desktop sessions and headless test environments have no WebGL, and an instructor
   * console that throws on those is worse than one that draws a plot.
   */
  fallback?: React.ReactNode
}

export function FocusMap({ geometry, drones, fitPoints, fallback }: FocusMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const readyRef = useRef(false)
  const [ready, setReady] = useState(false)
  const [offline, setOffline] = useState(false)
  const [unsupported, setUnsupported] = useState(false)

  // ── Map lifecycle: created once, never re-created on data change ────────────
  useEffect(() => {
    if (!containerRef.current) return

    let map: maplibregl.Map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: MAP_STYLE,
        center: [-122.4862, 37.7695],
        zoom: 13,
        attributionControl: {
          compact: true,
          customAttribution: [
            '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
            '© OpenFreeMap',
          ],
        },
      })
    } catch (err) {
      // Construction throws outright when the context cannot be created. Degrade to the plot
      // rather than taking the console down with us.
      console.warn('[FocusMap] WebGL unavailable — falling back to the 2D plot:', err)
      setUnsupported(true)
      return
    }
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

    // Same discipline as TacticalMap: fall back only when the STYLE never arrives. Gating on the
    // `load` event instead would throw away a working basemap whenever tiles render slowly.
    let styleParsed = false
    let fellBack = false
    const fallBack = (reason: string) => {
      if (styleParsed || fellBack) return
      fellBack = true
      console.warn(`[FocusMap] basemap unavailable — using offline fallback (${reason})`)
      setOffline(true)
      map.setStyle(LOCAL_STYLE)
    }
    const timer = window.setTimeout(() => fallBack('style did not load within timeout'), FALLBACK_MS)
    map.on('style.load', () => { styleParsed = true })
    map.on('error', (event) => {
      if (styleParsed) return   // incidental tile/glyph error; MapLibre retries on its own
      fallBack(`style load failed: ${event.error?.message ?? 'unknown error'}`)
    })

    // Layers are registered on every style load, because setStyle() discards them.
    const registerLayers = () => {
      const src = (id: string, data: GeoJSON.FeatureCollection) => {
        if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data })
      }
      src('focus-geofences', EMPTY)
      src('focus-search', EMPTY)
      src('focus-routes', EMPTY)
      src('focus-sites', EMPTY)
      src('focus-headings', EMPTY)
      src('focus-drones', EMPTY)

      if (!map.getLayer('focus-geofence-fill')) {
        map.addLayer({
          id: 'focus-geofence-fill', type: 'fill', source: 'focus-geofences',
          paint: { 'fill-color': '#ff4d4d', 'fill-opacity': 0.08 },
        })
        map.addLayer({
          id: 'focus-geofence-line', type: 'line', source: 'focus-geofences',
          paint: { 'line-color': '#ff4d4d', 'line-width': 1.5, 'line-opacity': 0.8 },
        })
        map.addLayer({
          id: 'focus-search-line', type: 'line', source: 'focus-search',
          paint: { 'line-color': '#40dcff', 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [3, 2] },
        })
        map.addLayer({
          id: 'focus-route-line', type: 'line', source: 'focus-routes',
          paint: { 'line-color': '#8a94a6', 'line-width': 1.2, 'line-opacity': 0.65, 'line-dasharray': [4, 3] },
        })
        map.addLayer({
          id: 'focus-site-dot', type: 'circle', source: 'focus-sites',
          paint: {
            'circle-radius': 4, 'circle-color': '#8a94a6',
            'circle-stroke-width': 1, 'circle-stroke-color': '#0b0f17',
          },
        })
        map.addLayer({
          id: 'focus-heading-line', type: 'line', source: 'focus-headings',
          paint: { 'line-color': ['get', 'color'], 'line-width': 2 },
        })
        map.addLayer({
          id: 'focus-drone-dot', type: 'circle', source: 'focus-drones',
          paint: {
            'circle-radius': 6, 'circle-color': ['get', 'color'],
            'circle-stroke-width': 2, 'circle-stroke-color': '#0b0f17',
          },
        })
      }
      readyRef.current = true
      setReady(true)
    }

    map.on('style.load', registerLayers)
    map.on('load', registerLayers)

    return () => {
      window.clearTimeout(timer)
      readyRef.current = false
      mapRef.current = null
      map.remove()
    }
  }, [])

  // ── Static mission geometry ────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const data = geometryCollections(geometry)
    const set = (id: string, fc: GeoJSON.FeatureCollection) => {
      const source = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      source?.setData(fc)
    }
    set('focus-geofences', data.geofences)
    set('focus-search', data.searchAreas)
    set('focus-routes', data.routes)
    set('focus-sites', data.sites)
  }, [geometry, ready])

  // ── Frame the mission once the map and its extents exist ───────────────────
  const fittedRef = useRef(false)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || fittedRef.current || fitPoints.length === 0) return
    const bounds = new maplibregl.LngLatBounds()
    for (const p of fitPoints) bounds.extend([p.lng, p.lat])
    map.fitBounds(bounds, { padding: 48, duration: 0, maxZoom: 16 })
    fittedRef.current = true
  }, [fitPoints, ready])

  // ── Live drones ────────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const { bodies, headings } = droneCollections(drones)
    ;(map.getSource('focus-drones') as maplibregl.GeoJSONSource | undefined)?.setData(bodies)
    ;(map.getSource('focus-headings') as maplibregl.GeoJSONSource | undefined)?.setData(headings)
  }, [drones, ready])

  if (unsupported && fallback) return <>{fallback}</>

  return (
    <div className="cls-focus-map">
      <div ref={containerRef} className="cls-focus-map-canvas" />
      {offline && (
        <div className="cls-focus-map-badge" title="The basemap could not be reached; mission geometry is still live.">
          OFFLINE BASEMAP
        </div>
      )}
    </div>
  )
}
