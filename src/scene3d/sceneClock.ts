/**
 * The scenario's clock as a UTC instant — the ONLY time source the 3D scene may use. Never the wall
 * clock: a replay must light exactly as the original run did.
 *
 *   instant = (scenario date, time-of-day variant → a start instant at the AOI) + sim elapsed seconds
 *
 * A scenario carries a calendar date only when it has an observed-weather fixture; otherwise the
 * September equinox is used (sun paths symmetric, a neutral default — documented, not a claim about
 * the incident). The `timeOfDay` variant is resolved to a real solar event at the AOI on that date.
 */
import { sunPosition } from './sun'

export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night'

export const DEFAULT_SCENE_DATE = '2024-09-22'
const LOW_SUN_DEG = 5 // dawn and dusk start with the sun this far above the horizon
const MINUTE_MS = 60_000

const cache = new Map<string, number>()

/** UTC ms at which `timeOfDay` begins on `date` (YYYY-MM-DD) at the given place. */
export function startInstant(date: string, timeOfDay: TimeOfDay, latDeg: number, lngDeg: number): number {
  const key = `${date}|${timeOfDay}|${latDeg.toFixed(3)}|${lngDeg.toFixed(3)}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  // Local solar noon to within a few minutes; the scan below does the precise work.
  const roughNoon = Date.parse(`${date}T12:00:00Z`) - (lngDeg / 15) * 3_600_000
  let noon = roughNoon
  let best = -Infinity
  for (let m = -90; m <= 90; m++) {
    const e = sunPosition(roughNoon + m * MINUTE_MS, latDeg, lngDeg).elevationDeg
    if (e > best) { best = e; noon = roughNoon + m * MINUTE_MS }
  }

  let instant = noon
  if (timeOfDay === 'night') {
    instant = noon + 12 * 3_600_000
  } else if (timeOfDay !== 'day') {
    // Walk away from noon until the sun drops to the low-sun elevation (polar day: fall back to ±6 h).
    const step = timeOfDay === 'dawn' ? -MINUTE_MS : MINUTE_MS
    instant = noon + step * 360
    for (let m = 0; m <= 720; m++) {
      if (sunPosition(noon + step * m, latDeg, lngDeg).elevationDeg <= LOW_SUN_DEG) { instant = noon + step * m; break }
    }
  }
  cache.set(key, instant)
  return instant
}

export function sceneInstant(input: { date?: string; timeOfDay: TimeOfDay; latDeg: number; lngDeg: number; elapsedSec: number }): number {
  return startInstant(input.date ?? DEFAULT_SCENE_DATE, input.timeOfDay, input.latDeg, input.lngDeg) + input.elapsedSec * 1000
}
