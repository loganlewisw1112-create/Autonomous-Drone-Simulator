/**
 * Public handle for the 3D scene layer. `disable()` is the kill switch: it unmounts the custom
 * layer, hands the aircraft back to the DOM markers, and leaves the 2D map exactly as it was.
 */
import * as THREE from 'three'
import type * as maplibregl from 'maplibre-gl'
import { FleetRenderer, type FleetFrame } from './fleet'
import { Atmosphere, type AtmosphereFrame } from './atmosphere'
import { createCameraDirector, type CameraDirector } from './cameraDirector'
import { LightingRig } from './lighting'
import { createQualityGovernor, LADDER, type QualityTier } from './quality'
import { SensorVolumes, type VolumeFrame } from './volumes'
import { ShadowReceivers, type BuildingFootprint, type ReceiverStats } from './shadowReceivers'
import type { TerrainModel } from './terrainModel'
import { sunDirection, type SunPosition } from './sun'
import { SCENE_LAYER_ID, SceneLayer, type SceneOrigin } from './SceneLayer'

export type { FleetFrame, SceneDrone } from './fleet'
export type { SunPosition } from './sun'
export type { BuildingFootprint } from './shadowReceivers'
export type { VolumeFrame } from './volumes'
export type { AtmosphereFrame } from './atmosphere'
export type { QualityTier } from './quality'
export type { CameraDirector, CameraMode } from './cameraDirector'

export interface TestBoxOptions {
  lng: number
  lat: number
  /** Rendered elevation of the box CENTRE, metres MSL (DEM × exaggeration). */
  elevationM: number
  /** Edge length, or [east, north, up] extents, in metres. */
  sizeM: number | [number, number, number]
  color?: string
  /** false = always drawn (placement checks); true = occluded by terrain/buildings. Default true. */
  depthTest?: boolean
}

export interface Scene3DOptions {
  /** Where aircraft poses come from, pulled once per rendered frame. Omit for an empty sky. */
  fleetSource?: () => FleetFrame
  /** Where the sun is, pulled once per rendered frame from the SCENARIO clock. Omit for a fixed mid-morning sun. */
  sunSource?: () => SunPosition
  /** The drawn ground. Without it shadows fall on a flat plane at 0 m. */
  terrain?: TerrainModel
  /** Building footprints to stand in as shadow receivers/casters (the scenario's Overture fixture). */
  buildings?: () => BuildingFootprint[]
  /** Sensor volumes (thermal footprint, gimbal cone, GNSS ellipsoid, trails). Omit, or return null, for none. */
  volumeSource?: () => VolumeFrame | null
  /** Visibility, wind, fires and the scenario seed — what the fog and the smoke are made from. */
  atmosphereSource?: () => AtmosphereFrame | null
  /** Hides / restores the 2D layers whose concept the scene is drawing. `claim` runs every frame volumes are
   *  drawn; `release` runs once, the moment they stop — an empty scene must leave the map exactly as it found it. */
  ownership?: { claim(): void; release(): void }
}

