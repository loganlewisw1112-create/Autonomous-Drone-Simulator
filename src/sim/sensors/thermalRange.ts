import type { ThermalSensorSpec } from '@/sim/drone/platformCatalog'

// Johnson-criteria thermal detection geometry (REALISM_ROADMAP WP-5 / §18.1).
//
// Pure optics: how many detector pixels a target of critical dimension S subtends at
// range R, given the sensor's focal length f and pixel pitch p (all in consistent units):
//
//   pixels_across = S · f / (R · p)
//
// Detection / recognition / identification each need a threshold pixel count across the
// target. This module is the geometry only — the LOS gate (WP-4) and the atmospheric
// transmission and thermal-contrast (NETD) gates are applied by the detection pipeline
// that consumes these ranges. It changes no live sim behaviour on its own; it is the
// sourced physics WP-5 wires in once terrain occlusion (WP-4) lands.

export const JOHNSON_PIXELS = {
  detection: 2,
  recognition: 8,
  identification: 13,
} as const

export type JohnsonTask = keyof typeof JOHNSON_PIXELS

export interface OpticsInput {
  targetSizeM: number // critical dimension S (e.g. ~0.5 m for a person)
  focalLengthMm: number
  pixelPitchUm: number
  rangeM: number
}

/** Pixels subtended across the target at `rangeM`. Verified anchor: S=0.5 m, f=13 mm,
 *  p=12 µm, R=100 m → 5.42 px (REALISM_ROADMAP §18.1). */
export function pixelsAcrossTarget(o: OpticsInput): number {
  const f = o.focalLengthMm / 1000 // mm → m
  const p = o.pixelPitchUm / 1e6 // µm → m
  return (o.targetSizeM * f) / (o.rangeM * p)
}

/** Range at which the target subtends exactly `pixelsRequired` pixels — invert the relation. */
export function rangeForPixels(
  o: Omit<OpticsInput, 'rangeM'> & { pixelsRequired: number },
): number {
  const f = o.focalLengthMm / 1000
  const p = o.pixelPitchUm / 1e6
  return (o.targetSizeM * f) / (o.pixelsRequired * p)
}

export interface TaskRanges {
  detectionM: number
  recognitionM: number
  identificationM: number
}

/**
 * Effective focal length for a payload: the published figure when the manufacturer gives one,
 * otherwise derived from the published horizontal FOV and the detector geometry. Null when
 * neither is published — never guessed.
 *
 * Both routes are sourced data. Skydio and Teal publish EFL directly; Parrot publishes only a
 * 50° HFOV. The two agree where they overlap: 640 px × 12 µm at f = 13.6 mm gives 31.5° HFOV
 * against Teal's published 32°, so the derivation reproduces the manufacturers' own numbers.
 */
export function effectiveFocalLengthMm(sensor: ThermalSensorSpec | null): number | null {
  if (!sensor || sensor.pixelPitchUm == null) return null
  if (sensor.focalLengthMm != null) return sensor.focalLengthMm
  if (sensor.hfovDeg == null) return null
  return focalLengthFromHfov(sensor.hfovDeg, sensor.resolutionPx[0], sensor.pixelPitchUm)
}

/**
 * Detection/recognition/identification ranges for a platform's integrated thermal
 * payload against a target of size `targetSizeM`. Returns null when the payload's
 * pixel pitch and optics are not published (never guessed) — the honest signal
 * that this platform's range cannot yet be computed.
 */
export function platformTaskRanges(sensor: ThermalSensorSpec | null, targetSizeM: number): TaskRanges | null {
  const focalLengthMm = effectiveFocalLengthMm(sensor)
  if (!sensor || sensor.pixelPitchUm == null || focalLengthMm == null) return null
  const base = { targetSizeM, focalLengthMm, pixelPitchUm: sensor.pixelPitchUm }
  return {
    detectionM: rangeForPixels({ ...base, pixelsRequired: JOHNSON_PIXELS.detection }),
    recognitionM: rangeForPixels({ ...base, pixelsRequired: JOHNSON_PIXELS.recognition }),
    identificationM: rangeForPixels({ ...base, pixelsRequired: JOHNSON_PIXELS.identification }),
  }
}

/**
 * Derive focal length from a published horizontal FOV — manufacturers cite FOV far more
 * often than focal length, so this is the practical bridge to sourcing `focalLengthMm`.
 * f = (width_px · pitch) / (2 · tan(HFOV/2)).
 */
export function focalLengthFromHfov(hfovDeg: number, sensorWidthPx: number, pixelPitchUm: number): number {
  const sensorWidthMm = (sensorWidthPx * pixelPitchUm) / 1000
  return sensorWidthMm / (2 * Math.tan((hfovDeg * Math.PI) / 180 / 2))
}
