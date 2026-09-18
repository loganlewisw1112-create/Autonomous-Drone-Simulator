/**
 * Invisible shadow receivers. MapLibre draws the terrain and the buildings, so their meshes are not
 * in three's scene and cannot receive three's shadows. These stand-ins can: a heightfield and
 * extruded footprints with `ShadowMaterial` — transparent except where shadowed — laid exactly over
 * what MapLibre drew, so the shadow composites onto the map.
 *
 * - They cover the SHADOW BOX only (what the camera is looking at), and are rebuilt on camera
 *   moves with hysteresis, never per frame.
 * - Terrain heights come from terrainModel (the drawn ground), so receiver, aircraft and map agree.
 * - Buildings follow MapLibre's own rule (fill_extrusion vertex shader): the whole building rides
 *   at the terrain elevation of its CENTROID; roof = that + height.
 * - BUILDING STAND-INS ARE OFF BY DEFAULT — KNOWN DEFECT (Gate 3.4, two remediation attempts, fallback
 *   taken per plan). With them on, every roof stand-in is uniformly in its own shadow (roof-centre
 *   luminance 155 → 83 with nothing else casting), which hides any aircraft shadow on it. Ruled out:
 *   depth burial (MapLibre buildings are verified to share depth), a too-small roof lift, and
 *   down-pointing normals. Untested suspects: double-sided casters writing the roof's own depth,
 *   overlapping Overture parts. `setBuildingsEnabled(true)` + `npm run gate -- 3 --with-buildings`
 *   reproduces it. Until fixed, an aircraft shadow crossing a building is drawn on the ground beneath
 *   it and is correctly hidden by the building.
 * - Depth: drawn with depth test ON (a ridge still hides a shadow behind it) but lifted a little and
 *   polygon-offset toward the camera so the receiver wins against the surface it lies on.
 */
import * as THREE from 'three'
import type { FrameContext } from './SceneLayer'

const GRID_CELLS = 96
const REBUILD_MOVE_FRACTION = 0.25 // of the box radius
const REBUILD_RESIZE_RATIO = 1.3
const BOX_PADDING = 1.35 // the receiver outgrows the shadow box so small moves need no rebuild
const MAX_BUILDINGS = 1200
/** MapLibre seats each building at the terrain elevation of ITS centroid (per tile part); ours can
 *  differ by decimetres on a hillside. The roof stand-in rides this far above so it is never the one hidden. */
const ROOF_LIFT_M = 0.8

export interface BuildingFootprint {
  /** Outer ring, [lng, lat] pairs. */
  ring: Array<[number, number]>
  heightM: number
}

export interface ReceiverStats {
  rebuilds: number
  rebuildMsTotal: number
  lastRebuildMs: number
  terrainVertices: number
  buildings: number
}

interface Deps {
  toScene(lng: number, lat: number, elevationM: number, target: THREE.Vector3): THREE.Vector3
  fromScene(x: number, y: number): { lng: number; lat: number }
  groundAt(lng: number, lat: number): number
  buildings(): BuildingFootprint[]
}

export class ShadowReceivers {
  readonly root = new THREE.Group()
  readonly stats: ReceiverStats = { rebuilds: 0, rebuildMsTotal: 0, lastRebuildMs: 0, terrainVertices: (GRID_CELLS + 1) ** 2, buildings: 0 }

  private readonly material = new THREE.ShadowMaterial({
    opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
  })
  private readonly terrain: THREE.Mesh
  private readonly structures: THREE.Mesh
  private readonly centre = new THREE.Vector2(Infinity, Infinity)
  private readonly scratch = new THREE.Vector3()
  private builtRadius = 0
  private builtRelief: boolean | null = null
  private buildingsEnabled = false

