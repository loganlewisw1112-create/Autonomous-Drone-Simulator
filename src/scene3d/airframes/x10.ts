/**
 * Skydio X10 — a different machine, not a bigger Teal: long slab hull over a deep battery, a large
 * forward sensor turret that leads the nose, swept booms of UNEQUAL reach (wide shallow front pair,
 * narrow raked rear pair), rear motors slung UNDER their booms, three-blade props, twin dorsal
 * antenna fins, no landing legs. Proportions are representative, not surveyed.
 */
import * as THREE from 'three'
import { boom, finish, part, propeller, uprightCylinder, type AirframeModel, type Detail } from './parts'

export function buildX10(detail: Detail = 'full'): AirframeModel {
  const full = detail === 'full'
  const seg = full ? 18 : 7
  const hull = finish('#1d2126', 0.45, 0.4)
  const battery = finish('#2a2f36', 0.25, 0.65)
  const dark = finish('#0e1013', 0.55, 0.4)
  const glass = finish('#07141f', 0.95, 0.08)
  const blade = finish('#202020', 0.1, 0.7)

  const group = new THREE.Group()
  group.name = 'x10'

  group.add(part('fuselage', 'body', new THREE.BoxGeometry(0.13, 0.42, 0.075), hull))
  group.add(part('battery', 'body', new THREE.BoxGeometry(0.115, 0.27, 0.06), battery, [0, -0.05, -0.066]))

  // [tag, x, y, z of the prop plane, motor above(+1) / below(-1) the boom]
  const motors: Array<[string, number, number, number]> = [
    ['fr', 0.33, 0.17, 1], ['fl', -0.33, 0.17, 1],
    ['rr', 0.2, -0.34, -1], ['rl', -0.2, -0.34, -1],
  ]
  for (const [tag, x, y, up] of motors) {
    const root = new THREE.Vector3(Math.sign(x) * 0.06, y > 0 ? 0.13 : -0.17, 0.01 * up)
    const tip = new THREE.Vector3(x, y, 0.02 * up)
    group.add(boom(`arm-${tag}`, root, tip, 0.03, 0.02, hull))
    group.add(part(`motor-${tag}`, 'body', uprightCylinder(0.03, 0.03, 0.04, seg), dark, [x, y, 0.02 * up + 0.028 * up]))
    group.add(part(`prop-${tag}`, 'prop', propeller(3, 0.135, 0.024, detail), blade, [x, y, 0.02 * up + 0.056 * up]))
  }

  // Sensor turret leads the nose: the X10's defining silhouette feature.
  const gimbalPivot = new THREE.Vector3(0, 0.255, -0.01)
  const collar = new THREE.CylinderGeometry(0.05, 0.058, 0.05, seg)
  group.add(part('turret-collar', 'gimbal', collar, dark, [0, 0.225, -0.01]))
  group.add(part('turret', 'gimbal', new THREE.SphereGeometry(0.066, seg, Math.max(4, seg / 2)), glass, [0, 0.275, -0.012]))

  if (full) {
    for (const side of [-1, 1]) {
      group.add(part(`fin-${side}`, 'body', new THREE.BoxGeometry(0.006, 0.07, 0.085), dark, [side * 0.04, -0.15, 0.078], [-0.25, 0, 0]))
      group.add(part(`nav-cam-${side}`, 'body', new THREE.SphereGeometry(0.016, 8, 6), glass, [side * 0.045, 0.16, 0.04]))
    }
  }

  return { id: 'x10', group, gimbalPivot }
}
