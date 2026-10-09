/**
 * c5a: the report adapters draw ground-unit and recovery-team tracks along the roads, from the
 * FINAL routeDistM of each vehicle. Tracks come only from an already-loaded road network; an adapter
 * never starts a load. Real demo_basic road fixture, no mocks.
 */
import { describe, expect, it } from 'vitest'
import { getRoadNetwork, prepareScenarioRoads } from '@/scenarios/roadFixtures'
import { pointAtDistance } from '@/sim/mission/roadRouter'
import type { RoadRoute } from '@/sim/mission/roadRouter'
import { createRoutedRecoveryTeam } from '@/sim/mission/recoveryManager'
import { getTeamRoute, getUnitRoute, planGroundDispatch, planRecoveryDispatch } from '@/sim/mission/routeMemo'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { reportSourceFromLive, reportSourceFromStoredRun } from '@/sim/demo/reportAdapters'
import { buildReportViewModel } from '@/sim/demo/reportViewModel'
import { buildVehicleTracks } from '@/sim/demo/reportVehicleTracks'
import { haversineDistanceM } from '@/utils/geometry'
import { findGapPoint } from './roadTestUtils'
import { makeFixture, scenario } from './reportFixtures'
import type { GroundUnitState, LatLng, RecoveryTeamState } from '@/types'

const weather = getDefaultWeatherState(scenario.seed)

function unitAt(id: string, sourceId: string, nodeId: number, routeDistM: number, patch: Partial<GroundUnitState> = {}): GroundUnitState {
  return {
    id, role: 'intervention', position: scenario.startPosition, status: 'enroute', targetThermalId: sourceId,
    routeFromNode: nodeId, routeDistM, ...patch,
  }
}

describe('buildVehicleTracks: no road network loaded', () => {
  it('returns undefined, does not throw, and never starts a load', async () => {
    expect(getRoadNetwork(scenario)).toBeNull()
    const hs = scenario.heatSources[0]
    const unit = unitAt('gu-noload', hs.id, 0, 120, { accessGapM: 40 })
    const team: RecoveryTeamState = {
      id: 'rt-noload', droneId: 'uav-02', position: scenario.startPosition, targetPosition: hs.position,
      status: 'on_scene', etaSec: 0, routePoints: [], routeFromNode: 0, routeDistM: 90, accessGapM: 40, roadRouted: true,
    }
    expect(() => buildVehicleTracks([unit], [team], scenario)).not.toThrow()
    expect(buildVehicleTracks([unit], [team], scenario)).toBeUndefined()
    // A load started by the adapter would settle within a few macrotasks.
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(getRoadNetwork(scenario)).toBeNull()
  })
})

