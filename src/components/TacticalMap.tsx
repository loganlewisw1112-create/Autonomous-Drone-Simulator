import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { generateGridLines } from '@/sim/mission/SARPlanner'
import { PerfMonitor } from '@/components/PerfMonitor'
import { MissionStatusFeed } from '@/components/MissionStatusFeed'
import { OperatorCommandPanel } from '@/components/OperatorCommandPanel'
import { buildConflictFeatures, buildIrFootprintFeatures, buildNextWpFeatures } from '@/components/tacticalMapGeoJson'
import { buildAirspaceReservationFeatures, buildExternalTrafficFeatures, buildUtmAirspaceState } from '@/sim/demo/utmEngine'
import { useDeviceMode, type DeviceMode } from '@/hooks/useDeviceMode'
import type { LatLng, ScenarioConfig } from '@/types'

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const MAP_FALLBACK_MS = 4500

export type MapMode = 'remote' | 'fallback'

export function parseMapMode(search: string): MapMode {
  return new URLSearchParams(search).get('map') === 'fallback' ? 'fallback' : 'remote'
}

export const LOCAL_DEMO_MAP_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Local demo fallback',
  sources: {},
  layers: [{
    id: 'demo-background',
    type: 'background',
    paint: { 'background-color': '#0a1520' },
  }],
}

const TRAIL_COLORS: Record<string, string> = {
  'uav-01': '#00d4ff',
  'uav-02': '#44ff88',
  'uav-03': '#ffaa00',
  'uav-04': '#ff88ff',
  'uav-05': '#ff6644',
  'uav-06': '#cc44ff',
  'uav-07': '#ffdd00',
  'uav-08': '#ff4488',
}

