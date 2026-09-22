/**
 * Sensor volumes — the 3D twins of four flat map layers. Each is fed the SAME data the 2D layer is
 * (the binding calls the app's own feature builders), so the two can never describe different things;
 * the binding hides the 2D layer while its twin here is on screen.
 *
 *   thermal footprint  ground-draped sector            replaces  ir-footprint-fill / -line
 *   gimbal FOV         translucent cone, aircraft → the footprint's arc on the ground
 *   GNSS uncertainty   ellipsoid at true altitude      replaces  gnss-uncertainty-fill / -ring
 *   trail              ribbon at the altitude flown    replaces  trail-<id>
 *
 * Geometry is rebuilt when the sim clock moves, not per frame. Nothing writes depth; everything
 * tests it, so terrain and buildings cut the volumes off where they meet them.
 */
import * as THREE from 'three'

const RADIAL_STEPS = 6 // footprint rings between apex and arc — enough to drape a 140 m sector over rough ground
const MAX_AIRCRAFT = 64
const TRAIL_WIDTH_M = 2.4
const FOOTPRINT_COLOUR = '#ff7a1a'

export interface VolumeFrame {
  /** SIM seconds; geometry is rebuilt only when this changes. */
  simTimeSec: number
  footprints: Array<{ id: string; apex: [number, number]; apexElevationM: number; arc: Array<[number, number]> }>
  uncertainties: Array<{ id: string; lng: number; lat: number; elevationM: number; radiusM: number; color: string }>
  trails: Array<{ id: string; color: string; points: Array<[number, number, number]> }>
  show: { footprints: boolean; uncertainty: boolean; trails: boolean }
}

interface Deps {
  toScene(lng: number, lat: number, elevationM: number, target: THREE.Vector3): THREE.Vector3
  groundAt(lng: number, lat: number): number
}

const translucent = (color: string, opacity: number, extra: THREE.MeshBasicMaterialParameters = {}) =>
  new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, ...extra })

function dynamicMesh(material: THREE.Material, name: string, order: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
  mesh.name = name
  mesh.frustumCulled = false
  mesh.renderOrder = order
  mesh.visible = false
  return mesh
}

