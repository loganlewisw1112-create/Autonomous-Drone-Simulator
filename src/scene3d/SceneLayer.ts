/**
 * three.js scene rendered as a MapLibre custom layer (`renderingMode: '3d'`), sharing MapLibre's
 * WebGL context and therefore its depth buffer — terrain and fill-extrusion buildings occlude scene
 * geometry with no extra work. See ./README.md for coordinate conventions and render order.
 */
import * as THREE from 'three'
import { MercatorCoordinate } from 'maplibre-gl'
import type * as maplibregl from 'maplibre-gl'

export const SCENE_LAYER_ID = 'scene3d'
const RENDER_TIME_BUFFER = 300

export interface SceneOrigin {
  lng: number
  lat: number
}

/** Camera facts for the frame about to be drawn, all in scene space (ENU metres). */
export interface FrameContext {
  cameraPosition: THREE.Vector3
  /** Unit vectors spanning the image plane — what a billboard must align to. */
  cameraRight: THREE.Vector3
  cameraUp: THREE.Vector3
  fovRad: number
  viewportHeightPx: number
}

/**
 * Scene space is ENU metres about one fixed anchor per scenario: +X east, +Y north, +Z up, with
 * Z = RENDERED elevation in metres above sea level (DEM × terrain exaggeration — the same number
 * `map.queryTerrainElevation()` returns). Geometry is never placed in raw mercator units: those
 * need ~1e-9 resolution at this latitude, which float32 vertex data does not have.
 */
export class SceneLayer implements maplibregl.CustomLayerInterface {
  readonly id = SCENE_LAYER_ID
  readonly type = 'custom' as const
  readonly renderingMode = '3d' as const
  readonly scene = new THREE.Scene()

  private readonly camera = new THREE.Camera()
  private readonly originTransform = new THREE.Matrix4()
  private readonly renderTimes: number[] = []
  private readonly inverse = new THREE.Matrix4()
  private readonly probe = new THREE.Vector4()
  private readonly frame: FrameContext = {
    cameraPosition: new THREE.Vector3(),
    cameraRight: new THREE.Vector3(1, 0, 0),
    cameraUp: new THREE.Vector3(0, 1, 0),
    fovRad: 0.6435,
    viewportHeightPx: 1,
  }
  /** Called inside render(), after the camera is solved and before three draws. */
  onBeforeRender: ((frame: FrameContext) => void) | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private map: maplibregl.Map | null = null
  private originX = 0
  private originY = 0
  private metresToMercator = 1
  private viewportW = 0
  private viewportH = 0

  constructor(origin: SceneOrigin) {
    this.scene.matrixWorldAutoUpdate = true
    this.setOrigin(origin)
  }

  setOrigin(origin: SceneOrigin): void {
    const anchor = MercatorCoordinate.fromLngLat([origin.lng, origin.lat], 0)
    this.originX = anchor.x
    this.originY = anchor.y
    this.metresToMercator = anchor.meterInMercatorCoordinateUnits()
  }

  /** lng/lat + rendered elevation (m MSL) → scene-space ENU metres. Exact in mercator by construction. */
  toScene(lng: number, lat: number, elevationM: number, target = new THREE.Vector3()): THREE.Vector3 {
    const p = MercatorCoordinate.fromLngLat([lng, lat], 0)
    return target.set(
      (p.x - this.originX) / this.metresToMercator,
      -(p.y - this.originY) / this.metresToMercator,
      elevationM,
    )
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
      this.renderer.autoClear = false
    }
  }

  onRemove(): void {
    this.map = null
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void {
    this.renderer?.resetState() // MUST stay first: three's state cache is stale after MapLibre drew.
    const renderer = this.renderer
    const map = this.map
    if (!renderer || !map) return
    const started = performance.now()

    // MapLibre never resizes three's idea of the viewport. setSize() would reassign canvas.width
    // and wipe MapLibre's frame, so only the viewport rectangle is tracked.
    const canvas = map.getCanvas()
    if (canvas.width !== this.viewportW || canvas.height !== this.viewportH) {
      this.viewportW = canvas.width
      this.viewportH = canvas.height
      renderer.setViewport(0, 0, canvas.width / renderer.getPixelRatio(), canvas.height / renderer.getPixelRatio())
    }

    // MapLibre scales ALL elevation in a frame by pixels-per-metre at the map CENTRE latitude, not
    // at each object's latitude. Deriving the vertical scale from the same latitude every frame is
    // what keeps scene geometry welded to the terrain instead of drifting ~0.5 m across the AO.
    const verticalScale = MercatorCoordinate.fromLngLat([0, map.getCenter().lat], 1).z
    const s = this.metresToMercator
    this.originTransform
      .makeTranslation(this.originX, this.originY, 0)
      .scale(new THREE.Vector3(s, -s, verticalScale))
    this.camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(this.originTransform)

    if (this.onBeforeRender) {
      this.solveFrame(args.fov, canvas.height)
      this.onBeforeRender(this.frame)
    }
    renderer.render(this.scene, this.camera)

    this.renderTimes.push(performance.now() - started)
    if (this.renderTimes.length > RENDER_TIME_BUFFER) this.renderTimes.shift()
  }

  // The projection matrix here is the whole world→clip transform, so camera facts are recovered
  // from its inverse instead of from MapLibre internals: the eye is the point that maps to w = 0,
  // and any two points on one clip-depth plane differ along the image-plane axes.
  private solveFrame(fovRad: number, viewportHeightPx: number): void {
    const inv = this.inverse.copy(this.camera.projectionMatrix).invert()
    const unproject = (x: number, y: number, z: number, w: number, out: THREE.Vector3) => {
      const v = this.probe.set(x, y, z, w).applyMatrix4(inv)
      return out.set(v.x / v.w, v.y / v.w, v.z / v.w)
    }
    const f = this.frame
    unproject(0, 0, 1, 0, f.cameraPosition)
    const centre = unproject(0, 0, 0.5, 1, new THREE.Vector3())
    unproject(0.2, 0, 0.5, 1, f.cameraRight).sub(centre).normalize()
    unproject(0, 0.2, 0.5, 1, f.cameraUp).sub(centre).normalize()
    f.fovRad = fovRad
    f.viewportHeightPx = viewportHeightPx
  }

  /** CPU milliseconds spent inside render(), last 300 frames — separate from total frame time. */
  layerRenderTimes(): number[] {
    return this.renderTimes.slice()
  }

  info(): { calls: number; triangles: number; programs: number } | null {
    if (!this.renderer) return null
    const { render, programs } = this.renderer.info
    return { calls: render.calls, triangles: render.triangles, programs: programs?.length ?? 0 }
  }

  dispose(): void {
    this.renderer?.dispose()
    this.renderer = null
  }
}
