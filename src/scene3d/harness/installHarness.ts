/**
 * `window.__harness` — deterministic control surface for the Playwright gates in `/harness`.
 * Loaded only when HARNESS_ENABLED (see ./flag.ts); never part of a public bundle.
 *
 * The sim is a fixed-timestep machine (one `tick()` = 50 ms of sim time, results depend only
 * on step count), so freeze/step drive the REAL production `tick()` with the rAF driver
 * stopped. Nothing here reimplements simulation behaviour.
 */
import { LngLat } from 'maplibre-gl'
import type * as maplibregl from 'maplibre-gl'
import { tick, stopTicking } from '@/sim/SimulationLoop'
import { runQuickDemo } from '@/sim/demo/quickDemo'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { resolveTerrainFixtureId } from '@/scenarios/terrainFixtures'
import { useDroneStore } from '@/store/droneStore'

const TICK_SEC = 0.05
const FT_TO_M = 0.3048
const FRAME_BUFFER = 300

export interface HarnessDrone {
  id: string
  lng: number
  lat: number
  /** Metres above ground. `altitudeFt` in the fleet model is AGL. */
  altAgl: number
  heading: number
  mode: string
  platformId: string | null
}

export interface HarnessLoadResult {
  ok: boolean
  reason?: string
  seed?: number
  scenarioId?: string
}

export interface HarnessCameraOptions {
  center?: [number, number]
  zoom?: number
  bearing?: number
  pitch?: number
  roll?: number
  elevation?: number
  /** Lift MapLibre's pitch/ground clamps first (required for pitch > 60 and look-up shots). */
  unlock?: boolean
}

/** Filled in by Phase 0 when the 3D layer exists. */
export interface Scene3DHandle {
  disable(): void
  enable(): void
  info(): { calls: number; triangles: number; programs: number } | null
  [key: string]: unknown
}

export interface Harness {
  map: maplibregl.Map
  scene: Scene3DHandle | null
  sim: {
    scenarios(): Array<{ id: string; seed: number }>
    load(scenarioId: string): Promise<HarnessLoadResult>
    seed(n: number): Promise<HarnessLoadResult>
    freeze(tSeconds: number): number
    step(dtSeconds: number): number
    fleet(): HarnessDrone[]
    clock(): { tick: number; elapsedSec: number }
  }
  camera: {
    set(opts: HarnessCameraOptions): void
    fromTo(from: [number, number], fromAltM: number, to: [number, number], toAltM: number): void
    mode(name: string): void
  }
  render: {
    frameTimes(): number[]
    info(): { calls: number; triangles: number; programs: number } | null
  }
  ready(timeoutMs?: number): Promise<void>
}

