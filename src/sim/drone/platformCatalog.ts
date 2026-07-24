import type { ScenarioConfig } from '@/types'

// ─── Platform catalog ────────────────────────────────────────────────────────
// Per-platform drone physics. Each entry describes a real-world sUAS airframe so
// scenarios can assign specific vehicles to specific drones. When a drone has no
// assigned platform the sim falls back to LEGACY_PLATFORM, whose four physics
// values reproduce the historical single-airframe behavior byte-for-byte.

export type PlatformId =
  | 'skydio_x10'
  | 'skydio_x10d'
  | 'parrot_anafi_usa'
  | 'teal_2'
  | 'freefly_astro_max'
  | 'brinc_lemur_2'

// Published thermal payload spec, sourced per airframe (see provenance below). Fields
// that a manufacturer does not publish are `null`, never guessed — that is what lets a
// diligence conversation trace every number. `pixelPitchUm` + `focalLengthMm` feed the
// Johnson-criteria detection model in `sensors/thermalRange.ts`; `netdMk` gates the
// object-vs-background contrast term. FLIR's Boson, Boson+, Lepton and Hadron cores all
// use a 12 µm detector pitch (published), so pitch is known even where focal length
// (rarely published — manufacturers cite FOV instead) is not.
//
// Radiometric metadata (`radiometric`, `radiometricAccuracyC`) is confidence/labeling
// only — the sim does NOT produce absolute temperature maps or a full IR image chain.
// Johnson detection + NETD/contrast is the fidelity ceiling (Phase 7 / WP-5).
//
// Sourced 2026-07-24, per airframe (Phase 7 radiometric upgrade):
//   Skydio X10 / X10D  FLIR Boson+ 640×512, 12 µm, EFL 13.6 mm, ≤30 mK
//                      (skydio.com/x10/technical-specs). Radiometric band ±5 °C class
//                      as operator metadata when the Boson+ radiometric option is fitted.
//   Teal 2             FLIR Hadron 640R — 640×512, 12 µm, EFL 13.6 mm / 32° HFOV,
//                      NETD <40 mK, radiometric temperature accuracy ±5 °C (0–100 °C)
//                      (Teledyne FLIR Hadron 640 Series datasheet).
//   Parrot Anafi USA   FLIR Boson 320×256, ≤60 mK, 50° HFOV — focal length not published
//                      (parrot.com). Radiometric ±5 °C class metadata when fitted.
//   BRINC Lemur 2      FLIR Lepton 160×120 — BRINC does not state which lens variant, and
//                      Lepton ships in 50/57/95/160° options, so BOTH focal length and
//                      HFOV stay null. Non-radiometric microbolometer class.
//   Freefly Astro Max  modular payload bay — no single integrated sensor. Catalog
//                      `thermal` stays null. Optional classroom profile
//                      `FREEFLY_MODULAR_THERMAL_BOSON_PLUS` documents a Boson+ 640 class
//                      payload operators may hang; not auto-assigned (POD stays fail-closed).
//
// Cross-check of the geometry (sensors/thermalRange.ts) against two independent manufacturers:
// 640 × 12 µm = 7.68 mm sensor width at f=13.6 mm gives HFOV 31.5° (Teal publishes 32°) and
// DFOV 39.8° (Skydio publishes 41°). The model reproduces both published figures.
export interface ThermalSensorSpec {
  sensor: string
  resolutionPx: [number, number]
  pixelPitchUm: number | null
  focalLengthMm: number | null
  /** Published horizontal FOV. Manufacturers cite this far more often than focal length, so
   *  `platformTaskRanges` derives f from it when `focalLengthMm` is null. Null when unpublished. */
  hfovDeg: number | null
  netdMk: number | null
  /**
   * True when the payload is a radiometric (temperature-measuring) core.
   * Used for operator labeling only — not an absolute-temp simulation claim.
   */
  radiometric: boolean
  /**
   * Published radiometric temperature-measurement accuracy band (°C), e.g. ±5.
   * Confidence/metadata for the operator HUD; null when non-radiometric or unpublished.
   */
  radiometricAccuracyC: number | null
}