export class SensorVolumes {
  readonly root = new THREE.Group()
  private readonly footprints = dynamicMesh(translucent(FOOTPRINT_COLOUR, 0.24, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 }), 'thermal-footprints', 6)
  private readonly cones = dynamicMesh(translucent(FOOTPRINT_COLOUR, 0.09), 'gimbal-cones', 7)
  private readonly trails = dynamicMesh(translucent('#ffffff', 0.65, { vertexColors: true }), 'trails', 6)
  private readonly ellipsoids: THREE.InstancedMesh
  private readonly p = new THREE.Vector3()
  private readonly q = new THREE.Vector3()
  private readonly matrix = new THREE.Matrix4()
  private readonly colour = new THREE.Color()
  /** What is on screen right now — the gate reads this to prove a 3D twin exists before a 2D layer is hidden. */
  readonly stats = { footprints: 0, ellipsoids: 0, trailSegments: 0 }
  private builtAt = NaN
  private builtShow = ''

  constructor(private readonly deps: Deps) {
    this.root.name = 'sensor-volumes'
    this.ellipsoids = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 14), translucent('#ffffff', 0.2), MAX_AIRCRAFT)
    this.ellipsoids.name = 'gnss-ellipsoids'
    this.ellipsoids.frustumCulled = false
    this.ellipsoids.renderOrder = 7
    this.ellipsoids.count = 0
    this.ellipsoids.setColorAt(0, this.colour.set('#ffffff'))
    this.root.add(this.footprints, this.cones, this.trails, this.ellipsoids)
  }

  update(frame: VolumeFrame | null): void {
    this.root.visible = frame !== null
    if (!frame) return
    const showKey = JSON.stringify(frame.show)
    if (frame.simTimeSec === this.builtAt && showKey === this.builtShow) return
    this.builtAt = frame.simTimeSec
    this.builtShow = showKey
    this.buildFootprints(frame)
    this.buildEllipsoids(frame)
    this.buildTrails(frame)
  }

  private buildFootprints({ footprints, show }: VolumeFrame): void {
    const ground: number[] = []
    const cone: number[] = []
    const lift = 0.6
    for (const f of show.footprints ? footprints : []) {
      // Drape: rings of points between the apex's ground point and the arc, each at the drawn ground.
      const rows: THREE.Vector3[][] = []
      for (let r = 0; r <= RADIAL_STEPS; r++) {
        const t = r / RADIAL_STEPS
        rows.push(f.arc.map(([lng, lat]) => {
          const x = f.apex[0] + (lng - f.apex[0]) * t
          const y = f.apex[1] + (lat - f.apex[1]) * t
          return this.deps.toScene(x, y, this.deps.groundAt(x, y) + lift, new THREE.Vector3())
        }))
      }
      for (let r = 0; r < RADIAL_STEPS; r++) {
        for (let i = 0; i < f.arc.length - 1; i++) {
          const a = rows[r][i], b = rows[r][i + 1], c = rows[r + 1][i], d = rows[r + 1][i + 1]
          ground.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z)
        }
      }
      // Cone: the aircraft itself down to the far edge of what it sees.
      const top = this.deps.toScene(f.apex[0], f.apex[1], f.apexElevationM, this.p)
      const rim = rows[RADIAL_STEPS]
      for (let i = 0; i < rim.length - 1; i++) cone.push(top.x, top.y, top.z, rim[i].x, rim[i].y, rim[i].z, rim[i + 1].x, rim[i + 1].y, rim[i + 1].z)
    }
    this.stats.footprints = show.footprints ? footprints.length : 0
    this.replace(this.footprints, ground)
    this.replace(this.cones, cone)
  }

  private buildEllipsoids({ uncertainties, show }: VolumeFrame): void {
    let n = 0
    for (const u of show.uncertainty ? uncertainties.slice(0, MAX_AIRCRAFT) : []) {
      this.deps.toScene(u.lng, u.lat, u.elevationM, this.p)
      // 1σ horizontal radius; GNSS vertical error runs about 1.5× the horizontal.
      this.matrix.makeScale(u.radiusM, u.radiusM, u.radiusM * 1.5).setPosition(this.p)
      this.ellipsoids.setMatrixAt(n, this.matrix)
      this.ellipsoids.setColorAt(n, this.colour.set(u.color))
      n++
    }
    this.stats.ellipsoids = n
    this.ellipsoids.count = n
    this.ellipsoids.visible = n > 0
    this.ellipsoids.instanceMatrix.needsUpdate = true
    if (this.ellipsoids.instanceColor) this.ellipsoids.instanceColor.needsUpdate = true
  }

  private buildTrails({ trails, show }: VolumeFrame): void {
    const positions: number[] = []
    const colours: number[] = []
    for (const trail of show.trails ? trails : []) {
      if (trail.points.length < 2) continue
      this.colour.set(trail.color)
      const pts = trail.points.map(([lng, lat, elevationM]) => this.deps.toScene(lng, lat, elevationM, new THREE.Vector3()))
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1]
        // Ribbon lies flat: widen each segment across its own horizontal direction.
        this.q.set(-(b.y - a.y), b.x - a.x, 0)
        if (this.q.lengthSq() < 1e-6) continue
        this.q.normalize().multiplyScalar(TRAIL_WIDTH_M / 2)
        const quad = [a.x - this.q.x, a.y - this.q.y, a.z, a.x + this.q.x, a.y + this.q.y, a.z, b.x - this.q.x, b.y - this.q.y, b.z,
          b.x - this.q.x, b.y - this.q.y, b.z, a.x + this.q.x, a.y + this.q.y, a.z, b.x + this.q.x, b.y + this.q.y, b.z]
        positions.push(...quad)
        for (let k = 0; k < 6; k++) colours.push(this.colour.r, this.colour.g, this.colour.b)
      }
    }
    this.stats.trailSegments = positions.length / 18
    this.replace(this.trails, positions, colours)
  }

  private replace(mesh: THREE.Mesh, positions: number[], colours?: number[]): void {
    mesh.geometry.dispose()
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    if (colours) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3))
    mesh.geometry = geometry
    mesh.visible = positions.length > 0
  }

  dispose(): void {
    for (const mesh of [this.footprints, this.cones, this.trails, this.ellipsoids]) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  }
}
