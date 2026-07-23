import { mulberry32 } from '@/utils/rng'
import { haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import type { DronePlatformSpec } from '@/sim/drone/platformCatalog'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import {
  effectiveDetectionRangeM,
  thermalContrastThresholdC,
  thermalTransmission,
} from '@/sim/sensors/thermalRange'
import type {
  DroneState,
  HeatSource,
  ThermalDetection,
  WeatherVariantState,
} from '@/types'

// Legacy constants remain only for the four-argument compatibility path. Once
// SimulationLoop supplies ThermalDetectionEnvironment, the sourced WP-5 model
// below replaces this gameplay range completely.
const LEGACY_SENSOR_RANGE_M = 60
const LEGACY_ALT_RANGE_FACTOR = 0.4
const BASE_CONFIDENCE = 0.85
const NOISE_AMPLITUDE = 0.15
const MAX_LOCALIZATION_ERROR_M = 9
const FT_TO_M = 0.3048

export interface ThermalDetectionEnvironment {
  platform: DronePlatformSpec | null
  weather: Pick<WeatherVariantState, 'activeHazards' | 'visibilityMi' | 'tempF'>
  occlusion?: OcclusionService
}

export interface ThermalTargetGeometry {
  criticalDimensionM: number
  heightAglM: number
}

const SURFACE_TARGET_HEIGHT_M = 0.5

/**
 * Resolve authored target geometry for the Johnson model. Heat-source radii
 * already describe circular thermal footprints in every shipped scenario, so
 * their diameter is the conservative critical dimension when no override is
 * authored. Campfires use the same footprint and aim halfway up the modelled
 * flame column; generic surface sources stay just above local ground for LOS.
 */
export function thermalTargetGeometry(source: HeatSource): ThermalTargetGeometry | null {
  if (source.class === 'generic-person') {
    return {
      criticalDimensionM: source.criticalDimensionM ?? 0.5,
      heightAglM: source.heightAglM ?? 1.7,
    }
  }
  if (source.class === 'vehicle') {
    return {
      criticalDimensionM: source.criticalDimensionM ?? 2,
      heightAglM: source.heightAglM ?? 1.5,
    }
  }
  const criticalDimensionM = source.criticalDimensionM ?? source.radiusM * 2
  if (criticalDimensionM <= 0) return null
  const defaultHeightAglM = source.class === 'campfire'
    ? Math.max(SURFACE_TARGET_HEIGHT_M, source.radiusM)
    : SURFACE_TARGET_HEIGHT_M
  return {
    criticalDimensionM,
    heightAglM: source.heightAglM ?? defaultHeightAglM,
  }
}

/** Stable FNV-1a over the complete seed/tick/drone/source identity. */
function hashIdentity(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function sourceRng(seed: number, tick: number, droneId: string, sourceId: string) {
  return mulberry32(hashIdentity(`${seed}|${tick}|${droneId}|${sourceId}`))
}

function legacyEffectiveRangeM(altitudeFt: number): number {
  const altFactor = Math.max(0, 1 - (altitudeFt / 100) * LEGACY_ALT_RANGE_FACTOR)
  return LEGACY_SENSOR_RANGE_M * altFactor
}

function celsiusFromFahrenheit(tempF: number): number {
  return (tempF - 32) * 5 / 9
}

function endpointAltitudesMsl(
  drone: DroneState,
  source: HeatSource,
  heightAglM: number,
  occlusion?: OcclusionService,
): { droneMslM: number; sourceMslM: number } {
  const droneGroundM = occlusion?.groundElevation(drone.position.lat, drone.position.lng) ?? 0
  const sourceGroundM = occlusion?.groundElevation(source.position.lat, source.position.lng) ?? 0
  return {
    droneMslM: droneGroundM + drone.altitudeFt * FT_TO_M,
    sourceMslM: sourceGroundM + heightAglM,
  }
}

/** True three-dimensional sensor-to-target range. */
export function thermalSlantRangeM(
  drone: DroneState,
  source: HeatSource,
  heightAglM: number,
  occlusion?: OcclusionService,
): number {
  const horizontalM = haversineDistanceM(drone.position, source.position)
  const { droneMslM, sourceMslM } = endpointAltitudesMsl(drone, source, heightAglM, occlusion)
  return Math.hypot(horizontalM, droneMslM - sourceMslM)
}

function estimateDetection(
  drone: DroneState,
  source: HeatSource,
  tick: number,
  seed: number,
  distanceM: number,
  rangeM: number,
  strict: boolean,
): ThermalDetection | null {
  const rng = sourceRng(seed, tick, drone.id, source.id)
  const proximityFactor = 1 - Math.min(1, distanceM / rangeM)
  const noise = (rng() - 0.5) * NOISE_AMPLITUDE
  // Strict physics already passed binary range/contrast/LOS gates. Keep a
  // bounded confidence estimate at the range edge rather than randomly erasing
  // a physically valid boundary detection. Legacy retains its prior curve.
  const signal = strict
    ? BASE_CONFIDENCE * (0.5 + 0.5 * proximityFactor)
    : BASE_CONFIDENCE * proximityFactor
  const confidence = Math.min(1, Math.max(0, signal + noise))
  if (confidence < 0.3) return null

  const errorM = (1 - confidence) * MAX_LOCALIZATION_ERROR_M * rng()
  const errorBearing = rng() * 360
  const estimatedPosition = errorM > 0.01
    ? offsetLatLng(source.position, errorBearing, errorM)
    : source.position

  return {
    sourceId: source.id,
    class: source.class,
    position: estimatedPosition,
    confidence,
    tick,
  }
}

function checkLegacyDetections(
  drone: DroneState,
  heatSources: HeatSource[],
  tick: number,
  seed: number,
): ThermalDetection[] {
  const rangeM = legacyEffectiveRangeM(drone.altitudeFt)
  const detections: ThermalDetection[] = []
  for (const source of [...heatSources].sort((a, b) => a.id.localeCompare(b.id))) {
    const distanceM = haversineDistanceM(drone.position, source.position)
    const effectiveRange = rangeM + source.radiusM
    if (distanceM > effectiveRange) continue
    const detection = estimateDetection(drone, source, tick, seed, distanceM, effectiveRange, false)
    if (detection) detections.push(detection)
  }
  return detections
}

function checkStrictDetections(
  drone: DroneState,
  heatSources: HeatSource[],
  tick: number,
  seed: number,
  environment: ThermalDetectionEnvironment,
): ThermalDetection[] {
  const sensor = environment.platform?.thermal ?? null
  const contrastThresholdC = thermalContrastThresholdC(sensor)
  if (contrastThresholdC == null) return []

  const transmission = thermalTransmission(environment.weather)
  const weatherBackgroundC = celsiusFromFahrenheit(environment.weather.tempF)
  const detections: ThermalDetection[] = []

  for (const source of [...heatSources].sort((a, b) => a.id.localeCompare(b.id))) {
    const geometry = thermalTargetGeometry(source)
    if (!geometry) continue
    const rangeM = effectiveDetectionRangeM(sensor, geometry.criticalDimensionM, transmission)
    if (rangeM == null) continue

    const backgroundC = source.backgroundTempC ?? weatherBackgroundC
    if (Math.abs(source.tempC - backgroundC) < contrastThresholdC) continue

    const distanceM = thermalSlantRangeM(
      drone,
      source,
      geometry.heightAglM,
      environment.occlusion,
    )
    if (distanceM > rangeM) continue

    if (environment.occlusion) {
      const { droneMslM, sourceMslM } = endpointAltitudesMsl(
        drone,
        source,
        geometry.heightAglM,
        environment.occlusion,
      )
      const los = environment.occlusion.hasLineOfSight(
        { ...drone.position, altMslM: droneMslM },
        { ...source.position, altMslM: sourceMslM },
      )
      if (!los.clear) continue
    }

    const detection = estimateDetection(drone, source, tick, seed, distanceM, rangeM, true)
    if (detection) detections.push(detection)
  }
  return detections
}

/**
 * Check thermal detections. Four arguments preserve the historical gameplay
 * model until the simulation loop supplies a fifth environment argument. The
 * strict path fails closed on unknown optics/NETD and applies Johnson range,
 * thermal contrast, 3D slant distance, atmosphere and terrain/building LOS.
 */
export function checkThermalDetections(
  drone: DroneState,
  heatSources: HeatSource[],
  tick: number,
  seed: number,
  environment?: ThermalDetectionEnvironment,
): ThermalDetection[] {
  if (drone.missionState === 'idle' || drone.missionState === 'landed' || drone.altitudeFt < 5) {
    return []
  }
  return environment
    ? checkStrictDetections(drone, heatSources, tick, seed, environment)
    : checkLegacyDetections(drone, heatSources, tick, seed)
}
