/**
 * Optional real-asset path, wired but unused: drop `teal2.glb` / `x10.glb` into
 * `src/scene3d/airframes/models/` and that airframe's full-detail hull is replaced by the glTF. With no
 * file present the glob below compiles to `{}` — no request, no 404, and GLTFLoader is never fetched.
 * (A glTF hull has no named rotor/gimbal nodes, so props and gimbal stop animating for that type.)
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AirframeId } from './parts'

const found = import.meta.glob('./models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>

export function glbOverrideUrl(id: AirframeId): string | null {
  return found[`./models/${id}.glb`] ?? null
}

/** Flatten a glTF scene into one vertex-coloured geometry in the airframe-local frame. */
export async function loadGlbHull(url: string): Promise<THREE.BufferGeometry> {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
  const gltf = await new GLTFLoader().loadAsync(url)
  gltf.scene.rotateX(Math.PI / 2) // glTF is +Y up; airframes are +Z up
  gltf.scene.updateMatrixWorld(true)
  const geometries: THREE.BufferGeometry[] = []
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    if (!g.getAttribute('normal')) g.computeVertexNormals()
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
    const colours = new Float32Array(g.getAttribute('position').count * 3)
    for (let i = 0; i < colours.length; i += 3) (material.color ?? new THREE.Color('#888888')).toArray(colours, i)
    g.setAttribute('color', new THREE.BufferAttribute(colours, 3))
    geometries.push(g.index ? g.toNonIndexed() : g)
  })
  if (geometries.length === 0) throw new Error(`no meshes in ${url}`)
  return mergeGeometries(geometries)
}
