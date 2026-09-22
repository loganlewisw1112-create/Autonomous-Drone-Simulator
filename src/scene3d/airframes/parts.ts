/**
 * Shared vocabulary for the procedural airframes.
 *
 * Airframe-local frame matches scene ENU so a heading is a single rotation about Z:
 * `+Y` nose, `+X` right wing, `+Z` up. Units are TRUE metres; the fleet renderer applies the visual
 * scale. Every mesh carries a role so the renderer knows what spins, what gimbals, what is hull.
 */
import * as THREE from 'three'

export type AirframeId = 'teal2' | 'x10'
export type Detail = 'full' | 'low'
export type PartRole = 'body' | 'prop' | 'gimbal'

export interface AirframeModel {
  id: AirframeId
  group: THREE.Group
  /** Gimbal rotation centre, airframe-local. */
  gimbalPivot: THREE.Vector3
}

const materials = new Map<string, THREE.MeshStandardMaterial>()

/** One PBR material per colour/finish; no textures (Phase 2 owns the light they answer to). */
export function finish(color: string, metalness = 0.35, roughness = 0.55): THREE.MeshStandardMaterial {
  const key = `${color}|${metalness}|${roughness}`
  let material = materials.get(key)
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, metalness, roughness })
    materials.set(key, material)
  }
  return material
}

export function part(
  name: string,
  role: PartRole,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  mesh.userData.role = role
  mesh.position.set(...position)
  mesh.rotation.set(...rotation)
  return mesh
}

/** three's cylinder runs along Y; airframe verticals run along Z. */
export function uprightCylinder(radiusTop: number, radiusBottom: number, height: number, segments: number): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments)
  geometry.rotateX(Math.PI / 2)
  return geometry
}

/** A boom from the hull to a motor: a box stretched along the line between two points. */
export function boom(name: string, from: THREE.Vector3, to: THREE.Vector3, width: number, depth: number, material: THREE.Material): THREE.Mesh {
  const length = from.distanceTo(to)
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, length, depth), material)
  mesh.name = name
  mesh.userData.role = 'body' satisfies PartRole
  mesh.position.copy(from).add(to).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize())
  return mesh
}

/** N flat blades about a hub, in the XY plane, spinning about Z. */
export function propeller(blades: number, radius: number, chord: number, detail: Detail): THREE.BufferGeometry {
  const group: THREE.BufferGeometry[] = []
  for (let i = 0; i < blades; i++) {
    const blade = new THREE.BoxGeometry(chord, radius, 0.004)
    blade.translate(0, radius / 2, 0)
    blade.rotateZ((i / blades) * Math.PI * 2)
    group.push(blade)
  }
  group.push(uprightCylinder(chord * 0.7, chord * 0.7, 0.012, detail === 'full' ? 10 : 6))
  return mergeParts(group)
}

function mergeParts(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Primitive geometries share one layout (indexed position/normal/uv), so a flat concat is enough
  // here and keeps this file free of the examples/ import the renderer uses for the full merge.
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  let base = 0
  for (const g of geometries) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i))
      normals.push(n.getX(i), n.getY(i), n.getZ(i))
    }
    const index = g.getIndex()
    if (index) for (let i = 0; i < index.count; i++) indices.push(index.getX(i) + base)
    else for (let i = 0; i < p.count; i++) indices.push(i + base)
    base += p.count
    g.dispose()
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  merged.setIndex(indices)
  return merged
}
