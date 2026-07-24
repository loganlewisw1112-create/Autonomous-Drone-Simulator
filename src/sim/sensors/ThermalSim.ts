import { mulberry32 } from '@/utils/rng'
import { haversineDistanceM } from '@/utils/geometry'
import type { DronePlatformSpec, ThermalSensorSpec } from '@/sim/drone/platformCatalog'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import {
  effectiveDetectionRangeM,
  thermalContrastThresholdC,
  thermalTransmission,
  type ThermalWeather,
} from '@/sim/sensors/thermalRange'
import type {
  DroneState,
  HeatSource,
  ThermalDetection,
  WeatherVariantState,
} from '@/types'

// Phase 7: live detection always uses Johnson + NETD + LOS via ThermalDetectionEnvironment.
// The old 60 m gameplay range is retired from the production path (SimulationLoop always
// supplies environment). Four-argument calls fail closed (no detections) so accidental
// short-range gameplay cannot re-enter.

const BASE_CONFIDENCE = 0.85
const NOISE_AMPLITUDE = 0.15
const FT_TO_M = 0.3048
/** Reference critical dimension for person-class R_d HUD readout (m). */
export const THERMAL_HUD_PERSON_SIZE_M = 0.5

export interface ThermalDetectionEnvironment {
  platform: DronePlatformSpec | null
  weather: Pick<WeatherVariantState, 'activeHazards' | 'visibilityMi' | 'tempF'>
  occlusion?: OcclusionService
}

export interface ThermalTargetGeometry {
  criticalDimensionM: number
  heightAglM: number
}

/** Operator-facing payload status for TELEM / IR HUD (SIMULATION ONLY). */
export interface ThermalPayloadStatus {
  sensorName: string
  /** Johnson detection range after atmosphere for a 0.5 m person, or null if unsourced. */
  detectionRangeM: number | null
  netdMk: number | null
  radiometric: boolean
  radiometricAccuracyC: number | null
  /** Short HUD line, e.g. "Hadron 640R · R_d 283 m · ±5 °C" */
  summary: string
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

/**
 * Build operator HUD status from a platform thermal payload + weather transmission.
 * Unsourced optics/NETD report sensor name (or "NO INTEGRATED THERMAL") with null R_d.
 */
export function thermalPayloadStatus(
  platform: DronePlatformSpec | null | undefined,
  weather?: ThermalWeather | null,
): ThermalPayloadStatus {
  const sensor: ThermalSensorSpec | null = platform?.thermal ?? null
  if (!sensor) {
    return {
      sensorName: 'NO INTEGRATED THERMAL',
      detectionRangeM: null,
      netdMk: null,
      radiometric: false,
      radiometricAccuracyC: null,
      summary: 'NO INTEGRATED THERMAL · R_d —',
    }
  }
  const transmission = thermalTransmission(weather)
  const detectionRangeM = effectiveDetectionRangeM(sensor, THERMAL_HUD_PERSON_SIZE_M, transmission)
  const rdLabel = detectionRangeM != null ? `R_d ${Math.round(detectionRangeM)} m` : 'R_d —'
  const radioLabel = sensor.radiometric && sensor.radiometricAccuracyC != null
    ? ` · ±${sensor.radiometricAccuracyC} °C`
    : ''
  return {
    sensorName: sensor.sensor,
    detectionRangeM,
    netdMk: sensor.netdMk,
    radiometric: sensor.radiometric,
    radiometricAccuracyC: sensor.radiometricAccuracyC,
    summary: `${sensor.sensor} · ${rdLabel}${radioLabel}`,
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
): ThermalDetection | null {
  const rng = sourceRng(seed, tick, drone.id, source.id)
  const proximityFactor = 1 - Math.min(1, distanceM / rangeM)
  const noise = (rng() - 0.5) * NOISE_AMPLITUDE
  // Strict physics already passed binary range/contrast/LOS gates. Keep a
  // bounded confidence estimate at the range edge rather than randomly erasing
  // a physically valid boundary detection.
  const signal = BASE_CONFIDENCE * (0.5 + 0.5 * proximityFactor)
  const confidence = Math.min(1, Math.max(0, signal + noise))
  if (confidence < 0.3) return null

  // Training mode: reported contact coordinates equal heat-source truth.
  // Confidence noise remains; GNSS reportedPosition on the airframe is separate.
  return {
    sourceId: source.id,
    class: source.class,
    position: { ...source.position },
    confidence,
    tick,
  }
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

    const detection = estimateDetection(drone, source, tick, seed, distanceM, rangeM)
    if (detection) detections.push(detection)
  }
  return detections
}

/**
 * Check thermal detections (SAR / inspection only — SIMULATION).
 *
 * Requires `environment` (platform optics + weather + optional terrain LOS). Without it,
 * returns [] — the legacy 60 m short-range gameplay path is retired (Phase 7).
 * Fail-closed on unpublished optics/NETD; applies Johnson range, thermal contrast,
 * 3D slant distance, atmosphere, and terrain/building LOS. Contact positions stay exact.
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
  if (!environment) return []
  return checkStrictDetections(drone, heatSources, tick, seed, environment)
}