declare global {
  interface Window {
    __harness?: Harness
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

/** Advance to an absolute store tick. One `tick()` may run several sub-steps (simSpeed), and
 *  no-ops entirely when the mission is not running — hence the call guard. */
function runToTick(target: number): number {
  stopTicking()
  let calls = 0
  while (useDroneStore.getState().tick < target && calls++ < target + 8) tick()
  return useDroneStore.getState().tick
}

export function installHarness(map: maplibregl.Map): Harness {
  // CSS animations/transitions (marker pulses, REC dot) are wall-clock driven and would make
  // two frozen-clock screenshots differ. Kill them at the source for harness runs only.
  const style = document.createElement('style')
  style.dataset.harness = '1'
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}'
  document.head.appendChild(style)

  const frameTimes: number[] = []
  let lastFrame: number | null = null
  const sample = (now: number) => {
    if (lastFrame !== null) {
      frameTimes.push(now - lastFrame)
      if (frameTimes.length > FRAME_BUFFER) frameTimes.shift()
    }
    lastFrame = now
    requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)

  const terrainSettled = (): boolean => {
    const scenario = useDroneStore.getState().scenario
    if (!scenario || !resolveTerrainFixtureId(scenario)) return true
    const terrain = map.getTerrain()
    // addScenarioTerrainLayer is async after scenario load — no terrain yet means not ready.
    if (!terrain) return false
    return map.isSourceLoaded(terrain.source)
  }

  const load = async (scenarioId: string) => {
    const result = await runQuickDemo(scenarioId)
    // runQuickDemo ends with startSimLoop(); this continuation runs before any rAF frame,
    // so the clock is still exactly T+0 when the driver is cancelled.
    stopTicking()
    if (!result.ok) return { ok: false, reason: result.reason }
    const scenario = useDroneStore.getState().scenario
    return { ok: true, seed: scenario?.seed, scenarioId: scenario?.id }
  }

  const harness: Harness = {
    map,
    scene: null,
    sim: {
      scenarios: () => ALL_SCENARIOS.map((s) => ({ id: s.id, seed: s.seed })),
      load,
      seed: async (n) => {
        const found = ALL_SCENARIOS.find((s) => s.seed === n)
        if (!found) return { ok: false, reason: `no active-catalog scenario has seed ${n}` }
        return load(found.id)
      },
      freeze: (tSeconds) => runToTick(Math.round(tSeconds / TICK_SEC)),
      step: (dtSeconds) =>
        runToTick(useDroneStore.getState().tick + Math.max(0, Math.round(dtSeconds / TICK_SEC))),
      fleet: () =>
        useDroneStore.getState().drones.map((d) => ({
          id: d.id,
          lng: d.position.lng,
          lat: d.position.lat,
          altAgl: d.altitudeFt * FT_TO_M,
          heading: d.headingDeg,
          mode: d.missionState,
          platformId: d.platformId ?? null,
        })),
      clock: () => {
        const s = useDroneStore.getState()
        return { tick: s.tick, elapsedSec: s.elapsedSec }
      },
    },
    camera: {
      set: ({ unlock, ...opts }) => {
        if (unlock) {
          map.setMaxPitch(180)
          map.setCenterClampedToGround(false)
        }
        map.jumpTo(opts)
      },
      fromTo: (from, fromAltM, to, toAltM) => {
        map.setMaxPitch(180)
        map.setCenterClampedToGround(false)
        map.jumpTo(map.calculateCameraOptionsFromTo(
          new LngLat(from[0], from[1]), fromAltM,
          new LngLat(to[0], to[1]), toAltM,
        ))
      },
      mode: (name) => {
        throw new Error(`camera mode "${name}" unavailable: the camera director lands in Phase 4`)
      },
    },
    render: {
      frameTimes: () => frameTimes.slice(),
      info: () => harness.scene?.info() ?? null,
    },
    ready: async (timeoutMs = 30_000) => {
      const started = performance.now()
      const expired = () => performance.now() - started > timeoutMs
      const state = () => `loaded=${map.loaded()} tiles=${map.areTilesLoaded()} moving=${map.isMoving()} terrain=${terrainSettled()}`
      let settledFrames = 0
      while (settledFrames < 2) {
        if (expired()) throw new Error(`__harness.ready timed out: ${state()}`)
        await nextFrame()
        const settled = map.loaded() && map.areTilesLoaded() && !map.isMoving() && terrainSettled()
        settledFrames = settled ? settledFrames + 1 : 0
      }
      // Tiles being loaded is not the end: symbol placement cross-fades for ~300 ms afterwards, and a
      // label caught mid-fade differs between launches. `idle` is MapLibre's own "no transition,
      // no pending tile, no fade in flight" signal, so force one more paint and wait for it.
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error(`__harness.ready timed out waiting for idle: ${state()}`)),
          Math.max(0, timeoutMs - (performance.now() - started)))
        void map.once('idle').then(() => { window.clearTimeout(timer); resolve() })
        map.triggerRepaint()
      })
      // DOM markers interpolate for 50 ms of wall time after the last tick; let that land.
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      await nextFrame()
      await nextFrame()
    },
  }

  window.__harness = harness
  return harness
}
