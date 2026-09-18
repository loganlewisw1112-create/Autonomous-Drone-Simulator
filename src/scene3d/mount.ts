/**
 * The app-side mount for the 3D scene layer. DEFAULT OFF: it loads only when the page is opened with
 * `?scene3d=1`, so nothing here — three.js included — reaches a user who did not ask for it.
 *
 *   ?scene3d=1                     mount the layer (quality: auto)
 *   &quality=cinematic|balanced|tactical     pin a tier instead of auto-selecting
 *   &camera=orbit|chase|fpv|ground           start in a camera mode (default: tactical — hands off)
 *
 * The live handle is left on `window.__scene3d` for the console: `__scene3d.camera.setMode('GROUND')`,
 * `__scene3d.quality.setTier('cinematic')`, `__scene3d.disable()` (the kill switch).
 */
import type * as maplibregl from 'maplibre-gl'
import { useDroneStore } from '@/store/droneStore'
import { createBoundScene } from './fleetBinding'
import type { CameraMode, QualityTier, Scene3DHandle } from './index'

declare global {
  interface Window {
    __scene3d?: Scene3DHandle
  }
}

const TIERS: QualityTier[] = ['cinematic', 'balanced', 'tactical']
const MODES: CameraMode[] = ['TACTICAL', 'ORBIT', 'CHASE', 'FPV', 'GROUND']

export function mountScene3D(map: maplibregl.Map): () => void {
  const params = new URLSearchParams(window.location.search)
  const tier = TIERS.find((t) => t === params.get('quality'))
  const mode = MODES.find((m) => m === params.get('camera')?.toUpperCase())
  let handle: Scene3DHandle | null = null
  let scenarioId: string | null = null

  const sync = () => {
    const scenario = useDroneStore.getState().scenario
    if ((scenario?.id ?? null) === scenarioId) return
    scenarioId = scenario?.id ?? null
    handle?.dispose() // one scene per scenario: the ENU anchor, DEM and footprints all belong to it
    handle = scenario ? createBoundScene(map, scenario).handle : null
    window.__scene3d = handle ?? undefined
    if (!handle) return
    handle.quality.setTier(tier ?? 'auto')
    handle.enable()
    if (mode && mode !== 'TACTICAL') handle.camera.setMode(mode)
  }
  sync()
  const unsubscribe = useDroneStore.subscribe(sync)
  return () => {
    unsubscribe()
    handle?.dispose()
    window.__scene3d = undefined
  }
}
