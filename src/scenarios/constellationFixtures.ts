import type { SatelliteLook } from '@/sim/nav/dop'
import wildfireConstellation from './fixtures/demo_wildfire/constellation.json'

// Frozen GPS constellation look angles produced by tools/fixtures/constellation.mjs
// (REALISM_ROADMAP WP-0 / WP-7 §7.2 step 1). Same shape as terrainFixtures/observedWeather:
// a static import of committed data keyed by scenario id. Never a runtime fetch (§3).
//
// The committed payload is the *output* of the orbital propagation, not the almanac — the
// IS-GPS-200 Keplerian maths lives in the authoring tool and is never shipped. What ships is a
// few KB of azimuth/elevation per epoch, and an interpolation over it.

/** One satellite at one epoch: `[prn, azDeg, elDeg]`, packed to keep the fixture small. */
type PackedLook = [number, number, number]

export interface ConstellationFixture {
  reference: { lat: number; lng: number }
  startUtc: string
  stepSec: number
  epochs: PackedLook[][]
}

export interface SatelliteLookWithPrn extends SatelliteLook {
  prn: number
}

const CONSTELLATIONS: Record<string, ConstellationFixture> = {
  // Grizzly Peak / East Bay Hills — the same AO that carries the WP-4 terrain and buildings,
  // so GNSS occlusion has real geometry to be occluded by.
  demo_wildfire: wildfireConstellation as ConstellationFixture,
}

/** The frozen constellation for a scenario, or undefined when none is sourced yet. */
export function constellationFor(scenarioId: string | undefined): ConstellationFixture | undefined {
  return scenarioId ? CONSTELLATIONS[scenarioId] : undefined
}

/** Scenario ids that currently have a committed constellation. */
export function scenariosWithConstellation(): string[] {
  return Object.keys(CONSTELLATIONS)
}

/**
 * Look angles at a point in mission time, interpolated between the 5-minute epochs.
 *
 * §7.2's sampling argument: satellites move ~0.5°/min, so 5-minute epochs plus linear
 * interpolation track the real geometry to well under a degree — far finer than the elevation
 * mask or any occlusion decision cares about, at a fraction of the fixture size.
 *
 * Time past the last epoch clamps to it rather than extrapolating. A mission that outruns its
 * constellation window gets the last real geometry, never an invented one; the authoring tool's
 * `--hours` is what should be raised if that matters for a scenario.
 *
 * Pure: same `elapsedSec` always yields the same angles, which is what keeps replay identical.
 */
export function constellationAt(
  fixture: ConstellationFixture | undefined,
  elapsedSec: number,
): SatelliteLookWithPrn[] {
  if (!fixture || fixture.epochs.length === 0) return []

  const exact = Math.max(0, elapsedSec) / fixture.stepSec
  const lower = Math.min(fixture.epochs.length - 1, Math.floor(exact))
  const upper = Math.min(fixture.epochs.length - 1, lower + 1)
  const t = upper === lower ? 0 : exact - lower

  const next = new Map(fixture.epochs[upper].map((look) => [look[0], look]))
  const out: SatelliteLookWithPrn[] = []

  for (const [prn, azDeg, elDeg] of fixture.epochs[lower]) {
    const to = next.get(prn)
    if (!to) {
      // Setting between epochs: hold the last known angles rather than inventing a track for a
      // satellite the fixture stops reporting.
      out.push({ prn, azDeg, elDeg })
      continue
    }
    out.push({
      prn,
      azDeg: interpolateAzimuth(azDeg, to[1], t),
      elDeg: elDeg + (to[2] - elDeg) * t,
    })
  }
  return out.sort((a, b) => a.prn - b.prn)
}

/**
 * Interpolate azimuth the short way around the compass. Interpolating 359° → 1° linearly would
 * sweep a satellite backwards through the entire sky over one epoch, which would read as a wild
 * geometry change to the DOP calculation for no physical reason.
 */
function interpolateAzimuth(from: number, to: number, t: number): number {
  let delta = ((to - from + 540) % 360) - 180
  return ((from + delta * t) % 360 + 360) % 360
}