// Tactical node marker — circle + heading chevron, no aircraft detail
const DRONE_NODE_SVG = (color: string, state: string): string => {
  if (state === 'hover') {
    // Dashed outer ring + small dot — visually "settled/loitering"
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
      <circle cx="16" cy="16" r="14" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.5"/>
      <circle cx="16" cy="16" r="4" fill="${color}" opacity="0.9"/>
    </svg>`
  }
  if (state === 'idle' || state === 'preflight' || state === 'landed' || state === 'recharge') {
    // Dim dot only — parked at base
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
      <circle cx="16" cy="16" r="5" fill="${color}" opacity="0.4"/>
    </svg>`
  }
  // Flying: solid ring + inner dot + heading chevron (pointing north = 0°, rotated by parent)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
    <circle cx="16" cy="16" r="14" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.45"/>
    <circle cx="16" cy="16" r="6" fill="${color}" opacity="0.95"/>
    <polygon points="16,3 19.5,10 12.5,10" fill="${color}" opacity="1"/>
  </svg>`
}

// States that count as "in the air" for camera follow, HUD display, and next-wp lines
const FLYING_STATES = new Set(['navigate', 'launch', 'sar_grid', 'return_to_base', 'hover'])

// ── WS7: camera envelope fit ────────────────────────────────────────────────
// [[minLng, minLat], [maxLng, maxLat]] — the LngLatBoundsLike tuple shape MapLibre's
// fitBounds() accepts.
export type ScenarioBounds = [[number, number], [number, number]]

// Floor on the box's lng/lat span so a single-point (or all-identical-point) scenario
// still produces a real, non-zero-area box. Without this, fitBounds on a zero-area box
// zooms in to (near-)infinity instead of just centering on the point.
const MIN_BOUNDS_SPAN_DEG = 0.006 // roughly 500-650m depending on latitude

// Pure and exported so it's unit-testable without a live MapLibre instance — collects
// every site/route/waypoint position the scenario carries into one envelope.
export function computeScenarioBounds(scenario: ScenarioConfig): ScenarioBounds {
  const points: LatLng[] = [scenario.startPosition, ...scenario.waypoints.map((wp) => wp.position)]
  if (scenario.perDroneWaypoints) {
    Object.values(scenario.perDroneWaypoints).forEach((wps) => wps.forEach((wp) => points.push(wp.position)))
  }
  if (scenario.launchSites) Object.values(scenario.launchSites).forEach((site) => points.push(site.position))
  if (scenario.recoverySites) Object.values(scenario.recoverySites).forEach((site) => points.push(site.position))

  let minLng = Math.min(...points.map((p) => p.lng))
  let maxLng = Math.max(...points.map((p) => p.lng))
  let minLat = Math.min(...points.map((p) => p.lat))
  let maxLat = Math.max(...points.map((p) => p.lat))

  if (maxLng - minLng < MIN_BOUNDS_SPAN_DEG) {
    const c = (minLng + maxLng) / 2
    minLng = c - MIN_BOUNDS_SPAN_DEG / 2
    maxLng = c + MIN_BOUNDS_SPAN_DEG / 2
  }
  if (maxLat - minLat < MIN_BOUNDS_SPAN_DEG) {
    const c = (minLat + maxLat) / 2
    minLat = c - MIN_BOUNDS_SPAN_DEG / 2
    maxLat = c + MIN_BOUNDS_SPAN_DEG / 2
  }

  return [[minLng, minLat], [maxLng, maxLat]]
}

// Padding/zoom-cap split between shells: the mobile shell overlays the map canvas with a
// slim top bar, a bottom dock, edge-drawer tabs, and (on notched phones) safe-area insets
// that desktop never has — so the fit needs extra clearance on every side, plus a zoom
// ceiling so a tight single-site envelope doesn't zoom in past a useful mission overview.
// Desktop's frozen grid has none of that chrome over the map and keeps its prior
// 16-level mission-start zoom ceiling.
function scenarioFitOptions(deviceMode: DeviceMode): { padding: number | { top: number; bottom: number; left: number; right: number }; maxZoom?: number } {
  if (deviceMode === 'desktop') return { padding: 80, maxZoom: 16 }
  if (deviceMode === 'phone-portrait') return { padding: { top: 38, bottom: 54, left: 28, right: 28 }, maxZoom: 14 }
  return { padding: { top: 36, bottom: 42, left: 44, right: 44 }, maxZoom: 14 }
}

interface TacticalMapProps {
  chromeSlots?: 'inline' | 'external'
  recenterRequest?: number
}

export function TacticalMap({ chromeSlots = 'inline', recenterRequest = 0 }: TacticalMapProps = {}) {
  // Map + DOM refs
  const mapRef            = useRef<maplibregl.Map | null>(null)
  const containerRef      = useRef<HTMLDivElement>(null)
  const mapStyleLoadedRef = useRef(false)  // true once map 'load' fires; never resets to false
  const usingFallbackStyleRef = useRef(false)
  const markersRef        = useRef<Map<string, maplibregl.Marker>>(new Map())
  const innerElemsRef     = useRef<Map<string, HTMLElement>>(new Map())
  const baseMkrRef        = useRef<maplibregl.Marker | null>(null)
  const hudDivsRef        = useRef<Map<string, HTMLDivElement>>(new Map())
  const routeEditMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const groundUnitMarkersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  // Live drone data written by Effect 7, consumed by rAF loop for DOM updates
  const droneDataRef      = useRef<Map<string, { headingDeg: number; missionState: string; color: string; hasAlert: boolean; label: string; altitudeFt: number; speedMs: number; isFlying: boolean }>>(new Map())

  // rAF / interpolation refs
  const prevPosRef       = useRef<Map<string, [number, number]>>(new Map())
  const currPosRef       = useRef<Map<string, [number, number]>>(new Map())
  const tickTimestampRef = useRef<number>(Date.now())
  const rafRef           = useRef<number | null>(null)

  // Camera-follow refs
  const cameraLockedRef  = useRef(false)
  const lastFollowRef    = useRef(0)
  const lockedDroneIdRef = useRef<string | null>(null)

  // React state for FOLLOW button and locked-drone label
  const [cameraLocked,  setCameraLocked]  = useState(false)
  const [lockedDroneId, setLockedDroneId] = useState<string | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [mapMode,  setMapMode]  = useState<MapMode>('remote')
  const lastRecenterRequestRef = useRef(recenterRequest)

  // Drives the scenario-envelope fit padding/zoom-cap split (WS7) — desktop vs. the
  // mobile shell's top bar / bottom dock / safe-area chrome. Read via a ref (below) inside
  // effects so it never forces the heavy scenario-rebuild effect to re-run on its own.
  const deviceMode = useDeviceMode()

  const { drones, scenario, thermalContacts, positionHistory, ui, droneWaypoints, routeSuggestions, selectedThermalId, selectThermal, groundUnits, recoveryTeams, toggleLayer } = useDroneStore(
    useShallow((s) => ({
      drones: s.drones, scenario: s.scenario, thermalContacts: s.thermalContacts, positionHistory: s.positionHistory,
      ui: s.ui, droneWaypoints: s.droneWaypoints, routeSuggestions: s.routeSuggestions,
      selectedThermalId: s.selectedThermalId, selectThermal: s.selectThermal,
      groundUnits: s.groundUnits, recoveryTeams: s.recoveryTeams, toggleLayer: s.toggleLayer,
    })),
  )

  // Latest-data refs — written by sync effects below, read by the GeoJSON interval
  // so the interval never needs to depend on React state and never re-registers
  const latestDronesRef        = useRef(drones)
  const latestPosHistRef       = useRef(positionHistory)
  const latestDroneWaypointsRef = useRef(droneWaypoints)
  const latestScenarioRef      = useRef(scenario)
  const latestSuggestionsRef   = useRef(routeSuggestions)
  const latestSelectedDroneRef = useRef(ui.selectedDroneId)
  const latestDeviceModeRef    = useRef(deviceMode)
  // UTM state used to recompute on every render via a useMemo keyed on elapsedSec — which
  // changes every physics tick (20-200Hz), rebuilding traffic/reservation geometry far more
  // often than the map can even show it. Now computed inside the existing 10fps interval below,
  // matching the cadence already used for GeoJSON overlay updates.
  const [utmState, setUtmState] = useState(() => buildUtmAirspaceState({ scenario, drones, elapsedSec: 0 }))

  // Sync refs every render (O(1) pointer assignment — no side effects)
  useEffect(() => { latestDronesRef.current = drones },              [drones])
  useEffect(() => { latestPosHistRef.current = positionHistory },    [positionHistory])
  useEffect(() => { latestDroneWaypointsRef.current = droneWaypoints }, [droneWaypoints])
  useEffect(() => { latestScenarioRef.current = scenario },          [scenario])
  useEffect(() => { latestSuggestionsRef.current = routeSuggestions }, [routeSuggestions])
  useEffect(() => { latestSelectedDroneRef.current = ui.selectedDroneId }, [ui.selectedDroneId])
  useEffect(() => { latestDeviceModeRef.current = deviceMode },          [deviceMode])

  // ── GeoJSON interval: all setData() calls at 10fps ────────────────────────
  // Decouples map rendering from the 20fps physics tick.
  // Marker positions / SVG stay at 20fps via the rAF loop (cheap CSS transforms).
  useEffect(() => {
    const id = setInterval(() => {
      // UTM recompute at the same 10fps cadence, reading elapsedSec straight from the store
      // (not a subscribed prop) so this interval doesn't need to depend on it.
      setUtmState(buildUtmAirspaceState({
        scenario: latestScenarioRef.current,
        drones: latestDronesRef.current,
        elapsedSec: useDroneStore.getState().elapsedSec,
      }))

      const map = mapRef.current
      if (!map || !mapStyleLoadedRef.current) return
      const d  = latestDronesRef.current
      const ph = latestPosHistRef.current
      const dw = latestDroneWaypointsRef.current
      const sc = latestScenarioRef.current
      const selectedDroneId = latestSelectedDroneRef.current

      // Trails
      d.forEach((drone) => {
        const src = map.getSource(`trail-${drone.id}`) as maplibregl.GeoJSONSource | undefined
        if (!src) return
        const pts = ph[drone.id] ?? []
        if (pts.length < 2) return
        src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lng, p.lat]) }, properties: {} })
      })

      // Next-waypoint lines
      const nwSrc = map.getSource('next-wp-lines') as maplibregl.GeoJSONSource | undefined
      if (nwSrc) {
        nwSrc.setData({ type: 'FeatureCollection', features: buildNextWpFeatures(d, dw, sc?.waypoints ?? []) })
      }

      // Conflict-zone circles
      const czSrc = map.getSource('conflict-zones') as maplibregl.GeoJSONSource | undefined
      if (czSrc) {
        czSrc.setData({ type: 'FeatureCollection', features: buildConflictFeatures(d) })
      }

      // IR sensor footprints (layer only visible in IR mode)
      const irSrc = map.getSource('ir-footprints') as maplibregl.GeoJSONSource | undefined
      if (irSrc) {
        irSrc.setData({ type: 'FeatureCollection', features: buildIrFootprintFeatures(d) })
      }

      // Last-known-position ghost pins
      const lkpSrc = map.getSource('last-known-pos') as maplibregl.GeoJSONSource | undefined
      if (lkpSrc) {
        lkpSrc.setData({
          type: 'FeatureCollection',
          features: d
            .filter((drone) => drone.lastKnownPosition != null)
            .map((drone) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [drone.lastKnownPosition!.lng, drone.lastKnownPosition!.lat] },
              properties: { color: drone.color, label: drone.label },
            })),
        })
      }

      const suggestedSrc = map.getSource('suggested-route') as maplibregl.GeoJSONSource | undefined
      if (suggestedSrc) {
        const suggestion = latestSuggestionsRef.current.find((item) => item.droneId === selectedDroneId)
        suggestedSrc.setData({
          type: 'FeatureCollection',
          features: suggestion && suggestion.route.length > 1
            ? [{
                type: 'Feature' as const,
                geometry: { type: 'LineString' as const, coordinates: suggestion.route.map((wp) => [wp.position.lng, wp.position.lat]) },
                properties: { priority: suggestion.priority },
              }]
            : [],
        })
      }
    }, 100)   // 10fps map updates — smooth enough for overlays, far cheaper than 20fps
    return () => clearInterval(id)
  }, [])

  // ── Effect 1: Create map + start rAF loop ──────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    // Captured once at setup time for the cleanup below — these refs hold the same mutable
    // Map object for the component's whole lifetime (mutated via .set/.delete, never
    // reassigned), so this capture is equivalent to reading `.current` at unmount, but
    // satisfies react-hooks/exhaustive-deps' ref-in-cleanup rule.
    const hudDivsAtSetup = hudDivsRef.current
    const routeEditMarkersAtSetup = routeEditMarkersRef.current
    const groundUnitMarkersAtSetup = groundUnitMarkersRef.current

    mapStyleLoadedRef.current = false
    const initialMapMode = parseMapMode(window.location.search)
    const forceLocalMapStyle = initialMapMode === 'fallback'
    let pendingMode: MapMode = initialMapMode   // updated to 'fallback' if switchToFallbackStyle fires
    usingFallbackStyleRef.current = forceLocalMapStyle
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: forceLocalMapStyle ? LOCAL_DEMO_MAP_STYLE : MAP_STYLE,
      center: [-122.4862, 37.7695],
      zoom: 15,
      // OSM/ODbL requires visible attribution on published maps; compact keeps it
      // out of the way of the tactical HUD. OpenFreeMap credit added explicitly.
      attributionControl: { compact: true, customAttribution: '© OpenFreeMap' },
    })

    // Idempotent: adds all permanent overlay sources/layers; safe to call after style switch
    const registerPermanentLayers = () => {
      if (!map.getSource('thermal-detections')) {
        map.addSource('thermal-detections', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'thermal-circle', type: 'circle', source: 'thermal-detections',
          paint: {
            'circle-radius': 10,
            'circle-color': '#ff6600',
            'circle-opacity': ['get', 'confidence'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffaa00',
          },
        })
      }
      if (!map.getSource('ir-footprints')) {
        // Thermal sensor FOV cones — hidden until IR sensor mode is active
        map.addSource('ir-footprints', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'ir-footprint-fill', type: 'fill', source: 'ir-footprints',
          layout: { visibility: 'none' },
          paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.05 },
        })
        map.addLayer({
          id: 'ir-footprint-line', type: 'line', source: 'ir-footprints',
          layout: { visibility: 'none' },
          paint: { 'line-color': '#eaf6ff', 'line-width': 1, 'line-opacity': 0.32 },
        })
      }
      if (!map.getSource('conflict-zones')) {
        map.addSource('conflict-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'conflict-circle-outer', type: 'circle', source: 'conflict-zones',
          paint: { 'circle-radius': 36, 'circle-color': '#ff444400', 'circle-stroke-width': 2, 'circle-stroke-color': '#ff4444', 'circle-opacity': 0.6 },
        })
        map.addLayer({
          id: 'conflict-circle-inner', type: 'circle', source: 'conflict-zones',
          paint: { 'circle-radius': 18, 'circle-color': '#ff444422', 'circle-stroke-width': 1, 'circle-stroke-color': '#ff666688' },
        })
      }
      if (!map.getSource('next-wp-lines')) {
        map.addSource('next-wp-lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'next-wp-line', type: 'line', source: 'next-wp-lines',
          paint: { 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [4, 3] },
        })
      }
      if (!map.getSource('last-known-pos')) {
        map.addSource('last-known-pos', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'last-known-pos-ring', type: 'circle', source: 'last-known-pos',
          paint: {
            'circle-radius': 12, 'circle-color': 'transparent',
            'circle-stroke-width': 2, 'circle-stroke-color': ['get', 'color'],
            'circle-opacity': 0.7, 'circle-stroke-opacity': 0.7,
          },
        })
      }
      if (!map.getSource('suggested-route')) {
        map.addSource('suggested-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'suggested-route-line', type: 'line', source: 'suggested-route',
          paint: { 'line-color': '#ff44ff', 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [2, 2] },
        })
      }
      if (!map.getSource('utm-reservations')) {
        map.addSource('utm-reservations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({ id: 'utm-reservation-fill', type: 'fill', source: 'utm-reservations', paint: { 'fill-color': '#00d4ff', 'fill-opacity': 0.06 } })
        map.addLayer({ id: 'utm-reservation-line', type: 'line', source: 'utm-reservations', paint: { 'line-color': '#00d4ff', 'line-width': 1, 'line-opacity': 0.45, 'line-dasharray': [2, 3] } })
      }
      if (!map.getSource('utm-traffic')) {
        map.addSource('utm-traffic', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'utm-traffic-circle', type: 'circle', source: 'utm-traffic',
          paint: {
            'circle-radius': 7,
            // Routine/advisory traffic is not rendered. Urgent traffic remains orange and any
            // future critical track fails conspicuously red rather than falling back to cyan.
            'circle-color': ['case', ['==', ['get', 'risk'], 'urgent'], '#ffaa00', '#ff4444'],
            'circle-stroke-width': 2, 'circle-stroke-color': '#05070a', 'circle-opacity': 0.88,
          },
        })
      }
      if (!map.getSource('recovery-routes')) {
        map.addSource('recovery-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({ id: 'recovery-route-line', type: 'line', source: 'recovery-routes', paint: { 'line-color': '#ff88ff', 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [3, 3] } })
      }
      if (!map.getSource('thermal-selected')) {
        map.addSource('thermal-selected', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: 'thermal-selected-ring', type: 'circle', source: 'thermal-selected',
          paint: { 'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff', 'circle-stroke-opacity': 0.9 },
        })
        map.on('click', 'thermal-circle', (e) => {
          const id = e.features?.[0]?.properties?.id as string | undefined
          if (id) { useDroneStore.getState().selectThermal(id); e.originalEvent.stopPropagation() }
        })
        map.on('mouseenter', 'thermal-circle', () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mouseleave', 'thermal-circle', () => { map.getCanvas().style.cursor = '' })
      }
    }

    // Called exactly once regardless of whether remote or fallback style becomes ready
    const markMapReady = (mode: MapMode) => {
      if (mapStyleLoadedRef.current) return
      mapStyleLoadedRef.current = true
      try {
        registerPermanentLayers()
      } catch (err) {
        console.error('[TacticalMap] layer registration failed:', err)
      }
      setMapMode(mode)
      setMapReady(true)
      useDroneStore.getState().setMapReady(true)
    }

    const switchToFallbackStyle = () => {
      if (mapStyleLoadedRef.current || usingFallbackStyleRef.current) return
      usingFallbackStyleRef.current = true
      pendingMode = 'fallback'   // map.on('load') will fire again for the new style; read this
      map.setStyle(LOCAL_DEMO_MAP_STYLE)
    }

    const fallbackTimer = forceLocalMapStyle ? 0 : window.setTimeout(switchToFallbackStyle, MAP_FALLBACK_MS)
    map.on('error', switchToFallbackStyle)

    map.on('styleimagemissing', (event) => {
      if (map.hasImage(event.id)) return
      map.addImage(event.id, { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0]) })
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')

    map.on('dragstart', () => { cameraLockedRef.current = true; setCameraLocked(true) })

    map.on('click', () => {
      if (lockedDroneIdRef.current !== null) {
        lockedDroneIdRef.current = null
        setLockedDroneId(null)
        useDroneStore.getState().setSelectedDrone(null)
      }
    })

    // rAF loop: interpolate positions + apply heading/SVG/HUD updates from droneDataRef
    const animate = () => {
      const m = mapRef.current
      if (m && mapStyleLoadedRef.current) {
        const t = Math.min((Date.now() - tickTimestampRef.current) / 50, 1)
        markersRef.current.forEach((marker, id) => {
          const prev = prevPosRef.current.get(id)
          const curr = currPosRef.current.get(id)
          if (!prev || !curr) return
          const lngLat: [number, number] = [
            prev[0] + (curr[0] - prev[0]) * t,
            prev[1] + (curr[1] - prev[1]) * t,
          ]
          marker.setLngLat(lngLat)

          const data = droneDataRef.current.get(id)
          if (data) {
            const inner = (innerElemsRef.current.get(id) ??
              marker.getElement().querySelector('.drone-inner') as HTMLElement | null)
            if (inner) {
              if (!innerElemsRef.current.has(id)) innerElemsRef.current.set(id, inner)
              inner.style.transform = `rotate(${data.headingDeg}deg)`
              inner.style.outline   = data.hasAlert ? '2px solid #ff4444' : 'none'
              if (inner.dataset.state !== data.missionState) {
                inner.innerHTML     = DRONE_NODE_SVG(data.color, data.missionState)
                inner.dataset.state = data.missionState
              }
            }
            const hud = hudDivsRef.current.get(id)
            if (hud) {
              hud.style.display = data.isFlying ? 'block' : 'none'
              if (data.isFlying) {
                hud.textContent = `${data.label}  ${Math.round(data.altitudeFt)}ft  ${data.speedMs.toFixed(1)}m/s`
                const px = m.project(lngLat)
                hud.style.left = `${px.x + 22}px`
                hud.style.top  = `${px.y - 6}px`
              }
            }
          }
        })
      }
      rafRef.current = requestAnimationFrame(animate)
    }
    rafRef.current = requestAnimationFrame(animate)

    map.on('load', () => {
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      markMapReady(pendingMode)
    })

    mapRef.current = map

    // Container-size tracking: the mobile shell mounts the map in a flex slot
    // whose size changes on device rotation / browser-chrome collapse. MapLibre
    // only auto-resizes on window resize, so observe the container directly.
    // Debounced so a rotation animation settles into a single canvas resize.
    // Desktop grid cells never change size after layout, so this is inert there.
    let resizeTimer = 0
    const scheduleResize = () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => map.resize(), 150)
    }
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(scheduleResize)
      : null
    if (resizeObserver && containerRef.current) resizeObserver.observe(containerRef.current)
    window.visualViewport?.addEventListener('resize', scheduleResize)

    return () => {
      resizeObserver?.disconnect()
      window.visualViewport?.removeEventListener('resize', scheduleResize)
      window.clearTimeout(resizeTimer)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      hudDivsAtSetup.forEach((d) => d.remove())
      hudDivsAtSetup.clear()
      routeEditMarkersAtSetup.forEach((m) => m.remove())
      routeEditMarkersAtSetup.clear()
      groundUnitMarkersAtSetup.forEach((m) => m.remove())
      groundUnitMarkersAtSetup.clear()
      if (fallbackTimer) window.clearTimeout(fallbackTimer)
      map.remove()
      mapRef.current = null
      mapStyleLoadedRef.current = false
      usingFallbackStyleRef.current = false
      setMapReady(false)
    }
  }, [])

  // ── Effect 2: Rebuild scenario layers + flyTo when scenario changes ─────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !scenario) return

    const setup = () => {
      ;['waypoints-circle', 'route-line', 'operational-point-circle', 'operational-point-label', 'search-area-fill', 'search-area-outline', 'sar-grid-lines'].forEach(
        (id) => { if (map.getLayer(id)) map.removeLayer(id) }
      )
      ;['waypoints', 'route', 'operational-points', 'search-area', 'sar-grid'].forEach(
        (id) => { if (map.getSource(id)) map.removeSource(id) }
      )
      let gi = 0
      while (map.getLayer(`gf-fill-${gi}`)) {
        if (map.getLayer(`gf-fill-${gi}`))    map.removeLayer(`gf-fill-${gi}`)
        if (map.getLayer(`gf-outline-${gi}`)) map.removeLayer(`gf-outline-${gi}`)
        if (map.getSource(`gf-${gi}`))        map.removeSource(`gf-${gi}`)
        gi++
      }

      baseMkrRef.current?.remove(); baseMkrRef.current = null
      markersRef.current.forEach((m) => m.remove()); markersRef.current.clear()
      routeEditMarkersRef.current.forEach((m) => m.remove()); routeEditMarkersRef.current.clear()
      innerElemsRef.current.clear()
      droneDataRef.current.clear()
      prevPosRef.current.clear(); currPosRef.current.clear()
      hudDivsRef.current.forEach((d) => d.remove()); hudDivsRef.current.clear()

      for (let d = 1; d <= 8; d++) {
        const did = `uav-${String(d).padStart(2, '0')}`
        const src = map.getSource(`trail-${did}`) as maplibregl.GeoJSONSource | undefined
        if (src) src.setData({ type: 'FeatureCollection', features: [] })
      }
      ;(map.getSource('next-wp-lines') as maplibregl.GeoJSONSource | undefined)
        ?.setData({ type: 'FeatureCollection', features: [] })

      // WS7: fit the whole scenario envelope (sites/routes/waypoints) instead of a flat
      // zoom-15 flyTo — small scenarios frame tighter, wide ones no longer clip off-screen.
      map.fitBounds(computeScenarioBounds(scenario), { ...scenarioFitOptions(latestDeviceModeRef.current), duration: 600 })

      // NOTE: the static yellow waypoint dots were removed — they duplicated the
      // faint route backbone below and the numbered draggable per-drone nodes
      // (route-edit-marker). Only the dashed backbone line is kept for context.

      const routeCoords = scenario.waypoints.map((wp) => [wp.position.lng, wp.position.lat])
      if (routeCoords.length > 1) {
        map.addSource('route', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords }, properties: {} } })
        map.addLayer({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': '#ffaa0066', 'line-width': 1.5, 'line-dasharray': [4, 3] } })
      }

      const operationalPointFeatures = (scenario.operationalFeatures ?? [])
        .filter((feature) => ['recharge_station', 'relay', 'last_known', 'gate'].includes(feature.type) && feature.points.length > 0)
        .flatMap((feature) => feature.points.map((point) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] },
          properties: { label: feature.label, type: feature.type, priority: feature.priority ?? 'routine' },
        })))

      if (operationalPointFeatures.length > 0) {
        map.addSource('operational-points', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: operationalPointFeatures },
        })
        map.addLayer({
          id: 'operational-point-circle',
          type: 'circle',
          source: 'operational-points',
          paint: {
            'circle-radius': ['match', ['get', 'type'], 'recharge_station', 7, 'relay', 6, 5],
            'circle-color': ['match', ['get', 'type'], 'recharge_station', '#44ff88', 'relay', '#00d4ff', 'gate', '#ffaa00', '#ff44ff'],
            'circle-opacity': 0.82,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0d1117',
          },
        })
        if (!usingFallbackStyleRef.current) {
          map.addLayer({
            id: 'operational-point-label',
            type: 'symbol',
            source: 'operational-points',
            layout: {
              'text-field': ['get', 'label'],
              'text-size': 10,
              'text-offset': [0, 1.2],
              'text-anchor': 'top',
              'text-allow-overlap': false,
            },
            paint: {
              'text-color': '#e6edf3',
              'text-halo-color': '#0d1117',
              'text-halo-width': 1.5,
            },
          })
        }
      }

      // Zone semantics drive the styling so an operator can read authority at a glance:
      //  - active no-fly:        solid red, strong fill (hard boundary — never enter)
      //  - restricted ≤ maxAlt:  dashed amber (conditional — altitude-dependent)
      //  - bypassForMission:     dashed green, faint fill (authorized for this tasking;
      //                          visible for awareness but never triggers RTB)
      scenario.geofences.forEach((gf, i) => {
        const coords = [...gf.polygon.map((p) => [p.lng, p.lat]), [gf.polygon[0].lng, gf.polygon[0].lat]]
        const style = gf.bypassForMission
          ? { color: '#44ff88', fillOpacity: 0.12, width: 1.5, dash: [2, 4] as number[] | undefined }
          : gf.type === 'restricted'
            ? { color: '#ffaa00', fillOpacity: 0.28, width: 2, dash: [3, 2] as number[] | undefined }
            : { color: '#ff4444', fillOpacity: 0.42, width: 2.5, dash: undefined }
        map.addSource(`gf-${i}`, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} } })
        map.addLayer({ id: `gf-fill-${i}`,    type: 'fill', source: `gf-${i}`, paint: { 'fill-color': `${style.color}22`, 'fill-opacity': style.fillOpacity } })
        map.addLayer({
          id: `gf-outline-${i}`, type: 'line', source: `gf-${i}`,
          paint: {
            'line-color': style.color,
            'line-width': style.width,
            ...(style.dash ? { 'line-dasharray': style.dash } : {}),
          },
        })
      })

      if (scenario.searchArea && scenario.searchArea.length >= 3) {
        const saCoords = [...scenario.searchArea.map((p) => [p.lng, p.lat]), [scenario.searchArea[0].lng, scenario.searchArea[0].lat]]
        map.addSource('search-area', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [saCoords] }, properties: {} } })
        map.addLayer({ id: 'search-area-fill',    type: 'fill', source: 'search-area', paint: { 'fill-color': '#ffaa0011', 'fill-opacity': 0.5 } })
        map.addLayer({ id: 'search-area-outline', type: 'line', source: 'search-area', paint: { 'line-color': '#ffaa00', 'line-width': 2, 'line-dasharray': [5, 3] } })
        const gridLines = generateGridLines(scenario.searchArea, 50)
        if (gridLines.length > 0) {
          map.addSource('sar-grid', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: gridLines.map((line, idx) => ({
                type: 'Feature' as const,
                geometry: { type: 'LineString' as const, coordinates: [[line[0].lng, line[0].lat], [line[1].lng, line[1].lat]] },
                properties: { i: idx },
              })),
            },
          })
          map.addLayer({ id: 'sar-grid-lines', type: 'line', source: 'sar-grid', paint: { 'line-color': '#ffaa0044', 'line-width': 1, 'line-dasharray': [2, 4] } })
        }
      }

      const baseEl = document.createElement('div')
      baseEl.innerHTML = `<div style="width:14px;height:14px;background:#fff;border:2px solid #ffaa00;border-radius:3px;"></div>`
      baseMkrRef.current = new maplibregl.Marker({ element: baseEl })
        .setLngLat([scenario.startPosition.lng, scenario.startPosition.lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText('BASE'))
        .addTo(map)
    }

    if (mapStyleLoadedRef.current) setup()
    else map.once('load', setup)
  }, [scenario])

  // ── Effect 2b: Sensor-mode + layer-toggle visibility ───────────────────────
  // EO = daylight planning view (routes, relays, gates, traffic).
  // IR = thermal camera view (world desaturated via CSS on the canvas; heat and
  // sensor cones revealed; daylight planning clutter hidden). Numbered waypoint
  // nodes, drone tracks, and safety geofences stay visible in both modes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current) return
    const ir = ui.sensorMode === 'ir'
    const lv = ui.layerVisibility
    const setVis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
    }

    // Heat contacts + sensor FOV cones: IR only
    setVis('thermal-circle', ir && lv.thermal)
    setVis('thermal-selected-ring', ir && lv.thermal)
    setVis('ir-footprint-fill', ir && lv.irFootprints)
    setVis('ir-footprint-line', ir && lv.irFootprints)

    // External air traffic + airspace reservations: EO only, gated by toggle
    setVis('utm-traffic-circle', !ir && lv.traffic)
    setVis('utm-reservation-fill', !ir && lv.traffic)
    setVis('utm-reservation-line', !ir && lv.traffic)

    // Daylight planning overlays hidden in IR to declutter the thermal view
    ;['route-line', 'next-wp-line', 'search-area-fill', 'search-area-outline', 'sar-grid-lines']
      .forEach((id) => setVis(id, !ir))

    // Operational points: EO only; per-category filter driven by the toggles
    const opTypes = ['last_known']
    if (lv.relays) opTypes.push('relay')
    if (lv.gates) opTypes.push('gate')
    if (lv.recharge) opTypes.push('recharge_station')
    ;['operational-point-circle', 'operational-point-label'].forEach((id) => {
      if (!map.getLayer(id)) return
      map.setFilter(id, ['in', ['get', 'type'], ['literal', opTypes]])
      map.setLayoutProperty(id, 'visibility', ir ? 'none' : 'visible')
    })
  }, [ui.sensorMode, ui.layerVisibility, scenario, mapReady])

  // ── Effect 3: Zoom-to-fit all waypoints when mission starts ────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !scenario || !ui.isRunning) return
    const allPoints = [
      scenario.startPosition,
      ...scenario.waypoints.map((w) => w.position),
      ...Object.values(droneWaypoints).flat().map((w) => w.position),
    ]
    if (allPoints.length < 2) return
    const lngs = allPoints.map((p) => p.lng)
    const lats = allPoints.map((p) => p.lat)
    map.fitBounds(
      [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      { ...scenarioFitOptions(latestDeviceModeRef.current), duration: 800 }
    )
    cameraLockedRef.current = false
    setCameraLocked(false)
    // Intentionally fires only on the isRunning transition (mission start), reading
    // scenario/droneWaypoints at that instant — adding them as deps would re-fit the
    // camera on every route edit during a live mission, which is not the intended behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.isRunning])

  // Mobile map tools request an explicit overview without coupling the shell to
  // the MapLibre instance. Manual panning remains respected until this action.
  useEffect(() => {
    if (recenterRequest === lastRecenterRequestRef.current) return
    lastRecenterRequestRef.current = recenterRequest
    const map = mapRef.current
    if (!map || !scenario) return
    cameraLockedRef.current = false
    setCameraLocked(false)
    lockedDroneIdRef.current = null
    setLockedDroneId(null)
    map.fitBounds(computeScenarioBounds(scenario), {
      ...scenarioFitOptions(latestDeviceModeRef.current),
      duration: 600,
    })
  }, [recenterRequest, scenario])

  // ── Effect 4: Auto-follow — specific drone lock or centroid of fleet ────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ui.isRunning || cameraLockedRef.current) return
    const now = Date.now()
    if (now - lastFollowRef.current < 150) return
    lastFollowRef.current = now

    // Drone-specific lock: follow just that drone
    const lockId = lockedDroneIdRef.current
    if (lockId) {
      const locked = drones.find((d) => d.id === lockId)
      if (locked) {
        map.easeTo({ center: [locked.position.lng, locked.position.lat], duration: 150 })
        return
      }
      // Drone no longer exists — release lock
      lockedDroneIdRef.current = null
      setLockedDroneId(null)
    }

    // Default: centroid of all airborne drones
    const flying = drones.filter((d) => FLYING_STATES.has(d.missionState))
    if (flying.length === 0) return
    const centLng = flying.reduce((s, d) => s + d.position.lng, 0) / flying.length
    const centLat = flying.reduce((s, d) => s + d.position.lat, 0) / flying.length
    map.easeTo({ center: [centLng, centLat], duration: 200 })
  }, [drones, ui.isRunning])

  // ── Effect 5: Update thermal contact layers ────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current || !mapReady) return
    const src = map.getSource('thermal-detections') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    const bySource = new Map<string, typeof thermalContacts[0]>()
    for (const det of thermalContacts) bySource.set(det.sourceId, det)
    const deduped = Array.from(bySource.values())
    src.setData({
      type: 'FeatureCollection',
      features: deduped.map((det) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [det.position.lng, det.position.lat] },
        properties: {
          id: det.sourceId,
          confidence: det.weatherAdjustedConfidence ?? det.confidence,
          class: det.class,
          selected: det.selected,
        },
      })),
    })
    const selSrc = map.getSource('thermal-selected') as maplibregl.GeoJSONSource | undefined
    if (selSrc) {
      const sel = deduped.filter((d) => d.selected)
      selSrc.setData({
        type: 'FeatureCollection',
        features: sel.map((det) => ({
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: [det.position.lng, det.position.lat] },
          properties: { id: det.sourceId },
        })),
      })
    }
  }, [thermalContacts, mapReady])

  // ── Effect 5b: Update UTM reservation and external-traffic layers ─────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current || !mapReady) return
    const trafficSrc = map.getSource('utm-traffic') as maplibregl.GeoJSONSource | undefined
    const reservationSrc = map.getSource('utm-reservations') as maplibregl.GeoJSONSource | undefined
    if (trafficSrc) {
      trafficSrc.setData({ type: 'FeatureCollection', features: buildExternalTrafficFeatures(utmState.externalTracks) })
    }
    if (reservationSrc) {
      reservationSrc.setData({ type: 'FeatureCollection', features: buildAirspaceReservationFeatures(utmState.reservations) })
    }
  }, [utmState, mapReady])

  // ── Effect 6: Register trail source/layer for new drones ──────────────────
  // setData() is handled by the GeoJSON interval above — only source creation stays here
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current) return
    drones.forEach((drone) => {
      if (!map.getSource(`trail-${drone.id}`)) {
        const color = TRAIL_COLORS[drone.id] ?? '#ffffff'
        map.addSource(`trail-${drone.id}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({ id: `trail-${drone.id}`, type: 'line', source: `trail-${drone.id}`, paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.65 } })
      }
    })
  }, [drones, mapReady])

  // ── Effect 7: Update drone markers, position refs, next-wp lines ───────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current) return

    const activeIds    = new Set(drones.map((d) => d.id))
    const mapContainer = containerRef.current?.parentElement

    // Remove stale markers + HUD divs
    markersRef.current.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        marker.remove(); markersRef.current.delete(id)
        innerElemsRef.current.delete(id)
        droneDataRef.current.delete(id)
        prevPosRef.current.delete(id); currPosRef.current.delete(id)
        const hud = hudDivsRef.current.get(id)
        if (hud) { hud.remove(); hudDivsRef.current.delete(id) }
      }
    })

    drones.forEach((drone) => {
      const lngLat: [number, number] = [drone.position.lng, drone.position.lat]
      const hasAlert = drone.conflictFlag || drone.geofenceBreachFlag || drone.bvlosFlag
      const isFlying = FLYING_STATES.has(drone.missionState)

      // Advance interpolation window: prev ← curr, curr ← new position
      prevPosRef.current.set(drone.id, currPosRef.current.get(drone.id) ?? lngLat)
      currPosRef.current.set(drone.id, lngLat)

      if (markersRef.current.has(drone.id)) {
        const markerEl = markersRef.current.get(drone.id)?.getElement()
        if (markerEl) {
          markerEl.dataset.droneId = drone.id
          markerEl.dataset.lat = String(drone.position.lat)
          markerEl.dataset.lng = String(drone.position.lng)
          markerEl.dataset.state = drone.missionState
        }
        // UPDATE — rAF loop handles all DOM mutations via droneDataRef; just update the data
        droneDataRef.current.set(drone.id, {
          headingDeg: drone.headingDeg,
          missionState: drone.missionState,
          color: drone.color,
          hasAlert,
          label: drone.label,
          altitudeFt: drone.altitudeFt,
          speedMs: drone.speedMs,
          isFlying,
        })
      } else {
        // CREATE marker
        const el = document.createElement('div')
        el.className = 'drone-marker'
        el.dataset.droneId = drone.id
        el.dataset.lat = String(drone.position.lat)
        el.dataset.lng = String(drone.position.lng)
        el.dataset.state = drone.missionState
        el.setAttribute('aria-label', `${drone.label} map marker`)
        el.style.cursor = 'pointer'
        const inner = document.createElement('div')
        inner.className        = 'drone-inner'
        inner.style.transform  = `rotate(${drone.headingDeg}deg)`
        inner.style.outline    = hasAlert ? '2px solid #ff4444' : 'none'
        inner.dataset.state    = drone.missionState
        inner.innerHTML        = DRONE_NODE_SVG(drone.color, drone.missionState)
        el.appendChild(inner)

        // Click → lock camera to this specific drone
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          const isLocked = lockedDroneIdRef.current === drone.id
          const newId    = isLocked ? null : drone.id
          lockedDroneIdRef.current = newId
          setLockedDroneId(newId)
          useDroneStore.getState().setSelectedDrone(newId)
          // Clear manual-pan lock so camera starts following
          cameraLockedRef.current = false
          setCameraLocked(false)
          markersRef.current.get(drone.id)?.togglePopup()
        })

        const marker = new maplibregl.Marker({ element: el })
          .setLngLat(lngLat)
          .setPopup(
            new maplibregl.Popup({ offset: 20 }).setHTML(
              `<div style="font-family:monospace;font-size:11px;color:#000">
                <b>${drone.label}</b><br/>
                ALT: ${Math.round(drone.altitudeFt)}ft · BAT: ${Math.round(drone.batteryPct)}%<br/>
                STATE: ${drone.missionState.toUpperCase()}<br/>
                ${drone.conflictFlag       ? '<span style="color:red">⚠ CONFLICT</span><br/>'        : ''}
                ${drone.geofenceBreachFlag ? '<span style="color:red">⚠ GEOFENCE BREACH</span><br/>' : ''}
                ${drone.bvlosFlag          ? '<span style="color:orange">⚠ COMMS LOST</span>'        : ''}
              </div>`
            )
          )
          .addTo(map)
        markersRef.current.set(drone.id, marker)
        innerElemsRef.current.set(drone.id, inner)
        droneDataRef.current.set(drone.id, {
          headingDeg: drone.headingDeg,
          missionState: drone.missionState,
          color: drone.color,
          hasAlert,
          label: drone.label,
          altitudeFt: drone.altitudeFt,
          speedMs: drone.speedMs,
          isFlying,
        })
        prevPosRef.current.set(drone.id, lngLat)

        // On-map HUD callout (direct DOM, repositioned by rAF at 60fps)
        if (mapContainer) {
          const hud = document.createElement('div')
          hud.style.cssText = [
            'position:absolute',
            'font-family:var(--font-mono)',
            'font-size:9px',
            `color:${drone.color}`,
            'background:#00000099',
            'padding:1px 5px',
            'border-radius:2px',
            'pointer-events:none',
            'white-space:nowrap',
            'z-index:10',
            'display:none',
          ].join(';')
          hud.textContent = `${drone.label}  0ft  0.0m/s`
          mapContainer.appendChild(hud)
          hudDivsRef.current.set(drone.id, hud)
        }
      }
    })

    tickTimestampRef.current = Date.now()
    // next-wp-lines and conflict-zones setData() moved to GeoJSON interval (10fps)
  }, [drones, mapReady])

  // ── Effect 9: Ground unit markers + recovery team route lines ─────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current) return

    const activeIds = new Set(groundUnits.filter((u) => u.status !== 'standby').map((u) => u.id))
    groundUnitMarkersRef.current.forEach((marker, id) => {
      if (!activeIds.has(id)) { marker.remove(); groundUnitMarkersRef.current.delete(id) }
    })

    groundUnits.filter((u) => u.status !== 'standby').forEach((unit) => {
      const lngLat: [number, number] = [unit.position.lng, unit.position.lat]
      if (groundUnitMarkersRef.current.has(unit.id)) {
        groundUnitMarkersRef.current.get(unit.id)!.setLngLat(lngLat)
      } else {
        const el = document.createElement('div')
        const icon = unit.role === 'recovery' ? '⛑' : unit.role === 'medical' ? '✚' : unit.role === 'fire' ? '🔥' : '🚔'
        el.style.cssText = 'width:18px;height:18px;background:#ff88ff;border:2px solid #fff;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer;'
        el.title = `${unit.role.toUpperCase()} — ${unit.status}`
        el.textContent = icon
        const popup = new maplibregl.Popup({ offset: 16 }).setHTML(
          `<div style="font-family:monospace;font-size:10px;color:#000"><b>${unit.role.toUpperCase()}</b><br/>Status: ${unit.status}${unit.etaSec ? `<br/>ETA: ${Math.round(unit.etaSec)}s` : ''}${unit.weatherRiskNote ? `<br/>⚠ ${unit.weatherRiskNote}` : ''}</div>`
        )
        const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).setPopup(popup).addTo(map)
        groundUnitMarkersRef.current.set(unit.id, marker)
      }
    })

    // Recovery team route lines
    const routeSrc = map.getSource('recovery-routes') as maplibregl.GeoJSONSource | undefined
    if (routeSrc) {
      routeSrc.setData({
        type: 'FeatureCollection',
        features: recoveryTeams
          .filter((t) => t.status === 'enroute' || t.status === 'on_scene')
          .map((t) => ({
            type: 'Feature' as const,
            geometry: {
              type: 'LineString' as const,
              coordinates: [[t.position.lng, t.position.lat], [t.targetPosition.lng, t.targetPosition.lat]],
            },
            properties: { id: t.id },
          })),
      })
    }
  }, [groundUnits, recoveryTeams])

  // ── Effect 8: Draggable route-edit markers for selected drone ─────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapStyleLoadedRef.current) return

    routeEditMarkersRef.current.forEach((marker) => marker.remove())
    routeEditMarkersRef.current.clear()

    const selectedId = ui.selectedDroneId
    if (!selectedId) return
    const route = droneWaypoints[selectedId] ?? []
    route.slice(0, 24).forEach((wp, index) => {
      const el = document.createElement('div')
      el.className = 'route-edit-marker'
      el.textContent = String(index + 1)
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([wp.position.lng, wp.position.lat])
        .addTo(map)

      marker.on('dragend', () => {
        const pos = marker.getLngLat()
        useDroneStore.getState().moveDroneWaypoint(selectedId, wp.id, { lat: pos.lat, lng: pos.lng })
      })

      routeEditMarkersRef.current.set(wp.id, marker)
    })
  }, [ui.selectedDroneId, droneWaypoints, mapReady])

  return (
    <div className={`map-area${ui.sensorMode === 'ir' ? ' ir-active' : ''}`}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Fallback mode: tactical grid overlay + status badge */}
      {mapMode === 'fallback' && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1 }}>
          <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
            {[20, 40, 60, 80].map((pct) => (
              <line key={`v${pct}`} x1={`${pct}%`} y1="0" x2={`${pct}%`} y2="100%"
                    stroke="#00d4ff" strokeOpacity="0.10" strokeWidth="1" strokeDasharray="4 8" />
            ))}
            {[20, 40, 60, 80].map((pct) => (
              <line key={`h${pct}`} x1="0" y1={`${pct}%`} x2="100%" y2={`${pct}%`}
                    stroke="#00d4ff" strokeOpacity="0.10" strokeWidth="1" strokeDasharray="4 8" />
            ))}
          </svg>
          <div style={{
            position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
            fontFamily: 'var(--font-mono)', fontSize: 9, letterSpacing: '0.12em',
            color: '#ffaa00', background: '#0a1520ee',
            padding: '3px 10px', borderRadius: 3, border: '1px solid #ffaa0044',
            whiteSpace: 'nowrap', zIndex: 2,
          }}>
            LOCAL MAP FALLBACK · TACTICAL OVERLAYS ACTIVE
          </div>
        </div>
      )}

      {chromeSlots === 'inline' && <MissionStatusFeed />}
      {chromeSlots === 'inline' && <OperatorCommandPanel />}

      {/* Camera follow button — shows when manually panned or locked to specific drone */}
      {(cameraLocked || lockedDroneId) && ui.isRunning && (
        <button
          onClick={() => {
            cameraLockedRef.current  = false; setCameraLocked(false)
            lockedDroneIdRef.current = null;  setLockedDroneId(null)
            useDroneStore.getState().setSelectedDrone(null)
          }}
          style={{
            position: 'absolute', top: 80, right: 10, zIndex: 100,
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em',
            background: '#00d4ff22', border: '1px solid #00d4ff44', color: '#00d4ff',
            borderRadius: 4, padding: '4px 8px', cursor: 'pointer',
          }}
        >
          {lockedDroneId ? `◎ ${lockedDroneId.toUpperCase()}` : '◎ FOLLOW'}
        </button>
      )}

      {/* IR / thermal camera mode. The desaturated "white-hot" world is produced by a CSS
          filter on the map canvas (see .map-area.ir-active in tactical.css); heat contacts
          and sensor FOV cones are revealed by Effect 2b. This banner is a live HUD readout. */}
      {ui.sensorMode === 'ir' && (
        <div
          data-testid="ir-hud"
          style={{
            position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
            pointerEvents: 'none', zIndex: 40,
            fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: 2,
            color: '#eaf6ff', background: '#00000099',
            padding: '2px 10px', borderRadius: 4, border: '1px solid #eaf6ff44',
          }}
        >
          {(() => {
            const n = new Set(thermalContacts.map((d) => d.sourceId)).size
            return `◍ IR / THERMAL · WHITE-HOT · ${n} HEAT CONTACT${n !== 1 ? 'S' : ''}`
          })()}
        </div>
      )}

      {/* Map layers control — toggle operator overlays. Numbered waypoint nodes, drone
          tracks, and safety geofences are always on and intentionally not listed here. */}
      {scenario && (
        <div
          data-testid="layers-control"
          style={{
            position: 'absolute', bottom: 28, right: 8, zIndex: 60,
            fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: '0.04em',
            color: 'var(--text-dim)', background: 'var(--bg-panel)',
            padding: '5px 8px', borderRadius: 'var(--radius-sm)',
            display: 'flex', flexDirection: 'column', gap: 3, minWidth: 96,
          }}
        >
          <div style={{ color: 'var(--text-secondary)', letterSpacing: '0.12em', marginBottom: 1 }}>LAYERS</div>
          {([
            { key: 'relays' as const, label: 'Relays', swatch: '#00d4ff', irOnly: false },
            { key: 'gates' as const, label: 'Gates', swatch: '#ffaa00', irOnly: false },
            { key: 'recharge' as const, label: 'Recharge', swatch: '#44ff88', irOnly: false },
            { key: 'traffic' as const, label: 'Air Traffic', swatch: '#ffaa00', irOnly: false },
            { key: 'thermal' as const, label: 'Heat (IR)', swatch: '#ffffff', irOnly: true },
            { key: 'irFootprints' as const, label: 'Sensor FOV (IR)', swatch: '#eaf6ff', irOnly: true },
          ]).map(({ key, label, swatch, irOnly }) => {
            const on = ui.layerVisibility[key]
            const inactive = irOnly && ui.sensorMode !== 'ir'
            return (
              <label
                key={key}
                title={inactive ? 'Visible in IR sensor mode' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                  opacity: inactive ? 0.4 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleLayer(key)}
                  style={{ width: 10, height: 10, accentColor: swatch, margin: 0, cursor: 'pointer' }}
                />
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: swatch, flex: '0 0 auto' }} />
                <span style={{ color: on ? 'var(--text-secondary)' : 'var(--text-dim)' }}>{label}</span>
              </label>
            )
          })}
        </div>
      )}

      {/* Airspace zone legend — matches geofence layer styling */}
      {scenario && scenario.geofences.length > 0 && (
        <div
          data-testid="zone-legend"
          style={{
            position: 'absolute', bottom: 28, left: 8,
            display: 'flex', gap: 10, alignItems: 'center',
            fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.05em',
            color: 'var(--text-dim)', background: 'var(--bg-panel)',
            padding: '3px 8px', borderRadius: 'var(--radius-sm)', pointerEvents: 'none',
          }}
        >
          <span><span style={{ color: '#ff4444' }}>▬</span> NO-FLY</span>
          <span><span style={{ color: '#ffaa00' }}>┅</span> RESTRICTED ≤ALT</span>
          <span><span style={{ color: '#44ff88' }}>┅</span> AUTHORIZED BYPASS</span>
        </div>
      )}

      {/* SAR mode indicator */}
      {scenario?.missionType === 'sar_parallel' && (
        <div style={{
          position: 'absolute', top: 8, left: 8,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color: '#ffaa00', background: 'var(--bg-panel)',
          padding: '3px 8px', borderRadius: 4, border: '1px solid #ffaa0044',
        }}>
          SAR — PARALLEL TRACK
        </div>
      )}

      {/* Thermal contact count */}
      {thermalContacts.length > 0 && (
        <div style={{
          position: 'absolute', top: scenario?.missionType === 'sar_parallel' ? 36 : 8, left: 8,
          fontFamily: 'var(--font-mono)', fontSize: 10,
          color: '#ff6600', background: 'var(--bg-panel)',
          padding: '3px 8px', borderRadius: 4, border: '1px solid #ff660044',
          cursor: 'default',
        }}>
          {(() => {
            const n = new Set(thermalContacts.map((d) => d.sourceId)).size
            return `THERMAL: ${n} CONTACT${n !== 1 ? 'S' : ''}`
          })()}
        </div>
      )}

      {scenario && (
        <div className="utm-status-card" data-testid="utm-status-card">
          <strong>UTM</strong>
          <span>{utmState.externalTracks.length} TRAFFIC</span>
          <span>{utmState.reservations.length} VOLUMES</span>
          <span className={utmState.conflicts.length > 0 ? 'utm-warn' : 'utm-ok'}>{utmState.conflicts.length} CONFLICTS</span>
        </div>
      )}

      {/* Thermal contact detail panel */}
      {selectedThermalId && (() => {
        const contact = thermalContacts.find((c) => c.sourceId === selectedThermalId)
        if (!contact) return null
        const confPct = Math.round((contact.weatherAdjustedConfidence ?? contact.confidence) * 100)
        return (
          <div style={{
            position: 'absolute', top: 8, right: 56, zIndex: 120,
            background: 'var(--bg-panel)', border: '1px solid #ff660088',
            borderRadius: 6, padding: '8px 12px', minWidth: 210,
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)',
          }}>
            <div style={{ color: '#ff6600', fontWeight: 700, marginBottom: 6 }}>◉ THERMAL CONTACT</div>
            <div>Class: <b style={{ color: 'var(--text-primary)' }}>{contact.class}</b></div>
            <div>Confidence: <b style={{ color: confPct > 70 ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{confPct}%</b>
              {contact.weatherAdjustedConfidence !== contact.confidence && (
                <span style={{ color: 'var(--text-dim)', fontSize: 9 }}> (adj from {Math.round(contact.confidence * 100)}%)</span>
              )}
            </div>
            <div style={{ marginTop: 4, color: 'var(--text-dim)', fontSize: 9 }}>T+{contact.tick ?? 0} ticks</div>
            {contact.groundUnitId && (
              <div style={{ color: '#ff88ff', marginTop: 4 }}>⛑ Unit dispatched</div>
            )}
            {contact.resolvedAt !== undefined && (
              <div style={{ color: 'var(--accent-green)', marginTop: 2 }}>✓ Resolved T+{contact.resolvedAt}</div>
            )}
            <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                className="btn"
                style={{ fontSize: 9, padding: '1px 5px' }}
                onClick={() => {
                  const stagingPos = useDroneStore.getState().scenario?.startPosition
                    ?? useDroneStore.getState().drones[0]?.position
                    ?? { lat: contact.position.lat, lng: contact.position.lng }
                  useDroneStore.getState().dispatchGroundUnit(contact.sourceId, 'intervention', stagingPos)
                }}
                disabled={!!contact.groundUnitId}
              >
                ⬆ Dispatch
              </button>
              <button
                className="btn"
                style={{ fontSize: 9, padding: '1px 5px' }}
                onClick={() => useDroneStore.getState().resolveThermal(contact.sourceId, 'mark_false_positive')}
              >
                ✗ False Pos
              </button>
              <button
                className="btn"
                style={{ fontSize: 9, padding: '1px 5px' }}
                onClick={() => selectThermal(null)}
              >
                × Close
              </button>
            </div>
          </div>
        )
      })()}

      <div style={{
        position: 'absolute', bottom: 8, left: 8,
        fontFamily: 'var(--font-mono)', fontSize: 9,
        color: 'var(--text-dim)', background: 'var(--bg-panel)',
        padding: '2px 6px', borderRadius: 'var(--radius-sm)',
      }}>
        SIMULATION MODE — NOT FOR OPERATIONAL USE
      </div>

      <PerfMonitor />
    </div>
  )
}



