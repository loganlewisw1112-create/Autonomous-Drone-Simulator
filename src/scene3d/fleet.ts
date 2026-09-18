/**
 * Draws the fleet. Airframes are AUTHORED as groups of named meshes (./airframes) and RENDERED as a
 * handful of InstancedMeshes, so draw calls do not grow with fleet size:
 *
 *   per airframe type   hull (1) + props (1) + gimbal (1)   < 300 m     full mesh, spinning props
 *                       decimated hull+props+gimbal (1)     300–1500 m  static props
 *   whole fleet         camera-facing sprite (1)            > 1500 m    2D fleet colour
 *
 * Two airframe types → at most 9 draw calls whether there are 6 aircraft or 60.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { FrameContext } from './SceneLayer'
import { buildTeal2 } from './airframes/teal2'
import { buildX10 } from './airframes/x10'
import type { AirframeId, AirframeModel, Detail, PartRole } from './airframes/parts'
import { glbOverrideUrl, loadGlbHull } from './airframes/glbOverride'

/** Aircraft are drawn larger than life: a 0.5 m quad is sub-pixel beyond ~60 m, and this is a
 *  tactical display. One constant, tuned in the aesthetic pass — nothing else assumes its value. */
export const AIRFRAME_VISUAL_SCALE = 6
export const LOD_FULL_MAX_M = 300
export const LOD_LOW_MAX_M = 1500
const SPRITE_DIAMETER_PX = 12
const BEACON_MIN_PX = 5
const BEACON_SIZE_M = 0.16 // true metres, before the visual scale
const STROBE_ON_SEC = 0.15 // 1 Hz anti-collision strobe, lit for this long each second
const RED = new THREE.Color('#ff2a1a')
const GREEN = new THREE.Color('#1aff5a')
const WHITE = new THREE.Color('#ffffff')
const MAX_AIRCRAFT = 64

export const AIRFRAME_BUILDERS: Record<AirframeId, (detail: Detail) => AirframeModel> = {
  teal2: buildTeal2,
  x10: buildX10,
}

export interface SceneDrone {
  id: string
  airframe: AirframeId
  lng: number
  lat: number
  /** Rendered elevation of the airframe origin, metres MSL (drawn ground + true AGL). */
  elevationM: number
  headingDeg: number
  speedMs: number
  /** Commanded rotor speed; 0 = stopped. */
  propRpm: number
  gimbalYawDeg: number
  gimbalPitchDeg: number
  /** 2D fleet colour, reused by the far sprite so the tactical read survives. */
  color: string
}

export interface FleetFrame {
  drones: SceneDrone[]
  /** SIM seconds — never wall clock — so prop phase and strobe replay identically. */
  simTimeSec: number
  /** Nav-light / strobe brightness, 0–1. Faint by day, full at night. Omit for none. */
  beaconGain?: number
}

interface Batch {
  hull: THREE.InstancedMesh
  props: THREE.InstancedMesh
  gimbal: THREE.InstancedMesh
  low: THREE.InstancedMesh
  hubs: Array<{ position: THREE.Vector3; direction: 1 | -1 }>
  pivot: THREE.Vector3
  /** Airframe-local lamp positions: port (red), starboard (green), dorsal strobe (white). */
  lamps: { port: THREE.Vector3; starboard: THREE.Vector3; strobe: THREE.Vector3 }
  /** True once a glTF hull replaced the procedural one: it has no rotor/gimbal parts to animate. */
  glb: boolean
  stats: { meshes: number; trianglesFull: number; trianglesLow: number; spanM: number }
}

/** Bake each mesh's transform and material colour into one geometry. */
function mergeRole(model: AirframeModel, roles: PartRole[]): THREE.BufferGeometry | null {
  const geometries: THREE.BufferGeometry[] = []
  const colour = new THREE.Color()
  model.group.updateMatrixWorld(true)
  model.group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh || !roles.includes(mesh.userData.role as PartRole)) return
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    g.deleteAttribute('uv')
    colour.copy((mesh.material as THREE.MeshStandardMaterial).color)
    const colours = new Float32Array(g.getAttribute('position').count * 3)
    for (let i = 0; i < colours.length; i += 3) colour.toArray(colours, i)
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3))
    geometries.push(g)
  })
  return geometries.length ? mergeGeometries(geometries) : null
}

