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
import { resolveTerrainFixtureId, terrainFixtureFor, terrainRasterFor } from '@/scenarios/terrainFixtures'
import type { QualityTier, Scene3DHandle, SceneDrone } from '@/scene3d'
import { createBoundScene, type createLayerOwnership } from '@/scene3d/fleetBinding'
import type { CameraMode, VolumeFrame } from '@/scene3d'
import { wholeTileBounds, type TerrainModel } from '@/scene3d/terrainModel'
import { sunDirection } from '@/scene3d/sun'
import { sunPosition, type SunPosition } from '@/scene3d/sun'
import { containsLatLng, elevationAt } from '@/sim/terrain/terrainRaster'
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

export interface OccludedCameraQuery {
  target: { lng: number; lat: number; elevationM: number }
  /** Camera→target elevation angle, degrees. −30 ⇒ pitch 60 (looking down); +17 ⇒ pitch 107. */
  elevAngleDeg: number
  minMarginM?: number
}

export interface OccludedCamera {
  lng: number
  lat: number
  elevationM: number
  distanceM: number
  bearingDeg: number
  /** Least height by which rendered terrain clears the line of sight over the blocking run. */
  marginM: number
}

export interface OccludedShotQuery {
  elevAngleDeg: number
  aglM: number
  minMarginM?: number
  stepM?: number
}

