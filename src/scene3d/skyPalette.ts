/**
 * One palette, keyed to solar elevation, feeds everything that has to agree about the time of day:
 * the sun and sky-fill lights, the IBL environment the airframes reflect, and (Phase 5) the colours
 * handed to `map.setSky()`. If models and sky ever disagree, the fix belongs here, in one place.
 *
 * Keyframes run from astronomical night through civil twilight and golden hour to high sun, and
 * are interpolated linearly. Values are starting points for the aesthetic pass, not measurements.
 *
 * Night fill and environment intensities are HIGH on purpose: the night sky colours are nearly black,
 * and an aircraft must stay readable as a dark shape rather than vanish (Gate 2.3: night airframe
 * luminance between 2 % and 20 % of noon). Think of it as the eye's dark adaptation, not moonlight.
 */
export interface SkyPalette {
  zenith: string
  horizon: string
  ground: string
  sun: string
  /** DirectionalLight intensity. Below the horizon this is the twilight glow, still from the sun's azimuth. */
  sunIntensity: number
  /** HemisphereLight intensity. */
  fillIntensity: number
  /** scene.environmentIntensity. */
  environmentIntensity: number
  /** 0 = broad daylight, 1 = full night. Nav lights and strobes scale with it. */
  darkness: number
}

interface Key extends SkyPalette {
  at: number
}

const KEYS: Key[] = [
  { at: -18, zenith: '#04060c', horizon: '#080d18', ground: '#05070a', sun: '#8fa3c8', sunIntensity: 0.0, fillIntensity: 1.5, environmentIntensity: 0.8, darkness: 1 },
  { at: -12, zenith: '#060a14', horizon: '#0f1a2e', ground: '#06080c', sun: '#8fa3c8', sunIntensity: 0.25, fillIntensity: 1.6, environmentIntensity: 0.9, darkness: 1 },
  { at: -6, zenith: '#0f1d3d', horizon: '#4a4468', ground: '#0c0f14', sun: '#c8a7b8', sunIntensity: 0.5, fillIntensity: 1.4, environmentIntensity: 0.9, darkness: 0.8 },
  { at: 0, zenith: '#27477f', horizon: '#e0916a', ground: '#2a2622', sun: '#ff8a4c', sunIntensity: 1.1, fillIntensity: 1.0, environmentIntensity: 0.8, darkness: 0.45 },
  { at: 6, zenith: '#3868b4', horizon: '#f2bf8c', ground: '#4a4438', sun: '#ffb070', sunIntensity: 2.2, fillIntensity: 0.85, environmentIntensity: 0.75, darkness: 0.2 },
  { at: 20, zenith: '#3a78c9', horizon: '#b9d4ee', ground: '#63604f', sun: '#ffe9c8', sunIntensity: 3.0, fillIntensity: 1.0, environmentIntensity: 1.0, darkness: 0 },
  { at: 90, zenith: '#2f6fc4', horizon: '#c4dcf2', ground: '#6b6a58', sun: '#fff6e6', sunIntensity: 3.2, fillIntensity: 1.05, environmentIntensity: 1.0, darkness: 0 },
]

const channels = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
const mixHex = (a: string, b: string, t: number): string => {
  const ca = channels(a)
  const cb = channels(b)
  return `#${ca.map((v, i) => Math.round(v + (cb[i] - v) * t).toString(16).padStart(2, '0')).join('')}`
}
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

export function skyPalette(elevationDeg: number): SkyPalette {
  const e = Math.min(90, Math.max(-18, elevationDeg))
  const hi = KEYS.findIndex((k) => k.at >= e)
  const b = KEYS[Math.max(hi, 0)]
  const a = KEYS[Math.max(hi - 1, 0)]
  const t = a === b ? 0 : (e - a.at) / (b.at - a.at)
  return {
    zenith: mixHex(a.zenith, b.zenith, t),
    horizon: mixHex(a.horizon, b.horizon, t),
    ground: mixHex(a.ground, b.ground, t),
    sun: mixHex(a.sun, b.sun, t),
    sunIntensity: mix(a.sunIntensity, b.sunIntensity, t),
    fillIntensity: mix(a.fillIntensity, b.fillIntensity, t),
    environmentIntensity: mix(a.environmentIntensity, b.environmentIntensity, t),
    darkness: mix(a.darkness, b.darkness, t),
  }
}
