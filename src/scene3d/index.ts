/**
 * Public handle for the 3D scene layer. `disable()` is the kill switch: it unmounts the custom
 * layer, hands the aircraft back to the DOM markers, and leaves the 2D map exactly as it was.
 */
import * as THREE from 'three'
import type * as maplibregl from 'maplibre-gl'
import { FleetRenderer, type FleetFrame } from './fleet'
import { LightingRig } from './lighting'
import type { SunPosition } from './sun'
import { SCENE_LAYER_ID, SceneLayer, type SceneOrigin } from './SceneLayer'

export type { FleetFrame, SceneDrone } from './fleet'
export type { SunPosition } from './sun'

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
  const FIXED_SUN: SunPosition = { azimuthDeg: 135, elevationDeg: 42 }
  let sunOverride: SunPosition | null = null
  let beaconsOn = true

  const emptySky: FleetFrame = { drones: [], simTimeSec: 0 }
  let fleetSource = options.fleetSource ?? null
  layer.onBeforeRender = (frame, renderer) => {
    lighting.update(frame, renderer, sunOverride ?? options.sunSource?.() ?? FIXED_SUN)
    // Nav lights never go out; they are simply lost in daylight.
    const beaconGain = beaconsOn ? 0.3 + 0.7 * lighting.palette.darkness : 0
    fleet.update(frame, { ...(fleetSource ? fleetSource() : emptySky), beaconGain })
  }

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

  return {
    enable() {
      enabled = true
      ownDrones(fleetSource !== null)
      mount()
      map.triggerRepaint()
    },
    disable() {
      enabled = false
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
        new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, metalness: 0 }),
      )
      layer.toScene(lng, lat, elevationM, mesh.position)
      testObjects.add(mesh)
      map.triggerRepaint()
    },
    addTestBox({ lng, lat, elevationM, sizeM, color = '#ff00ff', depthTest = true }) {
      const [sx, sy, sz] = typeof sizeM === 'number' ? [sizeM, sizeM, sizeM] : sizeM
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshBasicMaterial({ color, depthTest, depthWrite: depthTest }),
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
      lighting.dispose()
      fleet.dispose()
      layer.dispose()
    },
  }
}
