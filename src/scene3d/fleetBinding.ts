/**
 * Fleet model → scene poses. Pulled once per rendered frame (no subscription state to go stale).
 *
 * Height reference is the ground MapLibre actually DRAWS (terrainModel.ts), not the raw sim DEM: the
 * map renders relief for only part of the DEM and none below zoom 15, and an aircraft must sit its
 * true AGL above whatever ground is on screen, or it visibly floats or sinks.
 */
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState, MissionState } from '@/types'
import type { AirframeId } from './airframes/parts'
import type { FleetFrame, SceneDrone } from './fleet'
import { sceneInstant } from './sceneClock'
import { sunPosition, type SunPosition } from './sun'
import type { BuildingFootprint } from './shadowReceivers'
import type { TerrainModel } from './terrainModel'
import type * as maplibregl from 'maplibre-gl'
import { buildGnssUncertaintyFeatures, buildIrFootprintFeatures } from '@/components/tacticalMapGeoJson'
import { buildingFixtureFor } from '@/scenarios/buildingFixtures'
import type { VolumeFrame } from './volumes'
import type { AtmosphereFrame } from './atmosphere'
import { createScene3D, type Scene3DHandle } from './index'
import { createTerrainModel } from './terrainModel'

const FT_TO_M = 0.3048
const HOVER_RPM = 5200

const AIRFRAME_BY_PLATFORM: Record<string, AirframeId> = { teal_2: 'teal2', skydio_x10: 'x10' }

/** Gimbal pitch by mission state (degrees; negative looks down). The fleet model carries no
 *  gimbal telemetry, so pose follows what the aircraft is doing. */
const GIMBAL_PITCH: Partial<Record<MissionState, number>> = {
  thermal_hold: -75, sar_grid: -60, inspect: -40, hover: -30, return_to_base: -10,
  idle: 0, preflight: 0, landed: 0, remote_landed: 0, recharge: 0,
}
const DEFAULT_GIMBAL_PITCH = -25
const LANDING_BELOW_M = 8

/** The fleet model has no LANDING state; it is the last metres of a return or an emergency descent. */
function isLanding(drone: DroneState, aglM: number): boolean {
  return aglM < LANDING_BELOW_M && (drone.missionState === 'return_to_base' || drone.missionState === 'emergency')
}

export function poseOf(drone: DroneState, groundM: number): SceneDrone {
  const aglM = drone.altitudeFt * FT_TO_M
  const airborne = aglM > 0.5
  const landing = airborne && isLanding(drone, aglM)
  return {
    id: drone.id,
    airframe: AIRFRAME_BY_PLATFORM[drone.platformId ?? ''] ?? 'teal2',
    lng: drone.position.lng,
    lat: drone.position.lat,
    elevationM: groundM + aglM,
    headingDeg: drone.headingDeg,
    speedMs: airborne ? drone.speedMs : 0,
    propRpm: !airborne ? 0 : landing ? HOVER_RPM * 0.75 : HOVER_RPM + drone.speedMs * 60,
    gimbalYawDeg: 0,
    gimbalPitchDeg: landing ? 0 : GIMBAL_PITCH[drone.missionState] ?? DEFAULT_GIMBAL_PITCH, // stowed for touchdown
    color: drone.color,
  }
}

export function storeFleetSource(terrain: TerrainModel): () => FleetFrame {
  return () => {
    const { drones, elapsedSec } = useDroneStore.getState()
    return {
      simTimeSec: elapsedSec,
      drones: drones.map((d) => poseOf(d, terrain.groundAt(d.position.lng, d.position.lat))),
    }
  }
}

/** Sun from the SCENARIO clock: the scenario's date (observed-weather fixture, where it has one), its
 *  time-of-day variant, and sim elapsed seconds — at the scenario's own coordinates. */
