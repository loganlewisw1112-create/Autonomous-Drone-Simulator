import { haversineDistanceM } from '@/utils/geometry'
import type {
  AirspaceReservation,
  DroneState,
  ExternalTrafficTrack,
  LatLng,
  ScenarioConfig,
  UTMAirspaceState,
  UTMConflict,
} from '@/types'

type PointFeature = {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: Record<string, unknown>
}

type PolygonFeature = {
  type: 'Feature'
  geometry: { type: 'Polygon'; coordinates: Array<Array<[number, number]>> }
  properties: Record<string, unknown>
}

interface BuildUtmAirspaceStateInput {
  scenario: ScenarioConfig | null
  drones: DroneState[]
  elapsedSec: number
}

export function buildUtmAirspaceState(input: BuildUtmAirspaceStateInput): UTMAirspaceState {
  const externalTracks = buildExternalTracks(input.scenario, input.elapsedSec)
  const reservations = buildReservations(input.scenario)
  const conflicts = buildConflicts(input.drones, externalTracks)

  return {
    externalTracks,
    reservations,
    conflicts,
    coordinationMode: 'Simulated UTM API coordination - strategic deconfliction, reservations, and external traffic are local demo data.',
  }
}

export function buildExternalTrafficFeatures(tracks: ExternalTrafficTrack[]): PointFeature[] {
  return tracks.map((track) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [track.position.lng, track.position.lat] },
    properties: {
      id: track.id,
      label: track.label,
      altitudeFt: track.altitudeFt,
      headingDeg: track.headingDeg,
      risk: track.risk,
    },
  }))
}

export function buildAirspaceReservationFeatures(reservations: AirspaceReservation[]): PolygonFeature[] {
  return reservations.map((reservation) => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[...reservation.polygon, reservation.polygon[0]].map((point) => [point.lng, point.lat])],
    },
    properties: {
      id: reservation.id,
      label: reservation.label,
      floorFt: reservation.altitudeFloorFt,
      ceilingFt: reservation.altitudeCeilingFt,
      status: reservation.status,
    },
  }))
}

function buildExternalTracks(scenario: ScenarioConfig | null, elapsedSec: number): ExternalTrafficTrack[] {
  const origin = scenario?.startPosition ?? { lat: 37.7695, lng: -122.4862 }
  const phase = (elapsedSec % 180) / 180
  const labelPrefix = scenario ? labelPrefixForScenario(scenario) : 'UTM'

  return [
    {
      id: 'utm-medical-helo',
      label: `${labelPrefix} medical helicopter corridor`,
      position: offset(origin, -0.004 + phase * 0.002, 0.003 - phase * 0.001),
      altitudeFt: 650,
      headingDeg: 96,
      speedKts: 82,
      risk: 'advisory',
    },
    {
      id: 'utm-news-rotor',
      label: `${labelPrefix} media rotor hold`,
      position: offset(origin, 0.0015, 0.0015),
      altitudeFt: 260,
      headingDeg: 270,
      speedKts: 28,
      risk: 'urgent',
    },
  ]
}

function buildReservations(scenario: ScenarioConfig | null): AirspaceReservation[] {
  const origin = scenario?.startPosition ?? { lat: 37.7695, lng: -122.4862 }
  const missionPolygon = scenario?.searchArea && scenario.searchArea.length >= 3
    ? scenario.searchArea
    : squareAround(origin, 0.004)

  const reservations: AirspaceReservation[] = [{
    id: `${scenario?.id ?? 'demo'}-uas-volume`,
    label: 'UAS mission volume',
    polygon: missionPolygon,
    altitudeFloorFt: 0,
    altitudeCeilingFt: 400,
    status: 'active',
  }]

  const firstGeofence = scenario?.geofences[0]
  if (firstGeofence) {
    reservations.push({
      id: `${firstGeofence.id}-standoff`,
      label: `${firstGeofence.label} standoff`,
      polygon: firstGeofence.polygon,
      altitudeFloorFt: 0,
      altitudeCeilingFt: firstGeofence.maxAltitudeFt,
      status: 'planned',
    })
  }

  return reservations
}

function buildConflicts(drones: DroneState[], tracks: ExternalTrafficTrack[]): UTMConflict[] {
  const conflicts: UTMConflict[] = []

  for (const drone of drones) {
    for (const track of tracks) {
      const horizontalSeparationM = haversineDistanceM(drone.position, track.position)
      const verticalSeparationFt = Math.abs(drone.altitudeFt - track.altitudeFt)
      if (horizontalSeparationM > 650 || verticalSeparationFt > 250) continue
      conflicts.push({
        id: `${drone.id}-${track.id}`,
        droneId: drone.id,
        trafficId: track.id,
        horizontalSeparationM: Math.round(horizontalSeparationM),
        verticalSeparationFt: Math.round(verticalSeparationFt),
        severity: horizontalSeparationM < 250 && verticalSeparationFt < 150 ? 'critical' : 'urgent',
      })
    }
  }

  return conflicts
}

function offset(origin: LatLng, latDelta: number, lngDelta: number): LatLng {
  return { lat: origin.lat + latDelta, lng: origin.lng + lngDelta }
}

function squareAround(origin: LatLng, radiusDeg: number): LatLng[] {
  return [
    offset(origin, -radiusDeg, -radiusDeg),
    offset(origin, -radiusDeg, radiusDeg),
    offset(origin, radiusDeg, radiusDeg),
    offset(origin, radiusDeg, -radiusDeg),
  ]
}

function labelPrefixForScenario(scenario: ScenarioConfig): string {
  const agency = scenario.missionBrief?.agencies[0] ?? scenario.name.split('-')[0]?.trim() ?? 'UTM'
  return agency.toUpperCase()
}
