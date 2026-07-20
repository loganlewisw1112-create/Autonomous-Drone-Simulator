import { describe, it, expect, beforeEach } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { MAX_WAYPOINTS_PER_DRONE } from '@/components/designer/designerValidation'
import {
  APPEND_DWELL_SEC,
  DEFAULT_APPEND_ALTITUDE_FT,
  buildAppendedWaypoint,
  canAppend,
  clampOperatorAltitude,
  routeWithoutWaypoint,
} from '@/components/mapRouteEditing'
import type { Waypoint } from '@/types'

const wp = (id: string, lat: number, lng: number, altitudeFt = 120, label?: string): Waypoint => ({
  id, label: label ?? `Waypoint ${id}`, position: { lat, lng }, altitudeFt,
})

let idCounter = 0
const stubId = () => `stub-${++idCounter}`

describe('mapRouteEditing pure helpers', () => {
  beforeEach(() => { idCounter = 0 })

  it('appends at the previous waypoint altitude so the extension keeps flying level', () => {
    const route = [wp('a', 37.77, -122.41, 210)]
    const appended = buildAppendedWaypoint(route, { lat: 37.78, lng: -122.42 }, stubId)

    expect(appended.altitudeFt).toBe(210)
    expect(appended.position).toEqual({ lat: 37.78, lng: -122.42 })
    expect(appended.dwellTimeSec).toBe(APPEND_DWELL_SEC)
    expect(appended.label).toBe('Waypoint 2')
    expect(appended.id).toBe('stub-1')
  })

  it('falls back to the default altitude for the first waypoint of an empty route', () => {
    const appended = buildAppendedWaypoint([], { lat: 37.77, lng: -122.41 }, stubId)
    expect(appended.altitudeFt).toBe(DEFAULT_APPEND_ALTITUDE_FT)
    expect(appended.label).toBe('Waypoint 1')
  })

  it('clamps an inherited altitude into the operator-legal band', () => {
    expect(clampOperatorAltitude(5)).toBe(20)
    expect(clampOperatorAltitude(900)).toBe(400)
    expect(clampOperatorAltitude(Number.NaN)).toBe(DEFAULT_APPEND_ALTITUDE_FT)
    // An out-of-band previous waypoint must not produce an illegal append.
    expect(buildAppendedWaypoint([wp('a', 37.77, -122.41, 900)], { lat: 37.78, lng: -122.42 }, stubId).altitudeFt).toBe(400)
  })

  it('caps appends at the shared per-drone waypoint limit', () => {
    const full = Array.from({ length: MAX_WAYPOINTS_PER_DRONE }, (_, i) => wp(`w${i}`, 37.77, -122.41))
    expect(canAppend(full.slice(0, MAX_WAYPOINTS_PER_DRONE - 1))).toBe(true)
    expect(canAppend(full)).toBe(false)
  })

  it('removes a waypoint and renumbers only default labels', () => {
    const route = [
      wp('a', 37.77, -122.41, 120, 'Waypoint 1'),
      wp('b', 37.78, -122.42, 120, 'Waypoint 2'),
      wp('c', 37.79, -122.43, 120, 'Overwatch perch'),
    ]
    const next = routeWithoutWaypoint(route, 'a')

    expect(next.map((w) => w.id)).toEqual(['b', 'c'])
    expect(next[0].label).toBe('Waypoint 1')       // renumbered
    expect(next[1].label).toBe('Overwatch perch')  // operator-named, untouched
  })

  it('is a no-op for an unknown waypoint id', () => {
    const route = [wp('a', 37.77, -122.41)]
    expect(routeWithoutWaypoint(route, 'missing')).toHaveLength(1)
  })
})

// The port scenario has a non-authorized geofence (gf-cranes) used by
// operatorRoutes.spec — reused here so rejection is exercised against real
// scenario geometry rather than a synthetic fixture.
const portScenario = ALL_SCENARIOS.find((s) => s.id === 'demo_perimeter')!

function loadPortScenario() {
  useDroneStore.setState({
    scenario: portScenario,
    weatherState: getDefaultWeatherState(portScenario.seed),
    launchPlan: null,
  })
  initFleet()
}

describe('route edit mode store round-trip', () => {
  beforeEach(() => {
    useDroneStore.getState().resetMission()
    loadPortScenario()
  })

  it('accepts a tap-appended waypoint through the shared setDroneRoute path', () => {
    const store = useDroneStore.getState()
    const route = store.droneWaypoints['uav-01'] ?? []
    const appended = buildAppendedWaypoint(route, route[0].position, stubId)

    // Appending a point that duplicates an existing (already-safe) location keeps
    // the route inside the same validated corridor.
    expect(store.setDroneRoute('uav-01', [...route, appended], 'append_waypoint')).toBe(true)
    expect(useDroneStore.getState().droneWaypoints['uav-01']).toHaveLength(route.length + 1)
  })

  it('rejects an append that crosses a non-authorized geofence and reports why', () => {
    const store = useDroneStore.getState()
    const unsafe = [
      wp('unsafe-a', 37.7995, -122.2875, 100),
      wp('unsafe-b', 37.7995, -122.2820, 100),
    ]

    expect(store.setDroneRoute('uav-01', unsafe, 'set_route')).toBe(false)
    // routeCommandError lives at the store root, not inside ui.
    expect(useDroneStore.getState().routeCommandError).toContain('rejected')
  })

  it('clears route edit mode when the drone is deselected', () => {
    const store = useDroneStore.getState()
    store.setSelectedDrone('uav-01')
    store.setRouteEditMode(true)
    expect(useDroneStore.getState().ui.routeEditMode).toBe(true)

    useDroneStore.getState().setSelectedDrone(null)
    expect(useDroneStore.getState().ui.routeEditMode).toBe(false)
  })

  it('refuses to enter edit mode with nothing selected', () => {
    useDroneStore.getState().setSelectedDrone(null)
    useDroneStore.getState().setRouteEditMode(true)
    expect(useDroneStore.getState().ui.routeEditMode).toBe(false)
  })

  it('clears route edit mode on mission reset', () => {
    const store = useDroneStore.getState()
    store.setSelectedDrone('uav-01')
    store.setRouteEditMode(true)

    useDroneStore.getState().resetMission()
    expect(useDroneStore.getState().ui.routeEditMode).toBe(false)
  })
})