export function storeSunSource(): () => SunPosition {
  return () => {
    const { scenario, scenarioVariant, elapsedSec } = useDroneStore.getState()
    if (!scenario) return { azimuthDeg: 135, elevationDeg: 42 }
    const { lat, lng } = scenario.startPosition
    const instant = sceneInstant({
      date: observedWeatherFor(scenario.id)?.provenance?.observedDate,
      timeOfDay: scenarioVariant.timeOfDay,
      latDeg: lat, lngDeg: lng, elapsedSec,
    })
    return sunPosition(instant, lat, lng)
  }
}

/** The scenario's Overture footprints as plain rings (outer ring only; holes cast no useful shadow). */
export function storeBuildingSource(scenarioId: string): () => BuildingFootprint[] {
  let cached: BuildingFootprint[] | null = null
  return () => {
    if (cached) return cached
    const collection = buildingFixtureFor(scenarioId)
    if (!collection) return [] // not prepared yet — ask again next rebuild
    const out: BuildingFootprint[] = []
    for (const feature of collection.features) {
      const heightM = Number((feature.properties as { h?: number } | null)?.h ?? 0)
      if (!(heightM > 0)) continue
      const g = feature.geometry as { type: string; coordinates: unknown }
      const polygons = g.type === 'Polygon' ? [g.coordinates as number[][][]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]) : []
      for (const polygon of polygons) out.push({ ring: polygon[0].map(([lng, lat]) => [lng, lat] as [number, number]), heightM })
    }
    cached = out
    return out
  }
}

const TRAIL_SAMPLE_SEC = 0.5
const TRAIL_MAX_POINTS = 240

/**
 * Sensor volumes from the SAME builders the 2D layers use (tacticalMapGeoJson), so a 3D twin can never
 * disagree with the layer it replaces about who has a footprint, how big an error ring is, or its colour.
 * The fleet model keeps lng/lat history only, so altitude-correct trails are recorded here, per sim
 * sample; on first sight a trail is seeded from that flat history at the aircraft's current height.
 */
export function storeVolumeSource(terrain: TerrainModel): () => VolumeFrame {
  const trails = new Map<string, Array<[number, number, number]>>()
  let sampledAt = -Infinity
  return () => {
    const { drones, elapsedSec, positionHistory, ui } = useDroneStore.getState()
    const heightOf = (d: DroneState) => terrain.groundAt(d.position.lng, d.position.lat) + d.altitudeFt * FT_TO_M
    const byId = new Map(drones.map((d) => [d.id, d]))

    if (elapsedSec < sampledAt) { trails.clear(); sampledAt = -Infinity } // scenario restarted
    if (elapsedSec - sampledAt >= TRAIL_SAMPLE_SEC) {
      sampledAt = elapsedSec
      for (const d of drones) {
        let trail = trails.get(d.id)
        if (!trail) {
          const agl = d.altitudeFt * FT_TO_M
          trail = (positionHistory[d.id] ?? []).map((p) => [p.lng, p.lat, terrain.groundAt(p.lng, p.lat) + agl] as [number, number, number])
          trails.set(d.id, trail)
        }
        if (d.altitudeFt > 1) trail.push([d.position.lng, d.position.lat, heightOf(d)])
        if (trail.length > TRAIL_MAX_POINTS) trail.splice(0, trail.length - TRAIL_MAX_POINTS)
      }
    }

    return {
      simTimeSec: elapsedSec,
      footprints: buildIrFootprintFeatures(drones).flatMap((f) => {
        const d = byId.get(f.properties.id)
        const ring = f.geometry.coordinates[0]
        return d ? [{ id: d.id, apex: ring[0] as [number, number], apexElevationM: heightOf(d), arc: ring.slice(1, -1) as Array<[number, number]> }] : []
      }),
      uncertainties: buildGnssUncertaintyFeatures(drones).flatMap((f) => {
        const d = byId.get(f.properties.id)
        if (!d) return []
        const at = d.reportedPosition ?? d.position
        return [{ id: d.id, lng: at.lng, lat: at.lat, elevationM: heightOf(d), radiusM: f.properties.radiusM, color: f.properties.color }]
      }),
      trails: drones.map((d) => ({ id: d.id, color: d.color, points: trails.get(d.id) ?? [] })),
      // The app shows footprints only in IR sensor mode with the toggle on; trails and GNSS rings always.
      show: { footprints: ui.sensorMode === 'ir' && ui.layerVisibility.irFootprints, uncertainty: true, trails: true },
    }
  }
}

