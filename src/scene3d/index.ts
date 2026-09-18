/**
 * Public handle for the 3D scene layer. `disable()` is the kill switch: it unmounts the custom
 * layer and leaves the 2D map exactly as it was before the layer existed.
 */
import * as THREE from 'three'
import type * as maplibregl from 'maplibre-gl'
import { SCENE_LAYER_ID, SceneLayer, type SceneOrigin } from './SceneLayer'

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

export interface Scene3DHandle {
  enable(): void
  disable(): void
  isEnabled(): boolean
  info(): { calls: number; triangles: number; programs: number } | null
  layerRenderTimes(): number[]
  addTestBox(options: TestBoxOptions): void
  clearTestObjects(): void
  dispose(): void
}

export function createScene3D(map: maplibregl.Map, origin: SceneOrigin): Scene3DHandle {
  const layer = new SceneLayer(origin)
  const testObjects = new THREE.Group()
  layer.scene.add(testObjects)
  let enabled = false

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
      mount()
      map.triggerRepaint()
    },
    disable() {
      enabled = false
      if (map.getLayer(SCENE_LAYER_ID)) map.removeLayer(SCENE_LAYER_ID)
      map.triggerRepaint()
    },
    isEnabled: () => enabled,
    info: () => layer.info(),
    layerRenderTimes: () => layer.layerRenderTimes(),
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
      if (map.getLayer(SCENE_LAYER_ID)) map.removeLayer(SCENE_LAYER_ID)
      clearTestObjects()
      layer.dispose()
    },
  }
}
