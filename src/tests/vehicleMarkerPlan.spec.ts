import { describe, expect, it } from 'vitest'
import {
  groundWalkFeatures,
  planVehicles,
  recoveryWalkFeatures,
  remainingRouteFeatures,
  unitContactPosition,
  walkSecondsTotal,
  type PlanInput,
} from '@/components/vehicleMarkerPlan'
import { markerSizePx, VEHICLE_ASPECT, VEHICLE_LENGTH_M, type RouteLike } from '@/components/vehicleAvatars'
import type { GroundUnitState, RecoveryTeamState } from '@/types'

const LAT0 = 37.77
const M_PER_DEG_LAT = 111_320

function gridRoute(
  metres: ReadonlyArray<readonly [number, number]>,
  hiddenRanges?: Array<[number, number]>,
): RouteLike {
  const points = metres.map(([x, y]) => ({
    lat: LAT0 + y / M_PER_DEG_LAT,
    lng: -122.4 + x / (M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180)),
  }))
  const cumDistM: number[] = [0]
  for (let i = 1; i < metres.length; i += 1) {
    cumDistM.push(cumDistM[i - 1] + Math.hypot(metres[i][0] - metres[i - 1][0], metres[i][1] - metres[i - 1][1]))
  }
  return { points, cumDistM, hiddenRanges }
}

// 0,0 -> 100 m north -> 100 m east -> 50 m north: 250 m, a tunnel from 120 to 160 m.
const ROUTE = gridRoute([[0, 0], [0, 100], [100, 100], [100, 150]], [[120, 160]])

function unit(over: Partial<GroundUnitState> & { id: string }): GroundUnitState {
  return {
    role: 'intervention',
    position: { lat: LAT0, lng: -122.4 },
    status: 'enroute',
    targetThermalId: 'hs1',
    routeDistM: 0,
    ...over,
  }
}

function team(over: Partial<RecoveryTeamState> & { id: string }): RecoveryTeamState {
  return {
    droneId: 'uav-01',
    position: { lat: LAT0, lng: -122.4 },
    targetPosition: { lat: LAT0 + 0.002, lng: -122.4 },
    status: 'enroute',
    etaSec: 30,
    routePoints: [],
    routeDistM: 0,
    roadRouted: true,
    ...over,
  }
}

function input(over: Partial<PlanInput>): PlanInput {
  return {
    groundUnits: [],
    recoveryTeams: [],
    zoom: 16,
    centerLat: LAT0,
    unitRoute: () => ROUTE,
    teamRoute: () => ROUTE,
    ...over,
  }
}

describe('planVehicles: ground units', () => {
  it('places each unit at the point routeDistM along its route, with no lerp', () => {
    const [p] = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 100 })] }))
    expect(p.lat).toBeCloseTo(ROUTE.points[1].lat, 9)
    expect(p.lng).toBeCloseTo(ROUTE.points[1].lng, 9)
    const [q] = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 150 })] }))
    expect(q.lng).toBeGreaterThan(p.lng)
    expect(q.lat).toBeCloseTo(p.lat, 9)
  })

  it('skips standby units and alternates truck/suv for units converging on one contact', () => {
    const plans = planVehicles(input({
      groundUnits: [unit({ id: 'a' }), unit({ id: 'b' }), unit({ id: 'c', status: 'standby' })],
    }))
    expect(plans.map((p) => p.id)).toEqual(['a', 'b'])
    expect(plans[0].variant).toBe('truck')
    expect(plans[1].variant).toBe('suv')
  })

  it('uses unit.headingDeg when present and the route bearing otherwise', () => {
    const [withHeading] = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 40, headingDeg: 123.4 })] }))
    expect(withHeading.headingDeg).toBe(123.4)
    const [fromRoute] = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 40 })] }))
    expect(fromRoute.headingDeg).toBeCloseTo(0, 1)   // heading north up the first leg
    const [east] = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 150 })] }))
    expect(east.headingDeg).toBeCloseTo(90, 1)
  })

  it('hides a unit strictly inside a hidden range but not at the portal', () => {
    const inside = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 140 })] }))[0]
    expect(inside.hidden).toBe(true)
    const portal = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 120 })] }))[0]
    expect(portal.hidden).toBe(false)
    const clear = planVehicles(input({ groundUnits: [unit({ id: 'g1', routeDistM: 50 })] }))[0]
    expect(clear.hidden).toBe(false)
  })

  it('falls back to the stored position and heading 0 when there is no route', () => {
    const [p] = planVehicles(input({
      groundUnits: [unit({ id: 'g1', position: { lat: 37.9, lng: -122.1 } })],
      unitRoute: () => null,
    }))
    expect(p.lat).toBe(37.9)
    expect(p.lng).toBe(-122.1)
    expect(p.headingDeg).toBe(0)
    expect(p.hidden).toBe(false)
  })

  it('sizes from the map centre latitude, per variant', () => {
    const [p] = planVehicles(input({ groundUnits: [unit({ id: 'g1' })], zoom: 19 }))
    const expected = markerSizePx(19, LAT0, VEHICLE_LENGTH_M.truck, VEHICLE_ASPECT.truck)
    expect(p.lengthPx).toBeCloseTo(expected.lengthPx, 6)
    expect(p.widthPx).toBeCloseTo(expected.widthPx, 6)
    expect(planVehicles(input({ groundUnits: [unit({ id: 'g1' })], zoom: 14 }))[0].lengthPx).toBe(36)
  })

  it('builds the popup model: ETA while driving, crew on foot once parked far from the contact', () => {
    const [driving] = planVehicles(input({ groundUnits: [unit({ id: 'g1', etaSec: 42, accessGapM: 80 })] }))
    expect(driving.popup.status).toBe('enroute')
    expect(driving.popup.etaSec).toBe(42)
    expect(driving.popup.crewOnFootM).toBeUndefined()
    const [parked] = planVehicles(input({ groundUnits: [unit({ id: 'g1', status: 'on_scene', routeDistM: 250, accessGapM: 80 })] }))
    expect(parked.popup.crewOnFootM).toBe(80)
    const [close] = planVehicles(input({ groundUnits: [unit({ id: 'g1', status: 'on_scene', routeDistM: 250, accessGapM: 10 })] }))
    expect(close.popup.crewOnFootM).toBeUndefined()
  })
})