/**
 * While the scene draws a concept, its flat layer is hidden — two pictures of one thing is what makes a
 * 3D overlay look amateur. `claim()` runs every frame because the app's own effects set these layers
 * visible again whenever sensor mode or a toggle changes. `release()` puts back what the app wants.
 */
export function createLayerOwnership(map: maplibregl.Map): { claim(): void; release(): void; owned(): string[] } {
  const owned = () => {
    const { drones } = useDroneStore.getState()
    return ['ir-footprint-fill', 'ir-footprint-line', 'gnss-uncertainty-fill', 'gnss-uncertainty-ring', ...drones.map((d) => `trail-${d.id}`)]
      .filter((id) => map.getLayer(id))
  }
  return {
    owned,
    claim() {
      for (const id of owned()) if (map.getLayoutProperty(id, 'visibility') !== 'none') map.setLayoutProperty(id, 'visibility', 'none')
    },
    release() {
      const { ui } = useDroneStore.getState()
      const footprints = ui.sensorMode === 'ir' && ui.layerVisibility.irFootprints
      for (const id of owned()) map.setLayoutProperty(id, 'visibility', id.startsWith('ir-footprint') && !footprints ? 'none' : 'visible')
    },
  }
}

const MI_TO_KM = 1.609344

/** Fog and smoke inputs. Visibility is the sim's own seeded weather state (ERA5 fixtures carry none);
 *  fires are the scenario's heat sources, hot ones only — the atmosphere filters by temperature. */
export function storeAtmosphereSource(): () => AtmosphereFrame | null {
  return () => {
    const { scenario, weatherState, elapsedSec } = useDroneStore.getState()
    if (!scenario) return null
    return {
      visibilityKm: weatherState.visibilityMi * MI_TO_KM,
      windKts: weatherState.windKts,
      simTimeSec: elapsedSec,
      seed: scenario.seed,
      fires: (scenario.heatSources ?? []).map((h) => ({ lng: h.position.lng, lat: h.position.lat, radiusM: h.radiusM, tempC: h.tempC })),
    }
  }
}

export interface BoundScene {
  handle: Scene3DHandle
  terrain: TerrainModel
  ownership: ReturnType<typeof createLayerOwnership>
  buildings: () => BuildingFootprint[]
}

/** A scene wired to the live app for one scenario: ENU anchor, ground model, fleet, sun, volumes,
 *  atmosphere, building footprints and the 2D/3D hand-off. */
export function createBoundScene(map: maplibregl.Map, scenario: { id: string; terrainFixtureId?: string; startPosition: { lat: number; lng: number } }): BoundScene {
  const terrain = createTerrainModel(map, scenario)
  const ownership = createLayerOwnership(map)
  const buildings = storeBuildingSource(scenario.id)
  const handle = createScene3D(map, { lng: scenario.startPosition.lng, lat: scenario.startPosition.lat }, {
    terrain, ownership, buildings,
    fleetSource: storeFleetSource(terrain),
    sunSource: storeSunSource(),
    volumeSource: storeVolumeSource(terrain),
    atmosphereSource: storeAtmosphereSource(),
  })
  // MapLibre paints on demand. The scene's content moves with the SIM clock, so each tick has to ask for
  // a frame — otherwise, with the camera at rest, aircraft would only move when something else repainted.
  let lastTick = -1
  const unsubscribe = useDroneStore.subscribe((state) => {
    if (state.tick === lastTick) return
    lastTick = state.tick
    if (handle.isEnabled()) map.triggerRepaint()
  })
  const dispose = handle.dispose.bind(handle)
  handle.dispose = () => { unsubscribe(); dispose() }
  return { handle, terrain, ownership, buildings }
}
