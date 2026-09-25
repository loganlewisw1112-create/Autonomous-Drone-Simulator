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
const MAX_PENDING_GPU_QUERIES = 4

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
  /** The point the camera looks at: map centre at its elevation. Shadows are fitted around it. */
  focus: THREE.Vector3
  fovRad: number
  viewportHeightPx: number
  /** World → clip for this frame (the matrix three renders with). */
  mvp: THREE.Matrix4
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
    focus: new THREE.Vector3(),
    fovRad: 0.6435,
    viewportHeightPx: 1,
    mvp: this.camera.projectionMatrix,
  }
  /** Called inside render(), after the camera is solved and before three draws. */
  onBeforeRender: ((frame: FrameContext, renderer: THREE.WebGLRenderer) => void) | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private map: maplibregl.Map | null = null
  private originX = 0
  private originY = 0
  private metresToMercator = 1
  private viewportW = 0
  private viewportH = 0
  // GPU cost of the layer's own draw. performance.now() around render() only sees the CPU issuing commands;
  // the GPU runs them later, so a weak GPU could be over budget while the CPU timing looks fine. A WebGL2
  // timer query brackets the same work; results arrive a frame or two later. Absent the extension (Firefox,
  // some drivers) this stays empty and the governor keeps using CPU time alone.
  private gl2: WebGL2RenderingContext | null = null
  private timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null
  private readonly pendingQueries: WebGLQuery[] = []
  private readonly gpuTimes: number[] = []

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

  /** Scene-space x/y → lng/lat (the exact inverse of toScene). */
  fromScene(x: number, y: number): { lng: number; lat: number } {
    const ll = new MercatorCoordinate(this.originX + x * this.metresToMercator, this.originY - y * this.metresToMercator, 0).toLngLat()
    return { lng: ll.lng, lat: ll.lat }
  }

  /** Scene position → CSS pixels in the map container, using the matrix of the last drawn frame. `null` behind the camera. */
  project(lng: number, lat: number, elevationM: number): { x: number; y: number } | null {
    const canvas = this.map?.getCanvas()
    if (!canvas) return null
    const p = this.toScene(lng, lat, elevationM)
    const v = this.probe.set(p.x, p.y, p.z, 1).applyMatrix4(this.camera.projectionMatrix)
    if (v.w <= 0) return null
    return { x: ((v.x / v.w + 1) / 2) * canvas.clientWidth, y: ((1 - v.y / v.w) / 2) * canvas.clientHeight }
  }

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })
      this.renderer.autoClear = false
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    }
    if (!this.timerExt && typeof (gl as WebGL2RenderingContext).createQuery === 'function') {
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null
      if (ext) {
        this.gl2 = gl as WebGL2RenderingContext
        this.timerExt = ext
      }
    }
  }

  onRemove(): void {
    this.map = null
  }

  /** Harvest finished GPU timer queries, oldest first. A disjoint event (clock change, context loss) voids them. */
  private collectGpuTimes(): void {
    const gl = this.gl2
    const ext = this.timerExt
    if (!gl || !ext) return
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    while (this.pendingQueries.length > 0) {
      const query = this.pendingQueries[0]
      if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break
      if (!disjoint) {
        this.gpuTimes.push((gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6)
        if (this.gpuTimes.length > RENDER_TIME_BUFFER) this.gpuTimes.shift()
      }
      gl.deleteQuery(query)
      this.pendingQueries.shift()
    }
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: maplibregl.CustomRenderMethodInput): void {
    this.renderer?.resetState() // MUST stay first: three's state cache is stale after MapLibre drew.
    const renderer = this.renderer
    const map = this.map
    if (!renderer || !map) return
    const started = performance.now()
    this.collectGpuTimes()
    // At most a few frames in flight; if results stop arriving, stop issuing rather than pile up queries.
    const query = this.gl2 && this.timerExt && this.pendingQueries.length < MAX_PENDING_GPU_QUERIES ? this.gl2.createQuery() : null
    if (query) this.gl2!.beginQuery(this.timerExt!.TIME_ELAPSED_EXT, query)

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
      const centre = map.getCenter()
      this.toScene(centre.lng, centre.lat, map.getCenterElevation(), this.frame.focus)
      this.onBeforeRender(this.frame, renderer)
    }
    renderer.render(this.scene, this.camera)
    if (query) {
      this.gl2!.endQuery(this.timerExt!.TIME_ELAPSED_EXT)
      this.pendingQueries.push(query)
    }

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

  /** GPU milliseconds for the same work, last 300 measured frames; empty where timer queries are unavailable. */
  layerGpuTimes(): number[] {
    return this.gpuTimes.slice()
  }

  /** The latest GPU sample, or undefined — cheap enough to read every frame, unlike the copies above. */
  latestGpuMs(): number | undefined {
    return this.gpuTimes[this.gpuTimes.length - 1]
  }

  info(): { calls: number; triangles: number; programs: number } | null {
    if (!this.renderer) return null
    const { render, programs } = this.renderer.info
    return { calls: render.calls, triangles: render.triangles, programs: programs?.length ?? 0 }
  }

  dispose(): void {
    for (const query of this.pendingQueries) this.gl2?.deleteQuery(query)
    this.pendingQueries.length = 0
    this.renderer?.dispose()
    this.renderer = null
  }
}
