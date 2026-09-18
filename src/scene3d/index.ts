/**
 * Public handle for the 3D scene layer. `disable()` is the kill switch: it unmounts the custom
 * layer, hands the aircraft back to the DOM markers, and leaves the 2D map exactly as it was.
 */
import * as THREE from 'three'
import type * as maplibregl from 'maplibre-gl'
import { FleetRenderer, type FleetFrame } from './fleet'
import { SCENE_LAYER_ID, SceneLayer, type SceneOrigin } from './SceneLayer'

export type { FleetFrame, SceneDrone } from './fleet'

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

  // PLACEHOLDER RIG — Phase 2 replaces this with the solar-driven sun/sky/IBL. It exists only so
  // PBR airframes are not black. Fixed and clock-free, so Phase 1 frames stay deterministic.
  const placeholderSky = new THREE.HemisphereLight(0xdfe9f5, 0x4a4f45, 1.4)
  const placeholderSun = new THREE.DirectionalLight(0xffffff, 2.2)
  placeholderSun.position.set(-0.4, -0.5, 0.8) // direction only: from the south-west, high
  layer.scene.add(placeholderSky, placeholderSun)

  const emptySky: FleetFrame = { drones: [], simTimeSec: 0 }
  let fleetSource = options.fleetSource ?? null
  layer.onBeforeRender = (frame) => fleet.update(frame, fleetSource ? fleetSource() : emptySky)

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
      fleet.dispose()
      layer.dispose()
    },
  }
}