export interface Scene3DHandle {
  enable(): void
  disable(): void
  isEnabled(): boolean
  info(): { calls: number; triangles: number; programs: number } | null
  layerRenderTimes(): number[]
  /** Swap the pose source (the gates fly synthetic fleets); `null` restores the one given at creation. */
  setFleetSource(source: (() => FleetFrame) | null): void
  fleetStats(): ReturnType<FleetRenderer['stats']>
  /** Pin the sun (gates, photo mode); `null` returns it to the scenario clock. */
  setSunOverride(position: SunPosition | null): void
  setBeacons(on: boolean): void
  /** Turn the sun's shadow casting off/on (the receivers stay mounted either way). */
  setShadows(on: boolean): void
  receiverStats(): ReceiverStats
  /** Building roofs receive aircraft shadows and buildings cast their own (caster/receiver split in
   *  shadowReceivers.ts). On by default in the product mount; a no-op where the scenario has no footprints. */
  setBuildingShadows(on: boolean): void
  readonly camera: CameraDirector
  /** Which aircraft the camera modes follow; `null` = the first one airborne. */
  follow(id: string | null): void
  setVolumeSource(source: (() => VolumeFrame | null) | null): void
  volumeStats(): { footprints: number; ellipsoids: number; trailSegments: number }
  /** Pin the visibility the fog is built from (gates); `null` returns it to the sim's weather. */
  setVisibilityOverride(km: number | null): void
  /** 0–1: how much of the smoke to draw. The quality ladder turns this down first. */
  setSmokeAmount(amount: number): void
  setGlare(on: boolean): void
  /** Sky + fog + smoke + glare as one switch. Off, the map keeps its own sky and the scene adds none of them. */
  setAtmosphere(on: boolean): void
  readonly quality: {
    readonly tier: QualityTier
    readonly rung: number
    readonly rungName: string
    readonly auto: boolean
    /** Pin a tier (user override), or 'auto' to let the first three seconds choose. */
    setTier(tier: QualityTier | 'auto'): void
    history(): Array<{ frame: number; rung: number; p75: number }>
    /** Test seam: extra layer cost (ms) as a function of the current rung, to rehearse a slow GPU. */
    setSyntheticCost(cost: ((rung: number) => number) | null): void
    /** What the current rung actually set — read back from the live objects, not from the table. */
    applied(): { smokeAmount: number; shadowMapSize: number; shadows: boolean; lodFullMaxM: number; lodLowMaxM: number; layerOn: boolean }
  }
  atmosphereStats(): { smokeParticles: number; glareVisible: boolean; visibilityKm: number; fogDensity: number; skyWrites: number }
  /** Scene position → CSS pixels, from the last drawn frame. */
  project(lng: number, lat: number, elevationM: number): { x: number; y: number } | null
  /** Low level: add/remove ONLY the custom layer, leaving camera, sky and 2D hand-off alone — for measuring
   *  what the layer adds to a frame against the same view without it. */
  setMounted(on: boolean): void
  lightingStats(): { sun: SunPosition; pmremPasses: number; darkness: number; sunIntensity: number }
  /** Matte white sphere, lit like everything else — for reading the light direction off pixels. */
  addTestSphere(options: { lng: number; lat: number; elevationM: number; radiusM: number }): void
  addTestBox(options: TestBoxOptions): void
  clearTestObjects(): void
  dispose(): void
}

// While the layer draws the aircraft, their DOM markers go transparent rather than hidden:
// they stay in the hit-test tree, so click-to-select keeps working on top of the 3D airframe.
const OWNS_DRONES_CLASS = 'scene3d-owns-drones'
const OWNS_DRONES_CSS = `.${OWNS_DRONES_CLASS} .drone-marker{opacity:0!important}`

