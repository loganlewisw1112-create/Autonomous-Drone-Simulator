/**
 * Quality tiers and the degradation ladder.
 *
 * The ladder is FIXED and cumulative — each rung keeps everything the rungs above it gave up:
 *
 *   0 full            smoke 100 %, shadows 2048², LOD 300 / 1500 m
 *   1 smoke-half      smoke 50 %
 *   2 smoke-off       no smoke
 *   3 shadows-1024    shadow map 1024²
 *   4 shadows-off     no shadows
 *   5 lod-tight       LOD bands 150 / 800 m
 *   6 layer-off       the 3D layer unmounts; DOM markers return                (terminal)
 *
 * (The plan's first rung, "post-effects", has nothing to drop: no post pass exists, by design.)
 *
 * A TIER is where on the ladder the scene starts: cinematic = 0, balanced = 1, tactical = 4. The
 * governor may step DOWN from there when the layer runs over budget, and back UP to — never past —
 * the tier's own rung when there is headroom.
 *
 * What it measures is the LAYER'S OWN cost (ms inside render()), not whole-frame time. On an
 * integrated GPU the baseline map alone can exceed a 16.7 ms frame on a pitched terrain view; a
 * governor watching the whole frame would walk the ladder to "layer-off" on every such view without
 * making the map any faster. It can only give back what the layer took.
 */
export type QualityTier = 'cinematic' | 'balanced' | 'tactical'

export const LADDER = ['full', 'smoke-half', 'smoke-off', 'shadows-1024', 'shadows-off', 'lod-tight', 'layer-off'] as const
export type Rung = (typeof LADDER)[number]

export const TIER_RUNG: Record<QualityTier, number> = { cinematic: 0, balanced: 1, tactical: 4 }

export interface RungSettings {
  smokeAmount: number
  shadowMapSize: number
  shadows: boolean
  lodFullMaxM: number
  lodLowMaxM: number
  layerOn: boolean
}

export function settingsFor(rung: number): RungSettings {
  return {
    smokeAmount: rung >= 2 ? 0 : rung >= 1 ? 0.5 : 1,
    shadowMapSize: rung >= 3 ? 1024 : 2048,
    shadows: rung < 4,
    lodFullMaxM: rung >= 5 ? 150 : 300,
    lodLowMaxM: rung >= 5 ? 800 : 1500,
    layerOn: rung < 6,
  }
}

/** Layer budget, ms p75 — the plan's own per-layer ceiling. */
export const LAYER_BUDGET_MS = 8
const HEADROOM_MS = 4
const WINDOW_FRAMES = 60
const STEP_DOWN_AFTER_FRAMES = 60 // ~1 s over budget
const STEP_UP_AFTER_FRAMES = 180 // ~3 s of headroom: climbing back is deliberately slower than falling

export function tierForCost(p75LayerMs: number): QualityTier {
  return p75LayerMs <= HEADROOM_MS ? 'cinematic' : p75LayerMs <= LAYER_BUDGET_MS ? 'balanced' : 'tactical'
}

export interface QualityGovernor {
  readonly tier: QualityTier
  readonly rung: number
  readonly auto: boolean
  /** Pin a tier (user override) or hand control back to auto-selection. */
  setTier(tier: QualityTier | 'auto'): void
  /** Feed one frame's layer cost, ms. Returns true when the rung changed. */
  sample(layerMs: number): boolean
  history(): Array<{ frame: number; rung: number; p75: number }>
}

export function createQualityGovernor(apply: (settings: RungSettings, rung: number) => void): QualityGovernor {
  // Auto mode opens at full quality: the first three seconds there are what picks the tier.
  let tier: QualityTier = 'cinematic'
  let auto = true
  let autoSampled = false
  let rung = TIER_RUNG[tier]
  let frame = 0
  let over = 0
  let under = 0
  const window: number[] = []
  const log: Array<{ frame: number; rung: number; p75: number }> = []

  const p75 = () => [...window].sort((a, b) => a - b)[Math.floor(window.length * 0.75)] ?? 0
  const go = (next: number) => {
    rung = Math.min(LADDER.length - 1, Math.max(TIER_RUNG[tier], next))
    over = under = 0
    window.length = 0 // a rung change invalidates the samples taken under the old one
    log.push({ frame, rung, p75: 0 })
    apply(settingsFor(rung), rung)
  }

  return {
    get tier() { return tier },
    get rung() { return rung },
    get auto() { return auto },
    setTier(next) {
      auto = next === 'auto'
      tier = next === 'auto' ? 'cinematic' : next // auto re-opens at full quality and samples again
      frame = 0
      autoSampled = !auto
      go(TIER_RUNG[tier])
    },
    sample(layerMs) {
      frame++
      if (rung === LADDER.length - 1) return false // terminal: only the user turns the layer back on
      window.push(layerMs)
      if (window.length > WINDOW_FRAMES) window.shift()
      if (window.length < WINDOW_FRAMES) return false
      const cost = p75()

      // First run: three seconds at full quality decide the starting tier.
      if (auto && !autoSampled) {
        if (frame < 180) return false
        autoSampled = true
        tier = tierForCost(cost)
        go(TIER_RUNG[tier])
        return true
      }

      over = cost > LAYER_BUDGET_MS ? over + 1 : 0
      under = cost < HEADROOM_MS ? under + 1 : 0
      if (over >= STEP_DOWN_AFTER_FRAMES) { go(rung + 1); log[log.length - 1].p75 = cost; return true }
      if (under >= STEP_UP_AFTER_FRAMES && rung > TIER_RUNG[tier]) { go(rung - 1); log[log.length - 1].p75 = cost; return true }
      return false
    },
    history: () => log.slice(),
  }
}
