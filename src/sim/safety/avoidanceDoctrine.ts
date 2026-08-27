import type { ConflictPair } from '@/sim/safety/DeconflictEngine'
import type { DroneState, MissionState } from '@/types'

// Conflict-avoidance doctrine (audit F-05).
//
// Detection (DeconflictEngine) covers every state except landed/idle/preflight, but the
// maneuver used to be entered only from navigate, sar_grid and launch. Conflicts in hover,
// inspect, thermal_hold, route_complete_loiter and return_to_base were therefore detected
// and flagged while both aircraft flew on. This module states the disposition of EVERY
// mission state exactly once, so adding a state to MissionState fails the build here until
// somebody decides what that state does about traffic.
//
// Training doctrine, not a regulatory right-of-way rule.

export type AvoidanceRole =
  /** Airborne and expected to break off as the give-way aircraft. */
  | 'maneuver'
  /** Airborne but never pulled off its current behavior; other traffic gives way to it. */
  | 'protected'
  /** Not flying — cannot conflict and cannot maneuver. */
  | 'grounded'

export const AVOIDANCE_DOCTRINE: Record<MissionState, AvoidanceRole> = {
  // ── Grounded ───────────────────────────────────────────────────────────────
  idle: 'grounded',
  preflight: 'grounded',
  landed: 'grounded',
  recharge: 'grounded',
  remote_landed: 'grounded',
  stranded: 'grounded',
  recovery_requested: 'grounded',
  recovery_enroute: 'grounded',
  recovered: 'grounded',
  unrecoverable_sim: 'grounded',

  // ── Airborne, gives way ────────────────────────────────────────────────────
  // 'launch' is included because fleets spawn from bays a few metres apart, so climb-out is
  // where conflicts actually occur — cruise altitude bands are separated enough that
  // conflicts are rare once established.
  launch: 'maneuver',
  navigate: 'maneuver',
  sar_grid: 'maneuver',
  hover: 'maneuver',
  inspect: 'maneuver',
  thermal_hold: 'maneuver',
  route_complete_loiter: 'maneuver',
  return_to_base: 'maneuver',

  // ── Airborne, protected ────────────────────────────────────────────────────
  // An aircraft descending on an emergency profile keeps priority; pulling it onto a
  // divergence heading would take it off the landing it is already committed to.
  emergency: 'protected',
  // No command link. Its value to the other aircraft is that its contingency path stays
  // predictable, so it holds and the other aircraft gives way.
  lost_link_hold: 'protected',
  // Already diverging — re-entering would reset the maneuver window every tick.
  avoid: 'protected',
}

export function avoidanceRole(state: MissionState): AvoidanceRole {
  return AVOIDANCE_DOCTRINE[state]
}

/** True when an aircraft in this state is expected to break off as the give-way aircraft. */
export function canEnterAvoidance(state: MissionState): boolean {
  return AVOIDANCE_DOCTRINE[state] === 'maneuver'
}

export interface GiveWayAssignment {
  /** The aircraft that breaks off. */
  giveWay: DroneState
  /** The aircraft it diverges away from. */
  conflictWith: DroneState
  /** The predicted pair that triggered the maneuver, kept for the avoidance_start event. */
  conflict: ConflictPair
}

/**
 * Pick which aircraft of a conflicting pair gives way.
 *
 * `idB` is preferred so the choice stays deterministic and matches the historical behavior.
 * The fallback to `idA` closes a second gap: when the pair was (maneuverable idA, protected
 * idB) the old idB-only rule meant NEITHER aircraft maneuvered and the conflict was merely
 * flagged. Returns null only when neither aircraft may maneuver, which is an honest
 * flag-only outcome rather than a silent no-op.
 */
export function selectGiveWayDrone(
  conflict: ConflictPair,
  drones: readonly DroneState[],
): GiveWayAssignment | null {
  const a = drones.find((drone) => drone.id === conflict.idA)
  const b = drones.find((drone) => drone.id === conflict.idB)
  if (!a || !b) return null

  if (canEnterAvoidance(b.missionState)) return { giveWay: b, conflictWith: a, conflict }
  if (canEnterAvoidance(a.missionState)) return { giveWay: a, conflictWith: b, conflict }
  return null
}

/**
 * Resolve give-way assignments for a whole tick's conflicts, keyed by the give-way aircraft.
 *
 * An aircraft already assigned by an earlier conflict keeps that assignment — it can only
 * fly one divergence heading, and conflict order is deterministic, so first assignment wins.
 *
 * NOTE ON PRECEDENCE: entering 'avoid' does not outrank the mission safety overrides in
 * getMissionSafetyOverride() — but the two interact each tick, and the observable result is
 * not simply "the override wins". Within one tick the mission manager runs first and pulls a
 * reserve-triggered aircraft back onto return_to_base; this pass then runs and, if the pair
 * is STILL predicted to conflict, assigns the divergence again. So while a conflict persists
 * the aircraft keeps giving way, and it only settles onto return_to_base once separation is
 * regained. That is the intended reading of the doctrine — loss of separation is the
 * immediate hazard, battery reserve is the slower one — and both halves are pinned by
 * avoidanceDoctrine.spec.ts.
 */
export function resolveGiveWayAssignments(
  conflicts: readonly ConflictPair[],
  drones: readonly DroneState[],
): Map<string, GiveWayAssignment> {
  const assignments = new Map<string, GiveWayAssignment>()
  for (const conflict of conflicts) {
    const selection = selectGiveWayDrone(conflict, drones)
    if (!selection) continue
    if (assignments.has(selection.giveWay.id)) continue
    assignments.set(selection.giveWay.id, selection)
  }
  return assignments
}
