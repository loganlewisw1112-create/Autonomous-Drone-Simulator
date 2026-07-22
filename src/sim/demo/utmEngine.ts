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
  const externalTracks = buildExternalTracks(input.scenario)
  const reservations = buildReservations(input.scenario)
  const conflicts = buildConflicts(input.drones, externalTracks)

  return {
    externalTracks,
    reservations,
    conflicts,
    coordinationMode: 'Simulated UTM API coordination - strategic deconfliction, reservations, and external traffic are local demo data.',
  }
}

/**
 * Value-equality for two UTM states.
 *
 * `buildUtmAirspaceState` is recomputed on a 10 Hz interval, but `externalTracks` and
 * `reservations` are pure functions of the scenario and `conflicts` only changes when a drone
 * moves near a track — so the overwhelmingly common result is a value-identical object with a
 * fresh identity. Feeding that straight into `setState` re-rendered the whole map component ten
 * times a second forever, including while idle with no scenario loaded. Callers compare first and
 * keep the previous reference so React can bail out of the render.
 */
export function utmAirspaceStateEquals(a: UTMAirspaceState, b: UTMAirspaceState): boolean {
  if (a === b) return true
  if (a.coordinationMode !== b.coordinationMode) return false

  if (a.externalTracks.length !== b.externalTracks.length) return false
  for (let i = 0; i < a.externalTracks.length; i++) {
    const x = a.externalTracks[i]
    const y = b.externalTracks[i]
    // Position is included because tracks are placed relative to scenario.startPosition, so two
    // scenarios can otherwise yield same-id tracks that are nowhere near each other.
    if (x.id !== y.id || x.altitudeFt !== y.altitudeFt || x.headingDeg !== y.headingDeg
      || x.position.lat !== y.position.lat || x.position.lng !== y.position.lng) return false
  }

  if (a.reservations.length !== b.reservations.length) return false
  for (let i = 0; i < a.reservations.length; i++) {
    const x = a.reservations[i]
    const y = b.reservations[i]
    if (x.id !== y.id || x.status !== y.status
      || x.altitudeFloorFt !== y.altitudeFloorFt || x.altitudeCeilingFt !== y.altitudeCeilingFt
      || x.polygon.length !== y.polygon.length) return false
  }

  if (a.conflicts.length !== b.conflicts.length) return false
  for (let i = 0; i < a.conflicts.length; i++) {
    const x = a.conflicts[i]
    const y = b.conflicts[i]
    if (x.id !== y.id || x.severity !== y.severity
      || x.horizontalSeparationM !== y.horizontalSeparationM
      || x.verticalSeparationFt !== y.verticalSeparationFt) return false
  }

  return true
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

function buildExternalTracks(scenario: ScenarioConfig | null): ExternalTrafficTrack[] {
  const origin = scenario?.startPosition ?? { lat: 37.7695, lng: -122.4862 }
  const labelPrefix = scenario ? labelPrefixForScenario(scenario) : 'UTM'

  return [
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