export interface DronePlatformSpec {
  id: PlatformId | 'legacy'
  displayName: string
  /** 4-6 char tag for dense UI (fleet rows). */
  shortName: string
  vendor: string
  role: string
  massKg: number
  maxSpeedMs: number
  airframeMaxSpeedMs: number
  climbRateFtS: number
  turnRateDegS: number
  accelMs2: number
  windToleranceMs: number
  gustToleranceMs: number
  enduranceMin: number
  enduranceMultiplier: number
  /** Integrated thermal payload, or `null` when the airframe ships thermal as a modular option. */
  thermal: ThermalSensorSpec | null
}

// Regulatory reference: 57 mph (FAA Part 107 max groundspeed) ≈ 25.4 m/s.
export const LEGACY_FAA_SPEED_LIMIT_MS = 25.4

/**
 * Optional Freefly Astro Max modular payload (Boson+ 640 class) for classroom docs /
 * experiments. Not wired onto `PLATFORM_CATALOG.freefly_astro_max.thermal` — the airframe
 * is payload-agnostic and live POD must not invent an integrated sensor.
 */
export const FREEFLY_MODULAR_THERMAL_BOSON_PLUS: ThermalSensorSpec = {
  sensor: 'FLIR Boson+ (modular)',
  resolutionPx: [640, 512],
  pixelPitchUm: 12,
  focalLengthMm: 13.6,
  hfovDeg: 32,
  netdMk: 30,
  radiometric: true,
  radiometricAccuracyC: 5,
}

