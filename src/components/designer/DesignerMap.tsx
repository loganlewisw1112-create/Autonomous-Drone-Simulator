import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import { makeId } from '@/account/crypto'
import { MAX_WAYPOINTS_PER_DRONE } from './designerValidation'
import type { CustomMissionDefinition, CustomMissionSite, LatLng, Waypoint } from '@/types'

const OPEN_FREE_MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

export type DesignerMapMode = 'center' | 'site' | 'waypoint'

interface DesignerMapProps {
  definition: CustomMissionDefinition
  mode: DesignerMapMode
  selectedDrone: string
  waypointAltitude: number
  onChange: (definition: CustomMissionDefinition) => void
}

function pointOf(lngLat: maplibregl.LngLat): LatLng {
  return { lat: Number(lngLat.lat.toFixed(6)), lng: Number(lngLat.lng.toFixed(6)) }
}

export function createDesignerMarkerElement(className: string, label: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.setAttribute('aria-label', label === '＋' ? 'Mission center' : `Draggable ${label}`)
  // Markers sit above the map canvas. Keep their pointer/click stream on the
  // marker so selecting or dragging one can never also place a new point.
  for (const eventName of ['pointerdown', 'pointerup', 'click', 'dblclick'] as const) {
    element.addEventListener(eventName, (event) => event.stopPropagation())
  }
  return element
}

export function DesignerMap({ definition, mode, selectedDrone, waypointAltitude, onChange }: DesignerMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const definitionRef = useRef(definition)
  const modeRef = useRef(mode)
  const selectedDroneRef = useRef(selectedDrone)
  const altitudeRef = useRef(waypointAltitude)
  const onChangeRef = useRef(onChange)

  definitionRef.current = definition
  modeRef.current = mode
  selectedDroneRef.current = selectedDrone
  altitudeRef.current = waypointAltitude
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OPEN_FREE_MAP_STYLE,
      center: [definitionRef.current.center.lng, definitionRef.current.center.lat],
      zoom: 14,
      minZoom: 2,
      maxZoom: 19,
      attributionControl: { compact: true, customAttribution: '© OpenFreeMap' },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right')
    map.on('click', (event) => {
      const current = definitionRef.current
      const position = pointOf(event.lngLat)
      if (modeRef.current === 'center') {
        onChangeRef.current({ ...current, center: position })
        return
      }
      if (modeRef.current === 'site') {
        const site: CustomMissionSite = {
          id: makeId(),
          kind: 'building_rooftop',
          label: `Site ${current.sites.length + 1}`,
          position,
          capacityDrones: 1,
        }
        onChangeRef.current({ ...current, sites: [...current.sites, site] })
        return
      }
      const droneId = selectedDroneRef.current
      const route = current.routes[droneId] ?? []
      if (route.length >= MAX_WAYPOINTS_PER_DRONE) return
      const waypoint: Waypoint = {
        id: makeId(),
        label: `Waypoint ${route.length + 1}`,
        position,
        altitudeFt: altitudeRef.current,
        dwellTimeSec: 5,
      }
      onChangeRef.current({ ...current, routes: { ...current.routes, [droneId]: [...route, waypoint] } })
    })
    mapRef.current = map
    return () => {
      markersRef.current.forEach((marker) => marker.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((marker) => marker.remove())
    const markers: maplibregl.Marker[] = []

    markers.push(new maplibregl.Marker({ element: createDesignerMarkerElement('designer-map-center', '＋') })
      .setLngLat([definition.center.lng, definition.center.lat])
      .addTo(map))

    for (const site of definition.sites) {
      const marker = new maplibregl.Marker({ element: createDesignerMarkerElement('designer-map-site', 'S'), draggable: true })
        .setLngLat([site.position.lng, site.position.lat])
        .addTo(map)
      marker.on('dragend', () => {
        const current = definitionRef.current
        const position = pointOf(marker.getLngLat())
        onChangeRef.current({ ...current, sites: current.sites.map((candidate) => candidate.id === site.id ? { ...candidate, position } : candidate) })
      })
      markers.push(marker)
    }

    for (const [droneId, route] of Object.entries(definition.routes)) {
      route.forEach((waypoint, index) => {
        const marker = new maplibregl.Marker({ element: createDesignerMarkerElement('designer-map-waypoint', String(index + 1)), draggable: true })
          .setLngLat([waypoint.position.lng, waypoint.position.lat])
          .addTo(map)
        marker.on('dragend', () => {
          const current = definitionRef.current
          const position = pointOf(marker.getLngLat())
          const currentRoute = current.routes[droneId] ?? []
          onChangeRef.current({ ...current, routes: { ...current.routes, [droneId]: currentRoute.map((candidate) => candidate.id === waypoint.id ? { ...candidate, position } : candidate) } })
        })
        markers.push(marker)
      })
    }
    markersRef.current = markers
  }, [definition.center, definition.routes, definition.sites])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const center = map.getCenter()
    if (Math.abs(center.lat - definition.center.lat) > 0.006 || Math.abs(center.lng - definition.center.lng) > 0.008) {
      map.easeTo({ center: [definition.center.lng, definition.center.lat], duration: 350 })
    }
  }, [definition.center])

  return (
    <div className="designer-map-wrap">
      <div ref={containerRef} className="designer-map" role="application" aria-label={`Interactive mission map. Pan or zoom, then click to place ${mode}.`} data-testid="designer-map" />
      <span className="designer-map-help">Pan or zoom freely · click to place {mode === 'center' ? 'mission center' : mode} · drag markers to adjust</span>
    </div>
  )
}

export default DesignerMap