export function createScene3D(map: maplibregl.Map, origin: SceneOrigin, options: Scene3DOptions = {}): Scene3DHandle {
  const layer = new SceneLayer(origin)
  const testObjects = new THREE.Group()
  const fleet = new FleetRenderer((lng, lat, elevationM, target) => layer.toScene(lng, lat, elevationM, target))
  layer.scene.add(testObjects, fleet.root)

  const lighting = new LightingRig(layer.scene)
  const receivers = new ShadowReceivers({
    toScene: (lng, lat, elevationM, target) => layer.toScene(lng, lat, elevationM, target),
    fromScene: (x, y) => layer.fromScene(x, y),
    groundAt: (lng, lat) => options.terrain?.groundAt(lng, lat) ?? 0,
    buildings: () => options.buildings?.() ?? [],
  })
  layer.scene.add(receivers.root)
  const volumes = new SensorVolumes({
    toScene: (lng, lat, elevationM, target) => layer.toScene(lng, lat, elevationM, target),
    groundAt: (lng, lat) => options.terrain?.groundAt(lng, lat) ?? 0,
  })
  layer.scene.add(volumes.root)
  let volumeSource = options.volumeSource ?? null
  const atmosphere = new Atmosphere(map, layer.scene, {
    toScene: (lng, lat, elevationM, target) => layer.toScene(lng, lat, elevationM, target),
    groundAt: (lng, lat) => options.terrain?.groundAt(lng, lat) ?? 0,
  })
  layer.scene.add(atmosphere.root)
  let visibilityOverride: number | null = null
  let userShadows = true
  let userSmoke = 1
  let syntheticCost: ((rung: number) => number) | null = null
  let turnLayerOff: (() => void) | null = null
  const governor = createQualityGovernor((settings) => {
    atmosphere.smokeAmount = userSmoke * settings.smokeAmount
    lighting.setShadowMapSize(settings.shadowMapSize)
    lighting.sun.castShadow = userShadows && settings.shadows
    fleet.lodFullMaxM = settings.lodFullMaxM
    fleet.lodLowMaxM = settings.lodLowMaxM
    if (!settings.layerOn) turnLayerOff?.()
  })
  const toSun = new THREE.Vector3()
  let followId: string | null = null
  let owning = false
  const FIXED_SUN: SunPosition = { azimuthDeg: 135, elevationDeg: 42 }
  let sunOverride: SunPosition | null = null
  let beaconsOn = true

  const emptySky: FleetFrame = { drones: [], simTimeSec: 0 }
  let fleetSource = options.fleetSource ?? null
  layer.onBeforeRender = (frame, renderer) => {
    // Last frame's layer cost feeds the governor (this frame's is not known until it has been drawn).
    const lastMs = layer.layerRenderTimes().at(-1)
    if (lastMs !== undefined) governor.sample(lastMs + (syntheticCost?.(governor.rung) ?? 0))
    options.terrain?.refresh()
    lighting.update(frame, renderer, sunOverride ?? options.sunSource?.() ?? FIXED_SUN)
    // Shadows fade out with the sun: full by day, gone once only twilight glow is left.
    const strength = lighting.sun.castShadow && lighting.position.elevationDeg > 0 ? Math.min(1, lighting.palette.sunIntensity / 2.2) : 0
    receivers.update(frame, lighting.shadowRadius, strength, options.terrain?.reliefLive() ?? false)
    // Nav lights never go out; they are simply lost in daylight.
    const beaconGain = beaconsOn ? 0.3 + 0.7 * lighting.palette.darkness : 0
    fleet.update(frame, { ...(fleetSource ? fleetSource() : emptySky), beaconGain })
    const air = options.atmosphereSource?.() ?? null
    toSun.fromArray(sunDirection(lighting.position))
    atmosphere.update(frame, frame.mvp, lighting.palette, toSun, lighting.position.elevationDeg,
      visibilityOverride === null ? air : { ...(air ?? { windKts: 0, simTimeSec: 0, seed: 1, fires: [] }), visibilityKm: visibilityOverride })
    const volumeFrame = volumeSource ? volumeSource() : null
    volumes.update(volumeFrame)
    if (volumeFrame) {
      options.ownership?.claim()
      owning = true
    } else if (owning) {
      options.ownership?.release()
      owning = false
    }
  }

  const camera = createCameraDirector(map, {
    getSubject: () => {
      const drones = fleetSource ? fleetSource().drones : []
      const d = drones.find((x) => x.id === followId) ?? drones.find((x) => x.propRpm > 0) ?? drones[0]
      return d ? { lng: d.lng, lat: d.lat, elevationM: d.elevationM, headingDeg: d.headingDeg } : null
    },
    groundAt: (lng, lat) => options.terrain?.groundAt(lng, lat) ?? 0,
  })

  let enabled = false
  let style: HTMLStyleElement | null = null
  const ownDrones = (owns: boolean) => {
    if (owns && !style) {
      style = document.createElement('style')
      style.textContent = OWNS_DRONES_CSS
      document.head.appendChild(style)
    }
    map.getContainer().classList.toggle(OWNS_DRONES_CLASS, owns)
  }

  const mount = () => {
    // Top of the GL stack — see README › Render order.
    if (enabled && !map.getLayer(SCENE_LAYER_ID)) map.addLayer(layer)
  }
  // A style swap (remote → local fallback) drops every custom layer; re-mount when it lands.
  map.on('style.load', mount)

  const clearTestObjects = () => {
    for (const child of [...testObjects.children]) {
      testObjects.remove(child)
      const mesh = child as THREE.Mesh
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
    map.triggerRepaint()
  }

  const handle: Scene3DHandle = {
    enable() {
      enabled = true
      // Coming back from the ladder's terminal rung: start the tier over rather than stay switched off.
      if (governor.rung === LADDER.length - 1) governor.setTier(governor.auto ? 'auto' : governor.tier)
      ownDrones(fleetSource !== null)
      mount()
      map.triggerRepaint()
    },
    disable() {
      enabled = false
      camera.setMode('TACTICAL')
      options.ownership?.release()
      owning = false
      atmosphere.release()
      ownDrones(false)
      if (map.getLayer(SCENE_LAYER_ID)) map.removeLayer(SCENE_LAYER_ID)
      map.triggerRepaint()
    },
    isEnabled: () => enabled,
    info: () => layer.info(),
    layerRenderTimes: () => layer.layerRenderTimes(),
    setFleetSource(source) {
      fleetSource = source ?? options.fleetSource ?? null
      if (enabled) ownDrones(fleetSource !== null)
      map.triggerRepaint()
    },
    fleetStats: () => fleet.stats(),
    setSunOverride(position) {
      sunOverride = position
      map.triggerRepaint()
    },
    setShadows(on) {
      userShadows = on
      lighting.sun.castShadow = on && governor.rung < 4
      map.triggerRepaint()
    },
    receiverStats: () => ({ ...receivers.stats }),
    camera,
    follow(id) { followId = id },
    setVolumeSource(source) {
      volumeSource = source ?? options.volumeSource ?? null
      map.triggerRepaint()
    },
    project: (lng, lat, elevationM) => layer.project(lng, lat, elevationM),
    setMounted(on) {
      if (on) mount()
      else if (map.getLayer(SCENE_LAYER_ID)) map.removeLayer(SCENE_LAYER_ID)
      map.triggerRepaint()
    },
    volumeStats: () => ({ ...volumes.stats }),
    setVisibilityOverride(km) {
      visibilityOverride = km
      map.triggerRepaint()
    },
    setSmokeAmount(amount) {
      userSmoke = Math.min(1, Math.max(0, amount))
      atmosphere.smokeAmount = userSmoke * (governor.rung >= 2 ? 0 : governor.rung >= 1 ? 0.5 : 1)
      map.triggerRepaint()
    },
    setAtmosphere(on) {
      atmosphere.enabled = on
      map.triggerRepaint()
    },
    setGlare(on) {
      atmosphere.glareEnabled = on
      map.triggerRepaint()
    },
    atmosphereStats: () => ({ ...atmosphere.stats }),
    quality: {
      get tier() { return governor.tier },
      get rung() { return governor.rung },
      get rungName() { return LADDER[governor.rung] },
      get auto() { return governor.auto },
      setTier: (tier) => governor.setTier(tier),
      history: () => governor.history(),
      setSyntheticCost: (cost) => { syntheticCost = cost },
      applied: () => ({
        smokeAmount: atmosphere.smokeAmount, shadowMapSize: lighting.sun.shadow.mapSize.x, shadows: lighting.sun.castShadow,
        lodFullMaxM: fleet.lodFullMaxM, lodLowMaxM: fleet.lodLowMaxM, layerOn: enabled,
      }),
    },
    setBuildingShadows(on) {
      receivers.setBuildingsEnabled(on)
      map.triggerRepaint()
    },
    setBeacons(on) {
      beaconsOn = on
      map.triggerRepaint()
    },
    lightingStats: () => ({
      sun: lighting.position, pmremPasses: lighting.pmremPasses,
      darkness: lighting.palette.darkness, sunIntensity: lighting.palette.sunIntensity,
    }),
    addTestSphere({ lng, lat, elevationM, radiusM }) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(radiusM, 48, 24),
        new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0, fog: false }),
      )
      layer.toScene(lng, lat, elevationM, mesh.position)
      testObjects.add(mesh)
      map.triggerRepaint()
    },
    addTestBox({ lng, lat, elevationM, sizeM, color = '#ff00ff', depthTest = true }) {
      const [sx, sy, sz] = typeof sizeM === 'number' ? [sizeM, sizeM, sizeM] : sizeM
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshBasicMaterial({ color, depthTest, depthWrite: depthTest, fog: false }), // test geometry keeps its exact colour
      )
      layer.toScene(lng, lat, elevationM, mesh.position)
      testObjects.add(mesh)
      map.triggerRepaint()
    },
    clearTestObjects,
    dispose() {
      map.off('style.load', mount)
      ownDrones(false)
      style?.remove()
      if (map.getLayer(SCENE_LAYER_ID)) map.removeLayer(SCENE_LAYER_ID)
      clearTestObjects()
      camera.destroy()
      options.ownership?.release()
      atmosphere.dispose()
      volumes.dispose()
      receivers.dispose()
      lighting.dispose()
      fleet.dispose()
      layer.dispose()
    },
  }
  turnLayerOff = () => handle.disable() // the ladder's last rung IS the kill switch
  return handle
}