export const PLATFORM_CATALOG: Record<PlatformId, DronePlatformSpec> = {
  skydio_x10: {
    id: 'skydio_x10',
    displayName: 'Skydio X10',
    shortName: 'X10',
    vendor: 'Skydio',
    role: 'Primary patrol / ISR',
    massKg: 2.11,
    maxSpeedMs: 20,
    airframeMaxSpeedMs: 20,
    climbRateFtS: 19.7,
    turnRateDegS: 90,
    accelMs2: 3.5,
    windToleranceMs: 11.2,
    gustToleranceMs: 12.8,
    enduranceMin: 40,
    enduranceMultiplier: 1.3333,
    thermal: {
      sensor: 'FLIR Boson+',
      resolutionPx: [640, 512],
      pixelPitchUm: 12,
      focalLengthMm: 13.6,
      hfovDeg: null,
      netdMk: 30,
      radiometric: true,
      radiometricAccuracyC: 5,
    },
  },
  skydio_x10d: {
    id: 'skydio_x10d',
    displayName: 'Skydio X10D',
    shortName: 'X10D',
    vendor: 'Skydio',
    role: 'Weatherproof patrol / ISR',
    massKg: 2.11,
    maxSpeedMs: 20,
    airframeMaxSpeedMs: 20,
    climbRateFtS: 19.7,
    turnRateDegS: 90,
    accelMs2: 3.5,
    windToleranceMs: 11.2,
    gustToleranceMs: 12.8,
    enduranceMin: 40,
    enduranceMultiplier: 1.3333,
    thermal: {
      sensor: 'FLIR Boson+',
      resolutionPx: [640, 512],
      pixelPitchUm: 12,
      focalLengthMm: 13.6,
      hfovDeg: null,
      netdMk: 30,
      radiometric: true,
      radiometricAccuracyC: 5,
    },
  },
  parrot_anafi_usa: {
    id: 'parrot_anafi_usa',
    displayName: 'Parrot Anafi USA',
    shortName: 'ANAFI',
    vendor: 'Parrot',
    role: 'Fast-deploy compact',
    massKg: 0.485,
    maxSpeedMs: 14.7,
    airframeMaxSpeedMs: 14.7,
    climbRateFtS: 13.1,
    turnRateDegS: 100,
    accelMs2: 4,
    windToleranceMs: 14.7,
    gustToleranceMs: 14.7,
    enduranceMin: 32,
    enduranceMultiplier: 1.0667,
    // Parrot ANAFI USA: FLIR Boson 320×256, <60 mK (9 Hz microbolometer).
    thermal: {
      sensor: 'FLIR Boson',
      resolutionPx: [320, 256],
      pixelPitchUm: 12,
      focalLengthMm: null,
      hfovDeg: 50,
      netdMk: 60,
      radiometric: true,
      radiometricAccuracyC: 5,
    },
  },
  teal_2: {
    id: 'teal_2',
    displayName: 'Teal 2',
    shortName: 'TEAL2',
    vendor: 'Teal (Red Cat)',
    role: 'Night ops / thermal',
    massKg: 1.25,
    maxSpeedMs: 10,
    airframeMaxSpeedMs: 10,
    climbRateFtS: 8.2,
    turnRateDegS: 90,
    accelMs2: 3,
    windToleranceMs: 8,
    gustToleranceMs: 11.2,
    enduranceMin: 30,
    enduranceMultiplier: 1.0,
    // Teal 2: FLIR Hadron 640R — radiometric 640×512, NETD <40 mK, ±5 °C accuracy band.
    thermal: {
      sensor: 'FLIR Hadron 640R',
      resolutionPx: [640, 512],
      pixelPitchUm: 12,
      focalLengthMm: 13.6,
      hfovDeg: 32,
      netdMk: 40,
      radiometric: true,
      radiometricAccuracyC: 5,
    },
  },
  freefly_astro_max: {
    id: 'freefly_astro_max',
    displayName: 'Freefly Astro Max',
    shortName: 'ASTRO',
    vendor: 'Freefly',
    role: 'Mapping / heavy payload',
    massKg: 3.52,
    maxSpeedMs: 15,
    airframeMaxSpeedMs: 15,
    climbRateFtS: 6.6,
    turnRateDegS: 60,
    accelMs2: 2,
    windToleranceMs: 9,
    gustToleranceMs: 10,
    enduranceMin: 39,
    enduranceMultiplier: 1.3,
    // Modular payload bay — see FREEFLY_MODULAR_THERMAL_BOSON_PLUS for an optional profile.
    thermal: null,
  },
  brinc_lemur_2: {
    id: 'brinc_lemur_2',
    displayName: 'BRINC Lemur 2',
    shortName: 'LEMUR2',
    vendor: 'BRINC',
    role: 'Tactical entry / interior',
    massKg: 1.5,
    maxSpeedMs: 9,
    airframeMaxSpeedMs: 21.5,
    climbRateFtS: 9.8,
    turnRateDegS: 120,
    accelMs2: 4,
    windToleranceMs: 6,
    gustToleranceMs: 8,
    enduranceMin: 20,
    enduranceMultiplier: 0.6667,
    // BRINC Lemur 2: FLIR Lepton micro-thermal, 160×120 (7 Hz). Optics unpublished.
    thermal: {
      sensor: 'FLIR Lepton',
      resolutionPx: [160, 120],
      pixelPitchUm: 12,
      focalLengthMm: null,
      hfovDeg: null,
      netdMk: null,
      radiometric: false,
      radiometricAccuracyC: null,
    },
  },
}

// Generic airframe. The four physics values (turnRateDegS 90, maxSpeedMs 12,
// accelMs2 3, climbRateFtS 5 = 300/60) reproduce the historical DroneEntity
// constants exactly, keeping the default (unassigned) path byte-identical.
export const LEGACY_PLATFORM: DronePlatformSpec = {
  id: 'legacy',
  displayName: 'Standard UAS',
  shortName: 'STD',
  vendor: '—',
  role: 'Generic airframe',
  massKg: 2,
  maxSpeedMs: 12,
  airframeMaxSpeedMs: 12,
  climbRateFtS: 5,
  turnRateDegS: 90,
  accelMs2: 3,
  windToleranceMs: 12,
  gustToleranceMs: 14,
  enduranceMin: 30,
  enduranceMultiplier: 1,
  thermal: null,
}

export function platformForDrone(scenario: ScenarioConfig, droneId: string): DronePlatformSpec {
  const platformId = scenario.dronePlatforms?.[droneId]
  if (!platformId) return LEGACY_PLATFORM
  return PLATFORM_CATALOG[platformId] ?? LEGACY_PLATFORM
}
