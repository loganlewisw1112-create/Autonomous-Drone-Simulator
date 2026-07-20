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

export interface DronePlatformSpec {
  id: PlatformId | 'legacy'
  displayName: string
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
}

// Regulatory reference: 57 mph (FAA Part 107 max groundspeed) ≈ 25.4 m/s.
export const LEGACY_FAA_SPEED_LIMIT_MS = 25.4

export const PLATFORM_CATALOG: Record<PlatformId, DronePlatformSpec> = {
  skydio_x10: {
    id: 'skydio_x10',
    displayName: 'Skydio X10',
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
  },
  skydio_x10d: {
    id: 'skydio_x10d',
    displayName: 'Skydio X10D',
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
  },
  parrot_anafi_usa: {
    id: 'parrot_anafi_usa',
    displayName: 'Parrot Anafi USA',
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
  },
  teal_2: {
    id: 'teal_2',
    displayName: 'Teal 2',
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
  },
  freefly_astro_max: {
    id: 'freefly_astro_max',
    displayName: 'Freefly Astro Max',
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
  },
  brinc_lemur_2: {
    id: 'brinc_lemur_2',
    displayName: 'BRINC Lemur 2',
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
  },
}

// Generic airframe. The four physics values (turnRateDegS 90, maxSpeedMs 12,
// accelMs2 3, climbRateFtS 5 = 300/60) reproduce the historical DroneEntity
// constants exactly, keeping the default (unassigned) path byte-identical.
export const LEGACY_PLATFORM: DronePlatformSpec = {
  id: 'legacy',
  displayName: 'Standard UAS',
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
}

export function platformForDrone(scenario: ScenarioConfig, droneId: string): DronePlatformSpec {
  const platformId = scenario.dronePlatforms?.[droneId]
  if (!platformId) return LEGACY_PLATFORM
  return PLATFORM_CATALOG[platformId] ?? LEGACY_PLATFORM
}
