/**
 * The app-side mount for the 3D scene layer. ON by default for the desktop presentation of the windows and
 * classroom targets, opt-in on mobile and phone shells (flag.ts). It is still a lazy import, so three.js never
 * reaches a page where the flag is off.
 *
 *   (default)                      quality: balanced, the tier Gate 6 measured
 *   ?scene3d=1                     force the layer on, mobile included (quality: auto)
 *   ?scene3d=0                     force it off
 *   &quality=cinematic|balanced|tactical     pin a tier
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
  // Default-on visitors start at 'balanced', the tier Gate 6's matrix measured: the governor sees only the
  // layer's CPU time inside render(), not its GPU cost, so 'auto' could hold a weak GPU at 'cinematic'.
  // An explicit ?scene3d=1 keeps auto-selection; ?quality= pins any tier.
  const tier = TIERS.find((t) => t === params.get('quality')) ?? (params.get('scene3d') === '1' ? 'auto' : 'balanced')
  const mode = MODES.find((m) => m === params.get('camera')?.toUpperCase())
  let handle: Scene3DHandle | null = null
  let scenarioId: string | null = null
  let waitingForStyle = false
  let disposed = false

  const dropHandle = () => {
    handle?.dispose()
    handle = null
    window.__scene3d = undefined
  }

  // Runs inside the store's subscribers, i.e. inside setScenario(): nothing may escape it, or the scenario load
  // itself is cut short. A 3D failure leaves the 2D map in charge.
  const sync = () => {
    if (disposed || waitingForStyle) return
    const scenario = useDroneStore.getState().scenario
    if ((scenario?.id ?? null) === scenarioId) return
    scenarioId = scenario?.id ?? null
    dropHandle() // one scene per scenario: the ENU anchor, DEM and footprints all belong to it
    if (!scenario) return
    try {
      handle = createBoundScene(map, scenario).handle
      window.__scene3d = handle
      handle.quality.setTier(tier)
      handle.enable()
      handle.setBuildingShadows(true) // fixed (caster/receiver split); harmless where a scenario has no footprints
      if (mode && mode !== 'TACTICAL') handle.camera.setMode(mode)
    } catch (err) {
      dropHandle()
      if (/not done loading/i.test(String(err))) {
        // Scenario set before the basemap style arrived: build the scene once it has.
        scenarioId = null
        waitingForStyle = true
        map.once('style.load', () => {
          waitingForStyle = false
          sync()
        })
      } else {
        console.warn('[scene3d] scene not built; the 2D map stays in charge', err)
      }
    }
  }
  const unsubscribe = useDroneStore.subscribe(sync)
  sync()
  return () => {
    disposed = true
    unsubscribe()
    dropHandle()
  }
}