export interface OccludedShot {
  target: { lng: number; lat: number; elevationM: number }
  camera: OccludedCamera
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
    /** The operator's EO/IR sensor-mode switch (thermal footprints exist only in IR). */
    sensorMode(mode: 'eo' | 'ir'): void
  }
  camera: {
    set(opts: HarnessCameraOptions): void
    fromTo(from: [number, number], fromAltM: number, to: [number, number], toAltM: number, fovDeg?: number): void
    /** Undo `unlock` / `fromTo`: ground clamp on, pitch cap 60, default FOV, no roll — the operator's camera rules. */
    relock(): void
    mode(name: string): void
    /** Same, but with the rig's own rAF loop running (for input-latency measurement). */
    live(name: string): void
    /** Step the camera rig by fixed dt (the rAF loop is off under the harness, so paths replay exactly). */
    advance(dtSec: number): void
    state(): ReturnType<Scene3DHandle['camera']['state']> | null
    follow(id: string | null): void
    /** Where a scene point lands on screen, from the last drawn frame. */
    project(lng: number, lat: number, elevationM: number): { x: number; y: number } | null
  }
  terrain: {
    /** Rendered elevation (sim DEM × live exaggeration), metres MSL; null outside the DEM. */
    elevationAt(lng: number, lat: number): number | null
    /** ONE-WAY for the life of the page: on maplibre-gl 6.9 a setTerrain(null) → setTerrain(spec)
     *  round trip leaves queryTerrainElevation() at 0 indefinitely (measured), so gates take every
     *  terrain-on frame first, disable once, and never re-enable. */
    disable(): void
    findOccludedCamera(query: OccludedCameraQuery): OccludedCamera | null
    findOccludedShot(query: OccludedShotQuery): OccludedShot | null
    /** The scene's model of the DRAWN ground (0 where the map shows no relief), as of the last frame. */
    drawnGroundAt(lng: number, lat: number): number
    /** Where the sun ray from a point meets the drawn ground — where its shadow must fall. */
    shadowHit(from: { lng: number; lat: number; elevationM: number }, sun: SunPosition): { lng: number; lat: number; elevationM: number } | null
    /** Where MapLibre actually draws relief — smaller than the sim's DEM. */
    liveBounds(): { west: number; south: number; east: number; north: number } | null
  }
  fleet: {
    /** Fly a hand-placed fleet instead of the sim's (prop phase still follows the SIM clock);
     *  `[]` = empty sky, `null` = back to the sim fleet. */
    synthetic(drones: SceneDrone[] | null): void
    /** One aircraft flying a figure-eight on the SIM clock, turning both ways. Its heading sweeps 45°→315° through
     *  SOUTH; `rotationDeg: 180` turns the pattern so the sweep runs through NORTH instead (the 359° → 1° wrap). */
    figureEight(spec: { lng: number; lat: number; elevationM: number; radiusM: number; speedMs: number; rotationDeg?: number } | null): void
    /** Fixed volume data, re-stamped with the live SIM clock so it rebuilds at the sim's cadence. */
    volumes(frame: VolumeFrame | null): void
    volumeStats(): ReturnType<Scene3DHandle['volumeStats']> | null
    ownedLayers(): Array<{ id: string; visibility: string }>
    stats(): ReturnType<Scene3DHandle['fleetStats']> | null
  }
  lighting: {
    /** The production solar algorithm, exposed so the gate can hold it to an independent table. */
    sunPosition(utcMs: number, latDeg: number, lngDeg: number): SunPosition
    override(position: SunPosition | null): void
    beacons(on: boolean): void
    shadows(on: boolean): void
    buildingShadows(on: boolean): void
    receiverStats(): ReturnType<Scene3DHandle['receiverStats']> | null
    timeOfDay(value: 'dawn' | 'day' | 'dusk' | 'night'): void
    stats(): ReturnType<Scene3DHandle['lightingStats']> | null
  }
  quality: {
    tier(tier: QualityTier | 'auto'): void
    /** Rehearse a slow GPU: extra layer cost, ms, per ladder rung (index = rung). */
    syntheticCost(msByRung: number[] | null): void
    state(): { tier: QualityTier; rung: number; rungName: string; auto: boolean; applied: ReturnType<Scene3DHandle['quality']['applied']>; history: ReturnType<Scene3DHandle['quality']['history']> } | null
    /** Add/remove only the custom layer (camera, sky, hand-off untouched): the on/off pair for added-cost measurement. */
    mounted(on: boolean): void
  }
  atmosphere: {
    visibilityKm(km: number | null): void
    smoke(amount: number): void
    glare(on: boolean): void
    /** Gates about lighting / shadows / GL state switch the atmosphere off so they measure only their own claim. */
    enable(on: boolean): void
    stats(): ReturnType<Scene3DHandle['atmosphereStats']> | null
  }
  buildings: {
    /** The roomiest footprint at least `minHeightM` tall — inside the drawn-relief block when one exists. */
    pick(minHeightM: number): { lng: number; lat: number; heightM: number; areaM2: number; onRelief: boolean } | null
  }
  dom: {
    /** Hide every DOM overlay above the GL canvas so pixel assertions see only what GL drew. */
    glOnly(on: boolean): void
  }
  render: {
    frameTimes(): number[]
    layerTimes(): number[]
    /** Render `n` consecutive frames (MapLibre is on-demand; budgets need a real frame run). */
    pump(n: number): Promise<void>
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

  let terrainSpec: { source: string; exaggeration?: number } | null = null
  let drawnGround: TerrainModel | null = null
  let ownership: ReturnType<typeof createLayerOwnership> | null = null
  let footprints: (() => Array<{ ring: Array<[number, number]>; heightM: number }>) | null = null
  let exaggeration = 1

  const terrainSettled = (): boolean => {
    const scenario = useDroneStore.getState().scenario
    if (terrainSpec || !scenario || !resolveTerrainFixtureId(scenario)) return true
    const terrain = map.getTerrain()
    // addScenarioTerrainLayer is async after scenario load — no terrain yet means not ready.
    if (!terrain || !map.isSourceLoaded(terrain.source)) return false
    return true
  }

  const load = async (scenarioId: string) => {
    const result = await runQuickDemo(scenarioId)
    // runQuickDemo ends with startSimLoop(); this continuation runs before any rAF frame,
    // so the clock is still exactly T+0 when the driver is cancelled.
    stopTicking()
    if (!result.ok) return { ok: false, reason: result.reason }
    const scenario = useDroneStore.getState().scenario
    harness.scene?.dispose()
    harness.scene = null
    if (scenario) {
      const bound = createBoundScene(map, scenario)
      drawnGround = bound.terrain
      ownership = bound.ownership
      footprints = bound.buildings
      harness.scene = bound.handle
      // Gates pin the tier: auto-selection re-tiers three seconds in, which would move frames under a test.
      bound.handle.quality.setTier('cinematic')
    }
    return { ok: true, seed: scenario?.seed, scenarioId: scenario?.id }
  }

  const renderedElevation = (lng: number, lat: number): number | null => {
    const scenario = useDroneStore.getState().scenario
    const raster = scenario ? terrainRasterFor(resolveTerrainFixtureId(scenario) ?? '') : undefined
    if (!raster || !containsLatLng(raster, lat, lng)) return null
    return elevationAt(raster, lat, lng) * (map.getTerrain()?.exaggeration ?? exaggeration)
  }

  const liveTerrainBounds = () => {
    const scenario = useDroneStore.getState().scenario
    return wholeTileBounds(terrainFixtureFor(scenario ? resolveTerrainFixtureId(scenario) ?? '' : '')?.header as Parameters<typeof wholeTileBounds>[0])
  }
  const insideLiveTerrain = (lng: number, lat: number): boolean => {
    const b = liveTerrainBounds()
    return b !== null && lng > b.west && lng < b.east && lat > b.south && lat < b.north
  }

  // March outward from the target along the required sight-line; once terrain has cleared the
  // line for >= 3 consecutive 10 m samples, every camera further out on that line is blocked.
  // A negative AGL (box under the surface) is the degenerate ridge: the hillside itself blocks.
  // Uses the sim's own DEM, so it is independent of which MapLibre terrain tiles are loaded.
  const findOccludedCamera = ({ target, elevAngleDeg, minMarginM = 25 }: OccludedCameraQuery): OccludedCamera | null => {
    const mPerDegLat = 111_320
    const mPerDegLng = mPerDegLat * Math.cos((target.lat * Math.PI) / 180)
    const slope = Math.tan((elevAngleDeg * Math.PI) / 180)
    let best: OccludedCamera | null = null
    for (let bearingDeg = 0; bearingDeg < 360; bearingDeg += 10) {
      const east = Math.sin((bearingDeg * Math.PI) / 180) / mPerDegLng
      const north = Math.cos((bearingDeg * Math.PI) / 180) / mPerDegLat
      let run = 0
      let runMin = Infinity
      let margin = 0
      let blockedAt = Infinity
      for (let d = 0; d <= 3000; d += 10) {
        const ground = renderedElevation(target.lng + east * d, target.lat + north * d)
        if (ground === null || !insideLiveTerrain(target.lng + east * d, target.lat + north * d)) break
        const sightLine = target.elevationM - d * slope
        if (margin >= minMarginM && d >= blockedAt + 120 && sightLine > ground + 3) {
          // First viable camera on this bearing: blocked, clear of the ridge, and above ground.
          if (!best || margin > best.marginM) {
            best = { lng: target.lng + east * d, lat: target.lat + north * d, elevationM: sightLine, distanceM: d, bearingDeg, marginM: margin }
          }
          break
        }
        const clearance = ground - sightLine
        if (clearance > 0) {
          run++
          runMin = Math.min(runMin, clearance)
          if (run >= 3 && runMin > margin) {
            margin = runMin
            blockedAt = d
          }
        } else {
          run = 0
          runMin = Infinity
        }
      }
    }
    return best
  }

  // No ridge may exist between a given aircraft and any camera at the required pitch. Scan the AO
  // for the box position (at `aglM` above ground) whose sight-line IS blocked by the most terrain.
  const findOccludedShot = ({ elevAngleDeg, aglM, minMarginM = 25, stepM = 150 }: OccludedShotQuery): OccludedShot | null => {
    const scenario = useDroneStore.getState().scenario
    const raster = scenario ? terrainRasterFor(resolveTerrainFixtureId(scenario) ?? '') : undefined
    if (!raster) return null
    const { west, south, east, north } = raster.bounds
    const dLat = stepM / 111_320
    const dLng = stepM / (111_320 * Math.cos((south * Math.PI) / 180))
    let best: OccludedShot | null = null
    for (let lat = south + dLat * 3; lat < north - dLat * 3; lat += dLat) {
      for (let lng = west + dLng * 3; lng < east - dLng * 3; lng += dLng) {
        const ground = renderedElevation(lng, lat)
        if (ground === null || !insideLiveTerrain(lng, lat)) continue
        const target = { lng, lat, elevationM: ground + aglM }
        const camera = findOccludedCamera({ target, elevAngleDeg, minMarginM })
        if (camera && (!best || camera.marginM > best.camera.marginM)) best = { target, camera }
      }
    }
    return best
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
      sensorMode: (mode) => {
        const s = useDroneStore.getState()
        useDroneStore.setState({ ui: { ...s.ui, sensorMode: mode } })
      },
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
      fromTo: (from, fromAltM, to, toAltM, fovDeg) => {
        map.setMaxPitch(180)
        map.setCenterClampedToGround(false)
        // FOV first: calculateCameraOptionsFromTo derives zoom from the current FOV.
        if (fovDeg !== undefined) map.setVerticalFieldOfView(fovDeg)
        map.jumpTo(map.calculateCameraOptionsFromTo(
          new LngLat(from[0], from[1]), fromAltM,
          new LngLat(to[0], to[1]), toAltM,
        ))
      },
      relock: () => {
        map.setCenterClampedToGround(true)
        map.setVerticalFieldOfView(36.87)
        map.setRoll(0)
        if (map.getPitch() > 60) map.jumpTo({ pitch: 60 })
        map.setMaxPitch(60)
      },
      mode: (name) => harness.scene?.camera.setMode(name as CameraMode, true),
      live: (name) => harness.scene?.camera.setMode(name as CameraMode),
      advance: (dtSec) => harness.scene?.camera.update(dtSec),
      state: () => harness.scene?.camera.state() ?? null,
      follow: (id) => harness.scene?.follow(id),
      project: (lng, lat, elevationM) => harness.scene?.project(lng, lat, elevationM) ?? null,
    },
    terrain: {
      elevationAt: renderedElevation,
      disable: () => {
        const live = map.getTerrain()
        if (!live) return
        terrainSpec = { source: live.source, exaggeration: live.exaggeration }
        exaggeration = live.exaggeration ?? 1
        map.setTerrain(null)
      },
      findOccludedCamera,
      findOccludedShot,
      liveBounds: liveTerrainBounds,
      drawnGroundAt: (lng, lat) => drawnGround?.groundAt(lng, lat) ?? 0,
      shadowHit: (from, sun) => {
        const [sx, sy, sz] = sunDirection(sun)
        if (sz <= 0.01) return null
        const mPerDegLat = 111_320
        const mPerDegLng = mPerDegLat * Math.cos((from.lat * Math.PI) / 180)
        for (let t = 0; t < 4000; t += 0.25) {
          const lng = from.lng - (sx * t) / mPerDegLng
          const lat = from.lat - (sy * t) / mPerDegLat
          const z = from.elevationM - sz * t
          const ground = drawnGround?.groundAt(lng, lat) ?? 0
          if (z <= ground) return { lng, lat, elevationM: ground }
        }
        return null
      },
    },
    fleet: {
      // A hand-placed fleet brings no sensor data with it: the real fleet's trails/ellipsoids must not
      // linger over a synthetic (or empty) sky. `fleet.volumes()` supplies them explicitly when wanted.
      synthetic: (drones) => {
        harness.scene?.setFleetSource(drones ? () => ({ drones, simTimeSec: useDroneStore.getState().elapsedSec }) : null)
        harness.scene?.setVolumeSource(drones ? () => null : null)
      },
      stats: () => harness.scene?.fleetStats() ?? null,
      figureEight: (spec) => { harness.scene?.setVolumeSource(spec ? () => null : null); harness.scene?.setFleetSource(spec ? () => {
        const t = useDroneStore.getState().elapsedSec
        // Lemniscate of Gerono: x = r·sin(a), y = r·sin(a)·cos(a); heading from its derivative.
        const a = (t * spec.speedMs) / spec.radiusM
        const rot = ((spec.rotationDeg ?? 0) * Math.PI) / 180
        const x = spec.radiusM * Math.sin(a), y = spec.radiusM * Math.sin(a) * Math.cos(a)
        // Clockwise rotation of the pattern (bearings grow clockwise), heading turned with it.
        const east = x * Math.cos(rot) + y * Math.sin(rot), north = -x * Math.sin(rot) + y * Math.cos(rot)
        const headingDeg = ((Math.atan2(Math.cos(a), Math.cos(2 * a)) * 180) / Math.PI + (spec.rotationDeg ?? 0) + 720) % 360
        return { simTimeSec: t, drones: [{ id: 'figure-eight', airframe: 'x10' as const, lng: spec.lng + east / (111_320 * Math.cos((spec.lat * Math.PI) / 180)),
          lat: spec.lat + north / 111_320, elevationM: spec.elevationM, headingDeg, speedMs: spec.speedMs, propRpm: 5600, gimbalYawDeg: 0, gimbalPitchDeg: -25, color: '#00e5ff' }] }
      } : null) },
      volumes: (frame) => harness.scene?.setVolumeSource(frame ? () => ({ ...frame, simTimeSec: useDroneStore.getState().elapsedSec }) : null),
      volumeStats: () => harness.scene?.volumeStats() ?? null,
      ownedLayers: () => (ownership?.owned() ?? []).map((id) => ({ id, visibility: String(map.getLayoutProperty(id, 'visibility') ?? 'visible') })),
    },
    lighting: {
      sunPosition,
      override: (position) => harness.scene?.setSunOverride(position),
      beacons: (on) => harness.scene?.setBeacons(on),
      shadows: (on) => harness.scene?.setShadows(on),
      buildingShadows: (on) => harness.scene?.setBuildingShadows(on),
      receiverStats: () => harness.scene?.receiverStats() ?? null,
      timeOfDay: (value) => {
        const s = useDroneStore.getState()
        useDroneStore.setState({ scenarioVariant: { ...s.scenarioVariant, timeOfDay: value } })
        map.triggerRepaint()
      },
      stats: () => harness.scene?.lightingStats() ?? null,
    },
    quality: {
      tier: (tier) => harness.scene?.quality.setTier(tier),
      syntheticCost: (msByRung) => harness.scene?.quality.setSyntheticCost(msByRung ? (rung) => msByRung[rung] ?? 0 : null),
      state: () => {
        const q = harness.scene?.quality
        return q ? { tier: q.tier, rung: q.rung, rungName: q.rungName, auto: q.auto, applied: q.applied(), history: q.history() } : null
      },
      mounted: (on) => harness.scene?.setMounted(on),
    },
    atmosphere: {
      visibilityKm: (km) => harness.scene?.setVisibilityOverride(km),
      smoke: (amount) => harness.scene?.setSmokeAmount(amount),
      glare: (on) => harness.scene?.setGlare(on),
      enable: (on) => harness.scene?.setAtmosphere(on),
      stats: () => harness.scene?.atmosphereStats() ?? null,
    },
    buildings: {
      pick: (minHeightM) => {
        const bounds = liveTerrainBounds()
        let best: { lng: number; lat: number; heightM: number; areaM2: number; onRelief: boolean } | null = null
        for (const { ring, heightM } of footprints?.() ?? []) {
          if (heightM < minHeightM || ring.length < 4) continue
          let lng = 0, lat = 0, twiceArea = 0
          for (let i = 0; i < ring.length - 1; i++) {
            lng += ring[i][0]; lat += ring[i][1]
            twiceArea += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
          }
          lng /= ring.length - 1; lat /= ring.length - 1
          const areaM2 = Math.abs(twiceArea / 2) * 111_320 * 111_320 * Math.cos((lat * Math.PI) / 180)
          const onRelief = bounds !== null && lng > bounds.west && lng < bounds.east && lat > bounds.south && lat < bounds.north
          if (!best || Number(onRelief) > Number(best.onRelief) || (onRelief === best.onRelief && areaM2 > best.areaM2)) best = { lng, lat, heightM, areaM2, onRelief }
        }
        return best
      },
    },
    dom: {
      glOnly: (on) => {
        const area = map.getContainer().closest('.map-area') ?? map.getContainer()
        const canvas = map.getCanvas()
        area.querySelectorAll<HTMLElement>('*').forEach((el) => {
          if (el === canvas || el.contains(canvas)) return
          el.style.visibility = on ? 'hidden' : ''
        })
      },
    },
    render: {
      frameTimes: () => frameTimes.slice(),
      layerTimes: () => harness.scene?.layerRenderTimes() ?? [],
      pump: async (n) => {
        for (let i = 0; i < n; i++) {
          map.triggerRepaint()
          await nextFrame()
        }
      },
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
