// Accessible text equivalent for the tactical map (ACCESSIBILITY.md — "Map-based
// spatial information may not have an equivalent linear description").
//
// The MapLibre canvas is a graphical surface with no meaning to a screen reader.
// This module turns the same live state the map draws from into a compact, linear
// description. It is a PURE function of state so it can be unit-tested and so the
// live region can update deterministically. Nothing here is on the sim's hot path.

import type { DroneState, MissionState, LatLng } from '@/types'
import { batteryAlert } from '@/sim/drone/DroneEntity'

/** Plain-English label for each mission state, for readers who can't see marker color/shape. */
const MISSION_STATE_WORDS: Record<MissionState, string> = {
  idle: 'idle',
  preflight: 'in preflight',
  launch: 'launching',
  navigate: 'en route',
  sar_grid: 'flying search grid',
  hover: 'holding position',
  inspect: 'inspecting a contact',
  thermal_hold: 'holding on a thermal contact',
  lost_link_hold: 'holding — link lost',
  route_complete_loiter: 'loitering, route complete',
  avoid: 'avoiding traffic',
  return_to_base: 'returning to base',
  emergency: 'in emergency',
  landed: 'landed',
  recharge: 'recharging',
  remote_landed: 'landed away from base',
  stranded: 'stranded',
  recovery_requested: 'awaiting recovery',
  recovery_enroute: 'recovery team en route',
  recovered: 'recovered',
  unrecoverable_sim: 'unrecoverable',
}

/** Compass point from a heading in degrees, so a reader gets direction without a map. */
export function compassPoint(headingDeg: number): string {
  const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
  const idx = Math.round(((headingDeg % 360) + 360) % 360 / 45) % 8
  return dirs[idx]
}

function coord(pos: LatLng): string {
  return `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`
}

export interface TacticalSummaryInput {
  scenarioName?: string | null
  drones: DroneState[]
  /** Active (unresolved) thermal contacts currently on the map. */
  activeThermalContacts?: number
}

export interface TacticalSummary {
  /** One-line situation headline, safe to announce politely. */
  headline: string
  /** Per-drone lines for a navigable list. */
  drones: string[]
  /** Urgent conditions that warrant an assertive announcement. */
  alerts: string[]
}

/**
 * A drone's per-line description. Reports what an operator reads off the HUD:
 * label, what it's doing, altitude, heading, battery, and any warning flags.
 */
export function describeDrone(d: DroneState): string {
  const parts: string[] = [`${d.label}: ${MISSION_STATE_WORDS[d.missionState] ?? d.missionState}`]
  if (d.missionState !== 'idle' && d.missionState !== 'landed' && d.altitudeFt > 0) {
    parts.push(`${Math.round(d.altitudeFt)} feet`)
    parts.push(`heading ${compassPoint(d.headingDeg)}`)
  }
  parts.push(`battery ${Math.round(d.batteryPct)} percent`)
  const flags = droneAlertFlags(d)
  if (flags.length > 0) parts.push(flags.join(', '))
  parts.push(`at ${coord(d.position)}`)
  return parts.join('; ')
}

/** Warning conditions on a single drone, in plain words. Shared by the line and the alert list. */
function droneAlertFlags(d: DroneState): string[] {
  const flags: string[] = []
  if (batteryAlert(d) !== 'ok') flags.push('low battery')
  if (d.geofenceBreachFlag) flags.push('geofence breach')
  if (d.conflictFlag) flags.push('traffic conflict')
  if (d.missionState === 'emergency') flags.push('EMERGENCY')
  if (d.commsLostSec != null) flags.push('link lost')
  if (d.missionState === 'stranded' || d.missionState === 'recovery_requested') flags.push('stranded')
  return flags
}

export function buildTacticalSummary(input: TacticalSummaryInput): TacticalSummary {
  const { drones, scenarioName, activeThermalContacts = 0 } = input

  if (drones.length === 0) {
    return {
      headline: scenarioName
        ? `${scenarioName}. No aircraft on the map yet.`
        : 'No scenario loaded.',
      drones: [],
      alerts: [],
    }
  }

  const airborne = drones.filter(
    (d) => d.missionState !== 'idle' && d.missionState !== 'landed' && d.missionState !== 'preflight',
  ).length

  const headlineParts: string[] = []
  if (scenarioName) headlineParts.push(scenarioName)
  headlineParts.push(`${drones.length} aircraft, ${airborne} airborne`)
  if (activeThermalContacts > 0) {
    headlineParts.push(`${activeThermalContacts} active thermal ${activeThermalContacts === 1 ? 'contact' : 'contacts'}`)
  }

  const alerts: string[] = []
  for (const d of drones) {
    const flags = droneAlertFlags(d)
    if (flags.length > 0) alerts.push(`${d.label}: ${flags.join(', ')}`)
  }

  return {
    headline: headlineParts.join('. ') + '.',
    drones: drones.map(describeDrone),
    alerts,
  }
}
