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
 * - Buildings use SEPARATE caster and receiver meshes. The old defect (Gate 3.4, two failed attempts)
 *   was one mesh that both cast and received: every roof found its own depth in the shadow map and sat
 *   in its own shadow (roof-centre luminance 155 → 83 with nothing else casting), hiding any aircraft
 *   shadow on it. Fixed here by splitting them — the CASTER is the walls plus a cap at the real roof
 *   height (invisible, depth-only, receives nothing); the RECEIVER is the roof plane lifted a clear
 *   ROOF_CLEARANCE_M above that cap, so it is always nearer the sun than any occluder and cannot shadow
 *   itself. Reproduce/verify with `setBuildingsEnabled(true)` + `npm run gate -- 3 --with-buildings`.
 * - Depth: receivers are drawn with depth test ON (a ridge still hides a shadow behind it) but lifted a
 *   little and polygon-offset toward the camera so the receiver wins against the surface it lies on.
 */
import * as THREE from 'three'
import type { FrameContext } from './SceneLayer'

const GRID_CELLS = 96
const REBUILD_MOVE_FRACTION = 0.25 // of the box radius
const REBUILD_RESIZE_RATIO = 1.3
const BOX_PADDING = 1.35 // the receiver outgrows the shadow box so small moves need no rebuild
const MAX_BUILDINGS = 1200
/** The receiver roof plane rides this far above the caster's cap. Because they are separate meshes, the
 *  receiver is always this much nearer the sun than any occluder at that footprint, so it never self-shadows.
 *  Comfortably above the shadow map's depth quantum even on a wide (hillside) shadow box. */
const ROOF_CLEARANCE_M = 1.5

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
  /** Walls + cap that CAST the building's shadow. Invisible (writes neither colour nor depth in the main
   *  pass); MapLibre draws the real building. Casts in the shadow pass via its own depth material. */
  private readonly casterMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
  private readonly terrain: THREE.Mesh
  private readonly roofs: THREE.Mesh
  private readonly casters: THREE.Mesh
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
    this.roofs = new THREE.Mesh(new THREE.BufferGeometry(), this.material)
    this.casters = new THREE.Mesh(new THREE.BufferGeometry(), this.casterMaterial)
    for (const mesh of [this.terrain, this.roofs]) {
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.renderOrder = 5 // after the opaque airframes, before the additive beacons
    }
    // Caster and receiver are SEPARATE meshes on purpose. A single mesh that both cast and received found
    // its own depth in the shadow map and sat in its own shadow — the old Gate 3.4 defect. The walls (+cap)
    // cast the building's shadow; the roof plane rides ROOF_CLEARANCE_M above the cap, casts nothing, and so
    // stays lit and shows the aircraft shadow that lands on it.
    this.casters.castShadow = true // buildings shade the ground and each other; the ground shades nothing
    this.casters.receiveShadow = false
    this.casters.frustumCulled = false
    this.root.add(this.terrain, this.roofs, this.casters)
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
    const roofVerts: number[] = [] // RECEIVER: roof planes, lifted above the cap, receive-only
    const castVerts: number[] = [] // CASTER: walls + cap at the real roof height, depth-only
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
      const cap = base + heightM // the caster's roof, at MapLibre's own roof height
      const roof = cap + ROOF_CLEARANCE_M // the receiver, a clear margin higher so it never self-shadows
      const floor = base - 10 // MapLibre drops walls 10 m below the centroid elevation to close gaps on slopes

      const flat = open.map(([lng, lat]) => { const p = this.deps.toScene(lng, lat, 0, this.scratch); return new THREE.Vector2(p.x, p.y) })
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(flat, [])) {
        // Receiver roof plane (aircraft shadows land here) …
        roofVerts.push(flat[a].x, flat[a].y, roof, flat[b].x, flat[b].y, roof, flat[c].x, flat[c].y, roof)
        // … and the caster's solid cap at the real roof height (so the building casts a filled shadow).
        castVerts.push(flat[a].x, flat[a].y, cap, flat[b].x, flat[b].y, cap, flat[c].x, flat[c].y, cap)
      }
      // Caster walls only (the receiver never casts, so it needs no walls).
      for (let i = 0; i < flat.length; i++) {
        const p = flat[i], q = flat[(i + 1) % flat.length]
        castVerts.push(p.x, p.y, floor, q.x, q.y, floor, q.x, q.y, cap, p.x, p.y, floor, q.x, q.y, cap, p.x, p.y, cap)
      }
      count++
    }
    this.roofs.geometry.dispose()
    const roofGeo = new THREE.BufferGeometry()
    roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roofVerts, 3))
    // Normals are stated, not computed: footprint rings come in either winding, computeVertexNormals()
    // would point half the roofs DOWN, and the shadow normal-bias would then sample from under the roof.
    const normals = new Float32Array(roofVerts.length)
    for (let i = 2; i < normals.length; i += 3) normals[i] = 1
    roofGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    this.roofs.geometry = roofGeo
    this.roofs.visible = count > 0

    this.casters.geometry.dispose()
    const castGeo = new THREE.BufferGeometry() // depth-only in the shadow pass: no normals needed
    castGeo.setAttribute('position', new THREE.Float32BufferAttribute(castVerts, 3))
    this.casters.geometry = castGeo
    this.casters.visible = count > 0
    this.stats.buildings = count
  }

  dispose(): void {
    this.terrain.geometry.dispose()
    this.roofs.geometry.dispose()
    this.casters.geometry.dispose()
    this.material.dispose()
    this.casterMaterial.dispose()
  }
}
