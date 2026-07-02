import { mulberry32 } from '@/utils/rng'
import { haversineDistanceM } from '@/utils/geometry'
import type { DroneState, HeatSource, ThermalDetection } from '@/types'

// Thermal sensor model parameters
const SENSOR_RANGE_M = 60       // max detection range at cruise altitude
const ALT_RANGE_FACTOR = 0.4    // per 100ft altitude, range reduces by this fraction
const BASE_CONFIDENCE = 0.85
const NOISE_AMPLITUDE = 0.15

/**
 * Effective sensor range in meters, degraded by altitude.
 * At 100ft cruise: full range. Above 200ft: significantly reduced.
 */
function effectiveRangeM(altitudeFt: number): number {
  const altFactor = Math.max(0, 1 - (altitudeFt / 100) * ALT_RANGE_FACTOR)
  return SENSOR_RANGE_M * altFactor
}

/**
 * Check for thermal detections from a drone's current position.
 * Uses seeded PRNG for deterministic false-positive noise.
 * Labels are generic (no biometric/identity data — simulation only).
 */
export function checkThermalDetections(
  drone: DroneState,
  heatSources: HeatSource[],
  tick: number,
  seed: number,
): ThermalDetection[] {
  if (drone.missionState === 'idle' || drone.missionState === 'landed' || drone.altitudeFt < 5) {
    return []
  }

  const rng = mulberry32(seed ^ (tick * 1000003) ^ drone.id.charCodeAt(4))
  const range = effectiveRangeM(drone.altitudeFt)
  const detections: ThermalDetection[] = []

  for (const source of heatSources) {
    const distM = haversineDistanceM(drone.position, source.position)
    if (distM > range + source.radiusM) continue

    // Confidence degrades with distance and adds seeded noise
    const proximityFactor = 1 - Math.min(1, distM / (range + source.radiusM))
    const noise = (rng() - 0.5) * NOISE_AMPLITUDE
    const confidence = Math.min(1, Math.max(0, BASE_CONFIDENCE * proximityFactor + noise))

    // Only report above a minimum confidence threshold
    if (confidence < 0.3) continue

    detections.push({
      sourceId: source.id,
      class: source.class,
      position: source.position,
      confidence,
      tick,
    })
  }

  return detections
}