  constructor(private readonly deps: Deps) {
    this.root.name = 'shadow-receivers'
    const n = GRID_CELLS + 1
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * n * 3), 3))
    const normals = new Float32Array(n * n * 3)
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    const index: number[] = []
    for (let r = 0; r < GRID_CELLS; r++) {
      for (let c = 0; c < GRID_CELLS; c++) {
        const a = r * n + c
        index.push(a, a + 1, a + n, a + 1, a + n + 1, a + n)
      }
    }
    geometry.setIndex(index)
    this.terrain = new THREE.Mesh(geometry, this.material)
    this.structures = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    for (const mesh of [this.terrain, this.structures]) {
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.renderOrder = 5 // after the opaque airframes, before the additive beacons
    }
    this.structures.castShadow = true // buildings shade the ground; the ground shades nothing
    this.root.add(this.terrain, this.structures)
  }

  setBuildingsEnabled(on: boolean): void {
    this.buildingsEnabled = on
    this.centre.set(Infinity, Infinity) // force a rebuild on the next frame
  }

  /** `shadowRadius` is the lighting rig's view-fitted shadow box; `reliefLive` flips when the map starts/stops drawing relief. */
  update(frame: FrameContext, shadowRadius: number, shadowStrength: number, reliefLive: boolean): void {
    this.material.opacity = 0.5 * shadowStrength
    this.root.visible = shadowStrength > 0.01
    if (!this.root.visible) return

    const moved = Math.hypot(frame.focus.x - this.centre.x, frame.focus.y - this.centre.y)
    const resized = Math.max(shadowRadius / this.builtRadius, this.builtRadius / shadowRadius)
    if (moved < this.builtRadius * REBUILD_MOVE_FRACTION && resized < REBUILD_RESIZE_RATIO && reliefLive === this.builtRelief) return

    const started = performance.now()
    this.rebuild(frame.focus, shadowRadius * BOX_PADDING)
    this.builtRelief = reliefLive
    this.stats.lastRebuildMs = performance.now() - started
    this.stats.rebuildMsTotal += this.stats.lastRebuildMs
    this.stats.rebuilds++
  }

  private rebuild(focus: THREE.Vector3, radius: number): void {
    const cell = (2 * radius) / GRID_CELLS
    // Snap the grid to its own cell size so vertices keep their world positions between rebuilds
    // and a shadow does not swim as the camera pans.
    const cx = Math.round(focus.x / cell) * cell
    const cy = Math.round(focus.y / cell) * cell
    this.centre.set(cx, cy)
    this.builtRadius = radius / BOX_PADDING
    const lift = Math.max(0.35, cell * 0.06) // coarser grid → more slack against the surface under it

    const positions = this.terrain.geometry.getAttribute('position') as THREE.BufferAttribute
    const n = GRID_CELLS + 1
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = cx - radius + c * cell
        const y = cy - radius + r * cell
        const { lng, lat } = this.deps.fromScene(x, y)
        positions.setXYZ(r * n + c, x, y, this.deps.groundAt(lng, lat) + lift)
      }
    }
    positions.needsUpdate = true

    this.rebuildStructures(cx, cy, radius)
  }

  private rebuildStructures(cx: number, cy: number, radius: number): void {
    const vertices: number[] = []
    let count = 0
    for (const { ring, heightM } of this.buildingsEnabled ? this.deps.buildings() : []) {
      if (count >= MAX_BUILDINGS) break
      const first = this.deps.toScene(ring[0][0], ring[0][1], 0, this.scratch)
      if (Math.abs(first.x - cx) > radius || Math.abs(first.y - cy) > radius) continue

      const open = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring
      if (open.length < 3) continue
      let lngSum = 0, latSum = 0
      for (const [lng, lat] of open) { lngSum += lng; latSum += lat }
      const base = this.deps.groundAt(lngSum / open.length, latSum / open.length)
      const roof = base + heightM + ROOF_LIFT_M
      const floor = base - 10 // MapLibre drops walls 10 m below the centroid elevation to close gaps on slopes

      const flat = open.map(([lng, lat]) => { const p = this.deps.toScene(lng, lat, 0, this.scratch); return new THREE.Vector2(p.x, p.y) })
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(flat, [])) {
        vertices.push(flat[a].x, flat[a].y, roof, flat[b].x, flat[b].y, roof, flat[c].x, flat[c].y, roof)
      }
      for (let i = 0; i < flat.length; i++) {
        const p = flat[i], q = flat[(i + 1) % flat.length]
        vertices.push(p.x, p.y, floor, q.x, q.y, floor, q.x, q.y, roof, p.x, p.y, floor, q.x, q.y, roof, p.x, p.y, roof)
      }
      count++
    }
    this.structures.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    // Normals are stated, not computed: footprint rings come in either winding, computeVertexNormals()
    // would point half the roofs DOWN, and the shadow normal-bias would then sample from under the roof —
    // every roof permanently in its own shadow. "Up" is right for roofs and harmless for walls.
    const normals = new Float32Array(vertices.length)
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    this.structures.geometry = geometry
    this.structures.visible = count > 0
    this.stats.buildings = count
  }

  dispose(): void {
    this.terrain.geometry.dispose()
    this.structures.geometry.dispose()
    this.material.dispose()
  }
}
