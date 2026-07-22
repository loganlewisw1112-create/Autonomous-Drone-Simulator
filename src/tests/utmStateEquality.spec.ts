/**
 * Guards the value-equality check that stops the 10 Hz UTM recompute from re-rendering
 * TacticalMap on every interval tick.
 *
 * buildUtmAirspaceState() is called on a 100 ms interval but its inputs are near-static:
 * externalTracks and reservations are pure functions of the scenario, and conflicts only move
 * when a drone gets close to a track. Before utmAirspaceStateEquals(), every one of those
 * value-identical recomputes handed React a fresh object identity, which re-rendered the whole
 * 1400-line map component ten times a second from mount to unmount — including while sitting
 * idle with no scenario loaded.
 */
import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildUtmAirspaceState, utmAirspaceStateEquals } from '@/sim/demo/utmEngine'
import type { DroneState } from '@/types'

const scenario = ALL_SCENARIOS.find((item) => item.id === 'demo_sar_coastal') ?? ALL_SCENARIOS[0]

function droneNear(id: string, lat: number, lng: number, altitudeFt: number): DroneState {
  const base = {
    id,
    position: { lat, lng },
    altitudeFt,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: 100,
    signalDbm: -60,
  }
  return base as unknown as DroneState
}

describe('utmAirspaceStateEquals', () => {
  it('treats two recomputes from identical inputs as equal', () => {
    const a = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    const b = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    expect(a).not.toBe(b) // distinct objects...
    expect(utmAirspaceStateEquals(a, b)).toBe(true) // ...but the same value
  })

  it('stays equal as elapsed time advances, since nothing in the state depends on it', () => {
    const first = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    for (const elapsedSec of [1, 30, 120, 600]) {
      const later = buildUtmAirspaceState({ scenario, drones: [], elapsedSec })
      expect(utmAirspaceStateEquals(first, later)).toBe(true)
    }
  })

  it('is reflexive on the same reference', () => {
    const a = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    expect(utmAirspaceStateEquals(a, a)).toBe(true)
  })

  it('reports a difference when a drone closes on external traffic and raises a conflict', () => {
    const empty = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    const track = empty.externalTracks[0]
    expect(track).toBeDefined()

    // Park a drone directly under the track — inside the 650 m / 250 ft conflict envelope.
    const conflicting = buildUtmAirspaceState({
      scenario,
      drones: [droneNear('uav-01', track.position.lat, track.position.lng, track.altitudeFt)],
      elapsedSec: 0,
    })

    expect(conflicting.conflicts.length).toBeGreaterThan(0)
    expect(utmAirspaceStateEquals(empty, conflicting)).toBe(false)
  })

  it('reports a difference when the scenario changes the traffic picture', () => {
    const other = ALL_SCENARIOS.find((item) => item.id !== scenario.id)
    expect(other).toBeDefined()
    const a = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    const b = buildUtmAirspaceState({ scenario: other!, drones: [], elapsedSec: 0 })
    expect(utmAirspaceStateEquals(a, b)).toBe(false)
  })

  it('reports a difference against the null-scenario fallback', () => {
    const a = buildUtmAirspaceState({ scenario, drones: [], elapsedSec: 0 })
    const none = buildUtmAirspaceState({ scenario: null, drones: [], elapsedSec: 0 })
    expect(utmAirspaceStateEquals(a, none)).toBe(false)
  })
})