describe('planVehicles: recovery teams', () => {
  it('draws a pickup with a chip offset only while a road-routed team is enroute or on scene', () => {
    const enroute = planVehicles(input({ recoveryTeams: [team({ id: 'r1' })] }))
    expect(enroute).toHaveLength(1)
    expect(enroute[0].kind).toBe('recovery')
    expect(enroute[0].variant).toBe('pickup')
    expect(enroute[0].chipOffset).toEqual([0, -(enroute[0].lengthPx / 2 + 10)])
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', status: 'on_scene' })] }))).toHaveLength(1)
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', status: 'extracted' })] }))).toHaveLength(0)
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', status: 'dispatched' })] }))).toHaveLength(0)
  })

  it('draws nothing for a team without road access, and nothing when its route is missing', () => {
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', roadRouted: false })] }))).toHaveLength(0)
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', roadRouted: undefined })] }))).toHaveLength(0)
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1' })], teamRoute: () => null }))).toHaveLength(0)
  })

  it('does not consume a variant slot: ground units keep alternating around a team', () => {
    const plans = planVehicles(input({
      groundUnits: [unit({ id: 'a' }), unit({ id: 'b' })],
      recoveryTeams: [team({ id: 'r1' })],
    }))
    expect(plans.filter((p) => p.kind === 'ground').map((p) => p.variant)).toEqual(['truck', 'suv'])
    expect(plans.find((p) => p.kind === 'recovery')!.variant).toBe('pickup')
  })

  it('hides over a tunnel and carries the walk-in countdown on scene', () => {
    expect(planVehicles(input({ recoveryTeams: [team({ id: 'r1', routeDistM: 140 })] }))[0].hidden).toBe(true)
    const [parked] = planVehicles(input({
      recoveryTeams: [team({ id: 'r1', status: 'on_scene', routeDistM: 250, accessGapM: 60, etaSec: 33.2 })],
    }))
    expect(parked.popup.title).toBe('DRONE RECOVERY TEAM')
    expect(parked.popup.crewOnFootM).toBe(60)
    expect(parked.popup.walkSecLeft).toBe(33.2)
  })
})