function triangles(geometry: THREE.BufferGeometry | null): number {
  if (!geometry) return 0
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity)
  mesh.name = name
  mesh.count = 0
  mesh.visible = false
  mesh.frustumCulled = false // instances roam the whole AO; one bounding sphere cannot cover them
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

/** Soft round glow, baked into the texture: the bloom is in the sprite, there is no post pass. */
function glowTexture(): THREE.Texture {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2) / (size / 2)
      const v = Math.max(0, 1 - r)
      const glow = Math.min(1, v * v * 1.4 + (r < 0.18 ? 1 : 0))
      data.set([255, 255, 255, Math.round(glow * 255)], (y * size + x) * 4)
    }
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

/** The forward hub on one side (-1 port, +1 starboard), as a fresh vector. */
function frontHub(hubs: Batch['hubs'], side: 1 | -1): THREE.Vector3 {
  const candidates = hubs.filter((h) => Math.sign(h.position.x) === side)
  const front = candidates.reduce((best, h) => (h.position.y > best.position.y ? h : best), candidates[0])
  return front.position.clone()
}

function buildBatch(id: AirframeId, material: THREE.Material): Batch {
  const full = AIRFRAME_BUILDERS[id]('full')
  const low = AIRFRAME_BUILDERS[id]('low')

  const hubs: Batch['hubs'] = []
  const propGeometries: THREE.BufferGeometry[] = []
  let meshes = 0
  full.group.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    meshes++
    if (mesh.userData.role !== 'prop') return
    // Diagonal pairs counter-rotate, like the real thing.
    hubs.push({ position: mesh.position.clone(), direction: mesh.position.x * mesh.position.y > 0 ? 1 : -1 })
    if (propGeometries.length === 0) {
      // Every prop on an airframe is the same part: one template, one instance per hub.
      const template = mesh.geometry.clone()
      const colours = new Float32Array(template.getAttribute('position').count * 3)
      const c = (mesh.material as THREE.MeshStandardMaterial).color
      for (let i = 0; i < colours.length; i += 3) c.toArray(colours, i)
      template.setAttribute('color', new THREE.BufferAttribute(colours, 3))
      propGeometries.push(template)
    }
  })
  const propGeometry = propGeometries[0]
  const hullGeometry = mergeRole(full, ['body'])
  const gimbalGeometry = mergeRole(full, ['gimbal'])
  const lowGeometry = mergeRole(low, ['body', 'prop', 'gimbal'])
  if (!hullGeometry || !gimbalGeometry || !lowGeometry || !propGeometry) throw new Error(`airframe ${id} is missing a role`)

  const box = new THREE.Box3().setFromObject(full.group)
  const size = box.getSize(new THREE.Vector3())
  return {
    hull: instanced(hullGeometry, material, MAX_AIRCRAFT, `${id}-hull`),
    props: instanced(propGeometry, material, MAX_AIRCRAFT * hubs.length, `${id}-props`),
    gimbal: instanced(gimbalGeometry, material, MAX_AIRCRAFT, `${id}-gimbal`),
    low: instanced(lowGeometry, material, MAX_AIRCRAFT, `${id}-low`),
    hubs,
    pivot: full.gimbalPivot.clone(),
    lamps: {
      // Nav lights ride the front motor pods (outermost hub each side); the strobe sits on the spine.
      port: frontHub(hubs, -1).add(new THREE.Vector3(0, 0, -0.03)),
      starboard: frontHub(hubs, 1).add(new THREE.Vector3(0, 0, -0.03)),
      strobe: new THREE.Vector3(0, -0.06, box.max.z + 0.01),
    },
    glb: false,
    stats: {
      meshes,
      trianglesFull: triangles(hullGeometry) + triangles(gimbalGeometry) + triangles(propGeometry) * hubs.length,
      trianglesLow: triangles(lowGeometry),
      spanM: Math.max(size.x, size.y),
    },
  }
}

