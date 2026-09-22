/**
 * Teal 2 — compact folding X-quad: short domed hull, four equal diagonal booms, two-blade props on
 * top of every motor, a small ball gimbal under the nose, and skid legs. Proportions are
 * representative, not surveyed; this is a training visual, not a CAD model.
 */
import * as THREE from 'three'
import { boom, finish, part, propeller, uprightCylinder, type AirframeModel, type Detail } from './parts'

export function buildTeal2(detail: Detail = 'full'): AirframeModel {
  const full = detail === 'full'
  const seg = full ? 16 : 7
  const hull = finish('#2f3a3d', 0.3, 0.6)
  const dark = finish('#15191b', 0.5, 0.45)
  const glass = finish('#0b1b26', 0.9, 0.12)
  const blade = finish('#1a1a1a', 0.1, 0.7)

  const group = new THREE.Group()
  group.name = 'teal2'

  group.add(part('fuselage', 'body', new THREE.BoxGeometry(0.11, 0.26, 0.06), hull))
  const canopy = new THREE.SphereGeometry(0.058, seg, Math.max(4, seg / 2), 0, Math.PI * 2, 0, Math.PI / 2)
  canopy.rotateX(Math.PI / 2)
  canopy.scale(1, 1.7, 0.75)
  group.add(part('canopy', 'body', canopy, hull, [0, 0.02, 0.03]))

  // X layout: every boom the same length, 45° off the nose.
  const reach = 0.2
  const motors: Array<[string, number, number]> = [
    ['fr', reach, reach], ['fl', -reach, reach], ['rr', reach, -reach], ['rl', -reach, -reach],
  ]
  for (const [tag, x, y] of motors) {
    group.add(boom(`arm-${tag}`, new THREE.Vector3(Math.sign(x) * 0.045, Math.sign(y) * 0.09, 0), new THREE.Vector3(x, y, 0.005), 0.022, 0.016, hull))
    group.add(part(`motor-${tag}`, 'body', uprightCylinder(0.021, 0.024, 0.032, seg), dark, [x, y, 0.022]))
    group.add(part(`prop-${tag}`, 'prop', propeller(2, 0.092, 0.017, detail), blade, [x, y, 0.044]))
  }

  const gimbalPivot = new THREE.Vector3(0, 0.125, -0.035)
  group.add(part('gimbal-yoke', 'gimbal', new THREE.BoxGeometry(0.05, 0.018, 0.04), dark, [0, 0.118, -0.03]))
  group.add(part('gimbal-ball', 'gimbal', new THREE.SphereGeometry(0.028, seg, Math.max(4, seg / 2)), glass, [0, 0.13, -0.045]))

  if (full) {
    for (const side of [-1, 1]) {
      group.add(part(`leg-${side}`, 'body', new THREE.BoxGeometry(0.012, 0.012, 0.085), dark, [side * 0.05, -0.07, -0.07], [0.22 * side, 0, 0.18 * side]))
      group.add(part(`skid-${side}`, 'body', new THREE.BoxGeometry(0.014, 0.16, 0.01), dark, [side * 0.06, -0.06, -0.113]))
    }
  }

  return { id: 'teal2', group, gimbalPivot }
}
