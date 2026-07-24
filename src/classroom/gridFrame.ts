import type { DroneState, MissionState } from '@/types'
import type { AssessmentBand, MissionAssessment } from '@/classroom/missionAssessment'

// Tier-A "grid frame": the ~400 B packed snapshot every student publishes (~4 Hz).
// Objects are flattened to fixed-length tuples and lat/lng to integers ×1e5 (~1.1 m,
// far finer than a 200 px tile resolves) so 24 of these are noise on classroom wifi.
// Pure functions only — no store, no network — so the whole thing is unit-testable.

export type GridStatus = 0 | 1 | 2 | 3 // preflight | active | replay | stopped

// Comms/battery thresholds mirror the simulator: the store snapshots commsLostSec
// at signal < -90 dBm; -80 is the degraded band above it.
export const COMMS_LOST_DBM = -90
export const COMMS_DEGRADED_DBM = -80
export const BATTERY_LOW_PCT = 20
export const BATTERY_CRIT_PCT = 10

// Alert bitfield. Two severities drive the wall: CRIT tiles get a red border and
// promote to the top-left, WARN amber. Without this the wall is decorative.
export const Alert = {
  GEOFENCE_BREACH: 1 << 0,
  COMMS_LOST: 1 << 1,
  COMMS_DEGRADED: 1 << 2,
  BATTERY_LOW: 1 << 3,
  BATTERY_CRIT: 1 << 4,
  EMERGENCY: 1 << 5,
  CONFLICT: 1 << 6,
  THERMAL_NEW: 1 << 7,
  RTB: 1 << 8,
  RECOVERY_NEEDED: 1 << 9,
  STALLED: 1 << 10,
  IDLE: 1 << 11,
  LIFE_SAFETY_VIOLATION: 1 << 12,
  OFF_RUBRIC: 1 << 13,
} as const

export const CRIT_MASK =
  Alert.GEOFENCE_BREACH | Alert.COMMS_LOST | Alert.BATTERY_CRIT | Alert.EMERGENCY | Alert.CONFLICT | Alert.RECOVERY_NEEDED
  | Alert.LIFE_SAFETY_VIOLATION
export const WARN_MASK =
  Alert.COMMS_DEGRADED | Alert.BATTERY_LOW | Alert.RTB | Alert.STALLED | Alert.IDLE | Alert.THERMAL_NEW
  | Alert.OFF_RUBRIC

export type AlertSeverity = 'none' | 'warn' | 'crit'

export function alertSeverity(bits: number): AlertSeverity {
  if (bits & CRIT_MASK) return 'crit'
  if (bits & WARN_MASK) return 'warn'
  return 'none'
}

// Ordered so the index is a stable small int enum on the wire; the tile renderer
// colours a glyph by this code without shipping the MissionState string.
export const MISSION_STATE_CODES: MissionState[] = [
  'idle', 'preflight', 'launch', 'navigate', 'sar_grid', 'hover', 'inspect', 'thermal_hold',
  'route_complete_loiter', 'avoid', 'return_to_base', 'emergency', 'landed', 'recharge',
  'remote_landed', 'stranded', 'recovery_requested', 'recovery_enroute', 'recovered', 'unrecoverable_sim',
]

export function stateToCode(state: MissionState): number {
  const i = MISSION_STATE_CODES.indexOf(state)
  return i < 0 ? 0 : i
}

export function codeToState(code: number): MissionState {
  return MISSION_STATE_CODES[code] ?? 'idle'
}

const RECOVERY_STATES: ReadonlySet<MissionState> = new Set<MissionState>([
  'stranded', 'recovery_requested', 'recovery_enroute',
])

// The single drone tuple: [id, lat*1e5, lng*1e5, headingDeg, batteryPct, stateCode].
export type DroneTuple = [string, number, number, number, number, number]

export interface GridFrame {
  t: number // elapsedSec
  st: GridStatus
  d: DroneTuple[]
  a: number // alert bitfield (whole-fleet)
  th: number // thermal contact count
  ev: number // event count
  p?: number // assessment progress percent (omitted only for legacy peers)
  b?: AssessmentBand // rubric band
  sc?: number // rubric total
}