describe('remainingRouteFeatures', () => {
  it('returns the dashed remaining route split at tunnel spans, from the unit forwards', () => {
    const features = remainingRouteFeatures(ROUTE, 50, 'g1')
    expect(features.map((f) => f.properties.covered)).toEqual([false, true, false])
    expect(features.every((f) => f.properties.id === 'g1')).toBe(true)
    // First span starts at 50 m north and ends at the tunnel portal (120 m); last ends at the route end.
    const first = features[0].geometry.coordinates
    expect(first[0][1]).toBeCloseTo(LAT0 + 50 / M_PER_DEG_LAT, 9)
    const last = features[2].geometry.coordinates
    expect(last[last.length - 1][1]).toBeCloseTo(ROUTE.points[3].lat, 9)
    // Spans join end to start.
    expect(features[0].geometry.coordinates.at(-1)).toEqual(features[1].geometry.coordinates[0])
  })

  it('has no hidden spans on a plain route, nothing at the end, and starts from 0 for a negative s', () => {
    const plain = gridRoute([[0, 0], [0, 100], [100, 100]])
    expect(remainingRouteFeatures(plain, 0, 'x')).toHaveLength(1)
    expect(remainingRouteFeatures(plain, 0, 'x')[0].properties.covered).toBe(false)
    expect(remainingRouteFeatures(plain, 200, 'x')).toHaveLength(0)
    expect(remainingRouteFeatures(plain, 500, 'x')).toHaveLength(0)
    expect(remainingRouteFeatures(plain, -20, 'x')[0].geometry.coordinates[0][1]).toBeCloseTo(LAT0, 9)
  })

  it('keeps every vertex that lies ahead of the unit', () => {
    const plain = gridRoute([[0, 0], [0, 100], [100, 100], [100, 150]])
    const coords = remainingRouteFeatures(plain, 30, 'x')[0].geometry.coordinates
    expect(coords).toHaveLength(1 + 3)   // start point + 3 later vertices
  })
})

describe('walk lines', () => {
  const contact = { lat: LAT0 + 0.0009, lng: -122.4 + 0.0004 }

  it('draws the ground crew-on-foot line only for a parked unit more than 15 m from its contact', () => {
    const route = ROUTE
    const end = route.points[3]
    const parked = unit({ id: 'g1', status: 'on_scene', routeDistM: 250, accessGapM: 80, position: end })
    const f = groundWalkFeatures([parked], () => contact)
    expect(f).toHaveLength(1)
    expect(f[0].geometry.coordinates).toEqual([[end.lng, end.lat], [contact.lng, contact.lat]])
    expect(groundWalkFeatures([{ ...parked, accessGapM: 15 }], () => contact)).toHaveLength(0)
    expect(groundWalkFeatures([{ ...parked, status: 'enroute' }], () => contact)).toHaveLength(0)
    expect(groundWalkFeatures([parked], () => null)).toHaveLength(0)
  })

  it('shrinks the recovery walk-in line toward the aircraft as the countdown runs down', () => {
    const access = ROUTE.points[3]
    const aircraft = { lat: access.lat + 0.001, lng: access.lng }
    const base = team({ id: 'r1', status: 'on_scene', routeDistM: 250, accessGapM: 100, targetPosition: aircraft })
    const total = 100 / 1.3   // seconds at the baseline pace
    const full = recoveryWalkFeatures([{ ...base, etaSec: total }], () => access, 1)
    expect(full[0].geometry.coordinates[0][1]).toBeCloseTo(access.lat, 6)
    const half = recoveryWalkFeatures([{ ...base, etaSec: total / 2 }], () => access, 1)
    expect(half[0].geometry.coordinates[0][1]).toBeCloseTo(access.lat + 0.0005, 5)
    expect(half[0].geometry.coordinates[1]).toEqual([aircraft.lng, aircraft.lat])
    expect(recoveryWalkFeatures([{ ...base, etaSec: 0 }], () => access, 1)).toHaveLength(0)
    expect(recoveryWalkFeatures([{ ...base, status: 'enroute' }], () => access, 1)).toHaveLength(0)
    expect(recoveryWalkFeatures([{ ...base, accessGapM: 15, etaSec: 5 }], () => access, 1)).toHaveLength(0)
  })

  it('walkSecondsTotal matches the sim: ceil(gap / (1.3 / multiplier) * 20) ticks of 0.05 s', () => {
    expect(walkSecondsTotal(100, 1)).toBeCloseTo(Math.ceil((100 / 1.3) * 20) * 0.05, 9)
    expect(walkSecondsTotal(100, 2)).toBeGreaterThan(walkSecondsTotal(100, 1))
  })

  it('finds a unit contact position from its heat source', () => {
    const heat = [{ id: 'hs1', position: contact }, { id: 'hs2', position: { lat: 1, lng: 2 } }]
    expect(unitContactPosition(unit({ id: 'g1', targetThermalId: 'hs1' }), heat)).toEqual(contact)
    expect(unitContactPosition(unit({ id: 'g1', targetThermalId: 'nope' }), heat)).toBeNull()
    expect(unitContactPosition(unit({ id: 'g1', targetThermalId: undefined }), heat)).toBeNull()
  })
})