export class FleetRenderer {
  readonly root = new THREE.Group()
  private readonly batches: Record<AirframeId, Batch>
  private readonly sprites: THREE.InstancedMesh
  private readonly beacons: THREE.InstancedMesh
  private readonly lamp = new THREE.Vector3()
  private readonly bands = { full: 0, low: 0, sprite: 0 }

  // Scratch — this runs every frame; allocate nothing in update().
  private readonly base = new THREE.Matrix4()
  private readonly local = new THREE.Matrix4()
  private readonly spin = new THREE.Matrix4()
  private readonly out = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly attitude = new THREE.Euler(0, 0, 0, 'ZXY')
  private readonly quaternion = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3(AIRFRAME_VISUAL_SCALE, AIRFRAME_VISUAL_SCALE, AIRFRAME_VISUAL_SCALE)
  private readonly colour = new THREE.Color()
  private readonly spriteScale = new THREE.Vector3()

  constructor(private readonly place: (lng: number, lat: number, elevationM: number, target: THREE.Vector3) => THREE.Vector3) {
    this.root.name = 'fleet'
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.5 })
    this.batches = { teal2: buildBatch('teal2', material), x10: buildBatch('x10', material) }
    for (const batch of Object.values(this.batches)) this.root.add(batch.hull, batch.props, batch.gimbal, batch.low)

    this.sprites = instanced(new THREE.CircleGeometry(0.5, 16), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_AIRCRAFT, 'fleet-sprites')
    this.sprites.setColorAt(0, this.colour.set('#ffffff')) // allocates instanceColor
    this.sprites.castShadow = this.sprites.receiveShadow = false
    this.root.add(this.sprites)

    this.beacons = instanced(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }), MAX_AIRCRAFT * 3, 'fleet-beacons')
    this.beacons.castShadow = this.beacons.receiveShadow = false
    this.beacons.renderOrder = 10 // additive glow goes on after every opaque airframe
    this.beacons.setColorAt(0, this.colour.set('#ffffff'))
    this.root.add(this.beacons)

    for (const id of Object.keys(this.batches) as AirframeId[]) {
      const url = glbOverrideUrl(id)
      if (!url) continue
      void loadGlbHull(url).then((geometry) => {
        const batch = this.batches[id]
        batch.hull.geometry.dispose()
        batch.hull.geometry = geometry
        batch.glb = true
      })
    }
  }

  update(frame: FrameContext, { drones, simTimeSec, beaconGain = 0 }: FleetFrame): void {
    let beacons = 0
    // Offset half a second so a flash never straddles a whole-second boundary of the sim clock.
    const strobeOn = (((simTimeSec + 0.5) % 1) + 1) % 1 < STROBE_ON_SEC
    const counts: Record<AirframeId, { full: number; props: number; low: number }> = {
      teal2: { full: 0, props: 0, low: 0 },
      x10: { full: 0, props: 0, low: 0 },
    }
    let sprites = 0
    const metresPerPixelAtUnitDistance = (2 * Math.tan(frame.fovRad / 2)) / frame.viewportHeightPx

    for (const drone of drones.slice(0, MAX_AIRCRAFT)) {
      const batch = this.batches[drone.airframe]
      const count = counts[drone.airframe]
      this.place(drone.lng, drone.lat, drone.elevationM, this.position)
      const distance = this.position.distanceTo(frame.cameraPosition)

      if (distance > LOD_LOW_MAX_M) {
        const size = SPRITE_DIAMETER_PX * metresPerPixelAtUnitDistance * distance
        this.forward.crossVectors(frame.cameraRight, frame.cameraUp)
        this.out.makeBasis(frame.cameraRight, frame.cameraUp, this.forward).scale(this.spriteScale.set(size, size, size)).setPosition(this.position)
        this.sprites.setMatrixAt(sprites, this.out)
        this.sprites.setColorAt(sprites, this.colour.set(drone.color))
        sprites++
        continue
      }

      // Heading is clockwise from north; +Z rotation is counter-clockwise. Nose dips with speed.
      const noseDown = Math.min(drone.speedMs * 1.5, 20) * (Math.PI / 180)
      this.attitude.set(-noseDown, 0, -drone.headingDeg * (Math.PI / 180))
      this.base.compose(this.position, this.quaternion.setFromEuler(this.attitude), this.scale)

      if (beaconGain > 0) {
        const size = Math.max(BEACON_SIZE_M * AIRFRAME_VISUAL_SCALE, BEACON_MIN_PX * metresPerPixelAtUnitDistance * distance)
        this.forward.crossVectors(frame.cameraRight, frame.cameraUp)
        const lamps: Array<[THREE.Vector3, THREE.Color, number]> = [[batch.lamps.port, RED, 1], [batch.lamps.starboard, GREEN, 1]]
        if (strobeOn && drone.propRpm > 0) lamps.push([batch.lamps.strobe, WHITE, 2.4])
        for (const [local, colour, boost] of lamps) {
          this.lamp.copy(local).applyMatrix4(this.base)
          this.out.makeBasis(frame.cameraRight, frame.cameraUp, this.forward).scale(this.spriteScale.set(size * boost, size * boost, 1)).setPosition(this.lamp)
          this.beacons.setMatrixAt(beacons, this.out)
          this.beacons.setColorAt(beacons, this.colour.copy(colour).multiplyScalar(beaconGain))
          beacons++
        }
      }

      if (distance > LOD_FULL_MAX_M) {
        batch.low.setMatrixAt(count.low++, this.base)
        continue
      }

      batch.hull.setMatrixAt(count.full, this.base)

      this.attitude.set(drone.gimbalPitchDeg * (Math.PI / 180), 0, -drone.gimbalYawDeg * (Math.PI / 180))
      this.local.makeTranslation(batch.pivot.x, batch.pivot.y, batch.pivot.z)
        .multiply(this.spin.makeRotationFromEuler(this.attitude))
        .multiply(this.spin.makeTranslation(-batch.pivot.x, -batch.pivot.y, -batch.pivot.z))
      batch.gimbal.setMatrixAt(count.full, this.out.multiplyMatrices(this.base, this.local))
      count.full++

      const phase = (drone.propRpm / 60) * Math.PI * 2 * simTimeSec
      for (const hub of batch.hubs) {
        this.local.makeTranslation(hub.position.x, hub.position.y, hub.position.z)
          .multiply(this.spin.makeRotationZ(phase * hub.direction))
        batch.props.setMatrixAt(count.props++, this.out.multiplyMatrices(this.base, this.local))
      }
    }

    this.bands.full = 0
    this.bands.low = 0
    for (const id of Object.keys(this.batches) as AirframeId[]) {
      const batch = this.batches[id]
      const count = counts[id]
      this.commit(batch.hull, count.full)
      this.commit(batch.gimbal, batch.glb ? 0 : count.full)
      this.commit(batch.props, batch.glb ? 0 : count.props)
      this.commit(batch.low, count.low)
      this.bands.full += count.full
      this.bands.low += count.low
    }
    this.commit(this.sprites, sprites)
    this.commit(this.beacons, beacons)
    if (this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true
    if (this.sprites.instanceColor) this.sprites.instanceColor.needsUpdate = true
    this.bands.sprite = sprites
  }

  private commit(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count
    mesh.visible = count > 0 // a zero-instance mesh must not cost a draw call
    mesh.instanceMatrix.needsUpdate = true
  }

  stats(): { airframes: Record<AirframeId, Batch['stats']>; bands: { full: number; low: number; sprite: number } } {
    return {
      airframes: { teal2: this.batches.teal2.stats, x10: this.batches.x10.stats },
      bands: { ...this.bands },
    }
  }

  dispose(): void {
    for (const batch of Object.values(this.batches)) {
      for (const mesh of [batch.hull, batch.props, batch.gimbal, batch.low]) mesh.geometry.dispose()
    }
    this.sprites.geometry.dispose()
    this.beacons.geometry.dispose()
    ;(this.beacons.material as THREE.MeshBasicMaterial).map?.dispose()
  }
}