// Per-drone alert derivation from a live snapshot. STALLED/IDLE need timing history
// the publisher tracks over the mission, so they arrive via `extra` rather than being
// re-derived here; everything else falls out of one frame.
export function droneAlerts(drone: Pick<DroneState,
  'batteryPct' | 'signalDbm' | 'missionState' | 'geofenceBreachFlag' | 'conflictFlag'>): number {
  let bits = 0
  if (drone.geofenceBreachFlag) bits |= Alert.GEOFENCE_BREACH
  if (drone.conflictFlag) bits |= Alert.CONFLICT
  if (drone.signalDbm <= COMMS_LOST_DBM) bits |= Alert.COMMS_LOST
  else if (drone.signalDbm <= COMMS_DEGRADED_DBM) bits |= Alert.COMMS_DEGRADED
  if (drone.batteryPct < BATTERY_CRIT_PCT) bits |= Alert.BATTERY_CRIT
  else if (drone.batteryPct < BATTERY_LOW_PCT) bits |= Alert.BATTERY_LOW
  if (drone.missionState === 'emergency') bits |= Alert.EMERGENCY
  if (drone.missionState === 'return_to_base') bits |= Alert.RTB
  if (RECOVERY_STATES.has(drone.missionState)) bits |= Alert.RECOVERY_NEEDED
  return bits
}

export interface GridFrameInput {
  elapsedSec: number
  status: GridStatus
  drones: DroneState[]
  thermalContactCount: number
  eventCount: number
  newThermalContact?: boolean // set the frame a thermal is first detected
  extraAlerts?: number // STALLED / IDLE the publisher computes from history
  assessment?: Pick<MissionAssessment, 'progressPercent' | 'band' | 'total' | 'lifeSafety'>
}

export function buildGridFrame(input: GridFrameInput): GridFrame {
  let a = input.extraAlerts ?? 0
  if (input.newThermalContact) a |= Alert.THERMAL_NEW
  if (input.assessment?.lifeSafety.status === 'fail') a |= Alert.LIFE_SAFETY_VIOLATION
  if (input.assessment && (input.assessment.band === 'D' || input.assessment.band === 'F')) a |= Alert.OFF_RUBRIC
  const d: DroneTuple[] = input.drones.map((drone) => {
    a |= droneAlerts(drone)
    return [
      drone.id,
      Math.round(drone.position.lat * 1e5),
      Math.round(drone.position.lng * 1e5),
      Math.round(drone.headingDeg),
      Math.round(drone.batteryPct),
      stateToCode(drone.missionState),
    ]
  })
  return {
    t: Math.round(input.elapsedSec),
    st: input.status,
    d,
    a,
    th: input.thermalContactCount,
    ev: input.eventCount,
    ...(input.assessment
      ? {
          p: Math.max(0, Math.min(100, Math.round(input.assessment.progressPercent))),
          b: input.assessment.band,
          sc: Math.max(0, Math.min(100, Math.round(input.assessment.total))),
        }
      : {}),
  }
}

// Decoded single drone for the tile renderer.
export interface GridDrone {
  id: string
  lat: number
  lng: number
  headingDeg: number
  batteryPct: number
  stateCode: number
}

export function decodeDrone(tuple: DroneTuple): GridDrone {
  return { id: tuple[0], lat: tuple[1] / 1e5, lng: tuple[2] / 1e5, headingDeg: tuple[3], batteryPct: tuple[4], stateCode: tuple[5] }
}

// Tile-chrome helpers used by StudentTile / the roster strip.
export function frameActiveDroneCount(frame: GridFrame): number {
  return frame.d.filter((t) => {
    const s = codeToState(t[5])
    return s !== 'idle' && s !== 'landed' && s !== 'recovered' && s !== 'unrecoverable_sim'
  }).length
}

export function frameLowestBattery(frame: GridFrame): number | null {
  if (frame.d.length === 0) return null
  return frame.d.reduce((lo, t) => Math.min(lo, t[4]), 100)
}

// Shape validator for a frame just decrypted off the wire. Cheap structural check —
// a malformed tuple array should surface here, not as a NaN pixel later.
export function parseGridFrame(value: unknown): GridFrame {
  const f = value as GridFrame
  if (!f || typeof f !== 'object') throw new Error('gridFrame: not an object')
  if (typeof f.t !== 'number' || typeof f.st !== 'number' || !Array.isArray(f.d)) {
    throw new Error('gridFrame: bad shape')
  }
  for (const tuple of f.d) {
    if (!Array.isArray(tuple) || tuple.length !== 6 || typeof tuple[0] !== 'string') {
      throw new Error('gridFrame: bad drone tuple')
    }
  }
  if (f.p !== undefined && (!Number.isFinite(f.p) || f.p < 0 || f.p > 100)) throw new Error('gridFrame: bad progress')
  if (f.sc !== undefined && (!Number.isFinite(f.sc) || f.sc < 0 || f.sc > 100)) throw new Error('gridFrame: bad score')
  if (f.b !== undefined && !(['A', 'B', 'C', 'D', 'F'] as const).includes(f.b)) throw new Error('gridFrame: bad band')
  return f
}