describe('buildVehicleTracks: staged demo_basic network', () => {
  let hsId = ''
  let hsPos: LatLng = scenario.startPosition
  let node = 0
  let route!: RoadRoute

  async function stage(): Promise<void> {
    await prepareScenarioRoads(scenario.id)
    expect(getRoadNetwork(scenario)).not.toBeNull()
    const ranked = scenario.heatSources.flatMap((hs) => {
      const plan = planGroundDispatch(scenario, { sourceId: hs.id, position: hs.position }, 0, [])
      return plan.ok && plan.route.lengthM > 150 ? [{ hs, plan }] : []
    }).sort((a, b) => a.plan.route.lengthM - b.plan.route.lengthM || (a.hs.id < b.hs.id ? -1 : 1))
    expect(ranked.length).toBeGreaterThan(0)
    const pick = ranked[0]
    hsId = pick.hs.id
    hsPos = pick.hs.position
    node = pick.plan.node
    route = pick.plan.route
  }

  it('a dispatched ground unit gets a track: the route prefix up to its final routeDistM, kind ground', async () => {
    await stage()
    const s = route.lengthM * 0.6
    const unit = unitAt('gu-mid', hsId, node, s, { accessGapM: 4 })
    const tracks = buildVehicleTracks([unit], [], scenario)
    expect(tracks).toHaveLength(1)
    const t = tracks![0]
    expect(t).toMatchObject({ id: 'gu-mid', kind: 'ground' })
    expect(t.onFootTo).toBeUndefined()
    expect(t.points.length).toBeGreaterThanOrEqual(2)
    expect(t.points[0]).toEqual(route.points[0])
    const end = pointAtDistance(route, s)
    expect(t.points.at(-1)).toEqual(end)
    // Every vertex before the end lies on the route, in order, and nothing is drawn past routeDistM.
    const inner = t.points.slice(0, -1)
    inner.forEach((p, i) => expect(p).toEqual(route.points[i]))
    expect(route.cumDistM[inner.length]).toBeGreaterThanOrEqual(s)
    expect(t.points.length).toBeLessThan(route.points.length)
  })

  it('a finished unit draws the whole route; the walk-in uses the unit\'s OWN gap, not route.accessGapM', async () => {
    await stage()
    const own = getUnitRoute(unitAt('gu-peek', hsId, node, 0), scenario, hsPos)!
    expect(own.lengthM).toBeCloseTo(route.lengthM, 6)
    const done = unitAt('gu-done', hsId, node, route.lengthM, { status: 'on_scene' })

    const far = buildVehicleTracks([{ ...done, id: 'gu-far', accessGapM: 40 }], [], scenario)![0]
    expect(far.points).toEqual(route.points)
    expect(far.onFootTo).toEqual(hsPos)

    const near = buildVehicleTracks([{ ...done, id: 'gu-near', accessGapM: 15 }], [], scenario)![0]
    expect(near.onFootTo).toBeUndefined()

    const unknown = buildVehicleTracks([{ ...done, id: 'gu-unknown' }], [], scenario)![0]
    expect(unknown.onFootTo).toBeUndefined()

    // Two units sharing one cached route carry different own gaps: each decides for itself.
    const pair = buildVehicleTracks(
      [{ ...done, id: 'gu-pair-a', accessGapM: 3 }, { ...done, id: 'gu-pair-b', accessGapM: 60 }], [], scenario,
    )!
    expect(pair.find((p) => p.id === 'gu-pair-a')!.onFootTo).toBeUndefined()
    expect(pair.find((p) => p.id === 'gu-pair-b')!.onFootTo).toEqual(hsPos)
  })

  it('a unit still driving at mission end draws no on-foot leg, even with a large gap', async () => {
    await stage()
    const t = buildVehicleTracks([unitAt('gu-driving', hsId, node, route.lengthM * 0.5, { accessGapM: 80 })], [], scenario)![0]
    expect(t.onFootTo).toBeUndefined()
  })

  it('omits units that never drove, were not routed, or lost their contact', async () => {
    await stage()
    const parked = unitAt('gu-parked', hsId, node, 0, { accessGapM: 30 })
    const unrouted: GroundUnitState = { id: 'gu-legacy', role: 'intervention', position: scenario.startPosition, status: 'on_scene', targetThermalId: hsId }
    const orphan = unitAt('gu-orphan', 'no-such-contact', node, 100, { accessGapM: 30 })
    expect(buildVehicleTracks([parked, unrouted, orphan], [], scenario)).toBeUndefined()
  })

  it('a road-routed recovery team gets a recovery track and walks in from the access point to the aircraft', async () => {
    await stage()
    const net = getRoadNetwork(scenario)!
    expect(net).toBeTruthy()
    const dronePos = findGapPoint(net, 40, { near: { center: scenario.startPosition, maxM: 6000 } })
    expect(dronePos).not.toBeNull()
    const plan = planRecoveryDispatch(scenario, dronePos!, 0, [])
    expect(plan.roadRouted).toBe(true)
    if (!plan.roadRouted) return
    const base = { ...createRoutedRecoveryTeam('rt-1', 'uav-02', plan.route, dronePos!, weather, plan.accessGapM), routeFromNode: plan.node }
    expect(plan.accessGapM).toBeGreaterThan(15)
    expect(getTeamRoute(base, scenario)).toBeTruthy()

    const arrived: RecoveryTeamState = { ...base, status: 'on_scene', routeDistM: plan.route.lengthM }
    const tracks = buildVehicleTracks([], [arrived], scenario)!
    expect(tracks).toHaveLength(1)
    expect(tracks[0]).toMatchObject({ id: 'rt-1', kind: 'recovery' })
    expect(tracks[0].points).toEqual(plan.route.points)
    expect(tracks[0].onFootTo).toEqual(dronePos)
    expect(haversineDistanceM(tracks[0].points.at(-1)!, tracks[0].onFootTo!)).toBeGreaterThan(15)

    const short = buildVehicleTracks([], [{ ...arrived, id: 'rt-short', accessGapM: 10 }], scenario)![0]
    expect(short.onFootTo).toBeUndefined()
  })

  it('a recovery team with roadRouted false yields no track', async () => {
    await stage()
    const unrouted: RecoveryTeamState = {
      id: 'rt-unrouted', droneId: 'uav-02', position: scenario.startPosition, targetPosition: hsPos,
      status: 'on_scene', etaSec: 0, routePoints: [], routeFromNode: node, routeDistM: 400, accessGapM: 60, roadRouted: false,
    }
    expect(buildVehicleTracks([], [unrouted], scenario)).toBeUndefined()
    const missing: RecoveryTeamState = { ...unrouted, id: 'rt-missing', roadRouted: undefined }
    expect(buildVehicleTracks([], [missing], scenario)).toBeUndefined()
  })

  it('both adapters carry the track into the view model map (live from the replay session, stored from the last frame)', async () => {
    await stage()
    const unit = unitAt('gu-adapt', hsId, node, route.lengthM, { status: 'on_scene', accessGapM: 50 })

    const fx = makeFixture()
    const live = reportSourceFromLive({ ...fx.live, replaySession: { ...fx.session, finalGroundUnits: [unit] } })!
    expect(live.vehicleTracks).toHaveLength(1)

    const frame = { ...fx.detail.replayFrames[0], groundUnits: [unit] }
    const stored = reportSourceFromStoredRun(fx.summary, { ...fx.detail, replayFrames: [frame] })!
    expect(stored.vehicleTracks).toEqual(live.vehicleTracks)

    const a = buildReportViewModel(live)
    const b = buildReportViewModel(stored)
    expect(a.map.tracks).toHaveLength(1)
    expect(a.map.tracks[0]).toMatchObject({ id: 'gu-adapt', kind: 'ground' })
    expect(a.map.tracks[0].onFoot).not.toBeNull()
    expect(b.map).toEqual(a.map)
  })

  it('a run with no vehicles has no tracks, so the map is unchanged', async () => {
    await stage()
    const fx = makeFixture()
    expect(buildVehicleTracks([], [], scenario)).toBeUndefined()
    expect(reportSourceFromLive(fx.live)!.vehicleTracks).toBeUndefined()
    expect(buildReportViewModel(reportSourceFromLive(fx.live)!).map.tracks).toEqual([])
  })
})
