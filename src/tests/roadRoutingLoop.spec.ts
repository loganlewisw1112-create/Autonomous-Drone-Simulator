/**
 * c12b tier 2: the REAL production tick() with road-routed ground units and recovery teams.
 * Pure router tests, tier 1 and the access gate live in roadRouting.spec.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { LatLng, ScenarioConfig } from '@/types'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { getRoadNetwork } from '@/scenarios/roadFixtures'
import { useDroneStore } from '@/store/droneStore'
import { tick, stopSimLoop, initFleet, endMission } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { createRecoveryTeam, recoveryWalkTicks, tickRecoveryTeam } from '@/sim/mission/recoveryManager'
import { getTeamRoute, getUnitRoute, planGroundDispatch, routeMemo, contactAccess } from '@/sim/mission/routeMemo'
import { snapToRoad } from '@/sim/mission/roadRouter'
import { haversineDistanceM } from '@/utils/geometry'
import { findGapPoint, makeNearestEdgeDistM } from './roadTestUtils'

const FIXED_DT = 0.05

interface Trajectories {
  units: Record<string, LatLng[]>
  teams: Record<string, LatLng[]>
  stop: () => void
}

/** Record every distinct position a unit or team takes, per store write (one tick can run 4 steps). */
function recordTrajectories(): Trajectories {
  const units: Record<string, LatLng[]> = {}
  const teams: Record<string, LatLng[]> = {}
  const push = (bag: Record<string, LatLng[]>, id: string, p: LatLng) => {
    const list = (bag[id] ??= [])
    const last = list[list.length - 1]
    if (!last || last.lat !== p.lat || last.lng !== p.lng) list.push({ lat: p.lat, lng: p.lng })
  }
  const stop = useDroneStore.subscribe((s) => {
    for (const u of s.groundUnits) push(units, u.id, u.position)
    for (const t of s.recoveryTeams) push(teams, t.id, t.position)
  })
  return { units, teams, stop }
}

async function setupScenario(scenario: ScenarioConfig, simSpeed: 1 | 5, stage = true): Promise<void> {
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  if (stage) await prepareScenarioTerrain(scenario)
  useDroneStore.setState({
    scenario,
    weatherState: getDefaultWeatherState(scenario.seed),
    launchPlan: null,
    groundUnits: [],
    recoveryTeams: [],
    thermalContacts: [],
  })
  initFleet()
  useDroneStore.getState().setSimSpeed(simSpeed)
  useDroneStore.getState().setLifecycle('running')
  useDroneStore.getState().setRunning(true)
}

const allExtracted = (n: number) => () => {
  const teams = useDroneStore.getState().recoveryTeams
  return teams.length >= n && teams.every((t) => t.status === 'extracted')
}

function stepUntil(done: () => boolean, maxCalls: number): number {
  let calls = 0
  while (calls < maxCalls && !done()) { tick(); calls++ }
  return calls
}

/** Heat sources that road-dispatch accepts, shortest drive first. */
function dispatchableSources(scenario: ScenarioConfig, count: number) {
  const net = getRoadNetwork(scenario)!
  const ranked = scenario.heatSources.flatMap((hs) => {
    const plan = planGroundDispatch(scenario, { sourceId: hs.id, position: hs.position }, 0, [])
    return plan.ok && plan.route.lengthM > 150 ? [{ hs, len: plan.route.lengthM }] : []
  }).sort((a, b) => a.len - b.len || (a.hs.id < b.hs.id ? -1 : 1))
  expect(net).toBeTruthy()
  return ranked.slice(0, count).map((r) => r.hs)
}

function addContact(hs: ScenarioConfig['heatSources'][number]) {
  useDroneStore.getState().addThermalContact({ sourceId: hs.id, class: hs.class, position: hs.position, confidence: 0.9, tick: 0 })
}

function scenarioById(id: string): ScenarioConfig {
  const s = ALL_SCENARIOS.find((x) => x.id === id)
  if (!s) throw new Error(`scenario ${id} missing`)
  return s
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { stopSimLoop(); vi.useRealTimers() })

// ── Ground units ────────────────────────────────────────────────────────────────
describe('ground units drive the roads (real tick loop)', () => {
  for (const id of ['demo_basic', 'demo_wildfire', 'hist_oso_sr530_2014']) {
    it(`${id}: on the road at every step, identical at simSpeed 1 and 5`, async () => {
      const scenario = scenarioById(id)
      const sources = (await (async () => { await prepareScenarioTerrain(scenario); return dispatchableSources(scenario, 2) })())
      expect(sources.length).toBeGreaterThan(0)
      const net = getRoadNetwork(scenario)!
      const nearest = makeNearestEdgeDistM(net)
      for (const hs of sources) {
        const runs: Record<number, { traj: LatLng[]; unitStatus: string; events: unknown[]; pos: LatLng }> = {}
        for (const speed of [1, 5] as const) {
          await setupScenario(scenario, speed)
          addContact(hs)
          const rec = recordTrajectories()
          useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)
          const unitId = useDroneStore.getState().groundUnits[0].id
          stepUntil(() => useDroneStore.getState().groundUnits[0].status !== 'enroute', 30_000 / speed)
          rec.stop()
          const unit = useDroneStore.getState().groundUnits[0]
          runs[speed] = {
            traj: rec.units[unitId],
            unitStatus: unit.status,
            events: useDroneStore.getState().events.filter((e) => e.eventType === 'ground_unit_on_scene').map((e) => e.payload),
            pos: unit.position,
          }
          // Sample 0 and every later sample sit on a road edge.
          let worst = 0
          for (const p of rec.units[unitId]) worst = Math.max(worst, nearest(p))
          expect(worst, `${id}/${hs.id} @${speed}x`).toBeLessThanOrEqual(0.5)
          expect(unit.status).toBe('on_scene')
          // Arrives at the route end, not within 15 m of the contact in a straight line.
          const route = getUnitRoute(unit, scenario, hs.position)!
          expect(unit.position).toEqual(route.points[route.points.length - 1])
          expect(unit.accessGapM).toBe(route.accessGapM)
          expect(unit.etaComputed).toBe(true)
        }
        expect(runs[1].traj.length).toBeGreaterThan(10)
        expect(runs[5].traj).toEqual(runs[1].traj)          // FIXED_DT per step: speed-invariant
        expect(runs[5].events).toEqual(runs[1].events)
        expect((runs[1].events[0] as { accessGapM?: number }).accessGapM).toBeTypeOf('number')
      }
    }, 120_000)
  }

  it('the first-tick ETA is the route ETA (not overwritten by a straight-line value)', async () => {
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 1)
    const [hs] = dispatchableSources(scenario, 1)
    addContact(hs)
    useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)
    const before = useDroneStore.getState().groundUnits[0].etaSec!
    tick()
    const after = useDroneStore.getState().groundUnits[0]
    expect(after.etaComputed).toBe(true)
    expect(Math.abs(after.etaSec! - before)).toBeLessThanOrEqual(1)
    const straightLine = Math.round(haversineDistanceM(after.position, hs.position) / 8)
    expect(before).not.toBe(straightLine)
  }, 60_000)

  it('is deterministic: the same seed gives byte-identical replay frames', async () => {
    const scenario = scenarioById('demo_basic')
    const frames: string[] = []
    for (let run = 0; run < 2; run++) {
      await setupScenario(scenario, 5)
      const [hs] = dispatchableSources(scenario, 1)
      addContact(hs)
      useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)
      // A recovery team in the same run, so replay frames carry both a unit and a team.
      const gapPoint = findGapPoint(getRoadNetwork(scenario)!, 60, { near: { center: scenario.startPosition, maxM: 600 } })!
      const dId = useDroneStore.getState().drones[0].id
      useDroneStore.setState((st) => ({ drones: st.drones.map((d) => (d.id === dId ? { ...d, position: gapPoint } : d)) }))
      useDroneStore.getState().remoteLandDrone(dId)
      stepUntil(() => useDroneStore.getState().groundUnits[0].status !== 'enroute' && allExtracted(1)(), 20_000)
      expect(useDroneStore.getState().recoveryTeams[0].status).toBe('extracted')
      endMission()
      const f = useDroneStore.getState().replaySession?.frames ?? []
      expect(f.length).toBeGreaterThan(2)
      frames.push(JSON.stringify(f.map((fr) => ({ gu: fr.groundUnits, rt: fr.recoveryTeams }))))
      stopSimLoop()
    }
    expect(frames[1]).toEqual(frames[0])
    expect(frames[0]).toContain('routeDistM')
    expect(frames[0]).toContain('roadRouted')
  }, 120_000)

  it('three units on one contact start at three distinct nodes, the extra two at entries[] nodes', async () => {
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 1)
    const net = getRoadNetwork(scenario)!
    const [hs] = dispatchableSources(scenario, 1)
    addContact(hs)
    const dispatch = useDroneStore.getState().dispatchGroundUnit
    dispatch(hs.id, 'intervention', scenario.startPosition)
    dispatch(hs.id, 'intervention', scenario.startPosition)
    dispatch(hs.id, 'intervention', scenario.startPosition)
    dispatch(hs.id, 'intervention', scenario.startPosition)   // a fourth is refused
    const units = useDroneStore.getState().groundUnits
    expect(units).toHaveLength(3)
    const tickNow = useDroneStore.getState().tick
    expect(units.map((u) => u.id)).toEqual([`gu-${hs.id}-t${tickNow}`, `gu-${hs.id}-t${tickNow}-n1`, `gu-${hs.id}-t${tickNow}-n2`])
    expect(new Set(units.map((u) => u.routeFromNode)).size).toBe(3)
    expect(net.entries).toContain(units[1].routeFromNode)
    expect(net.entries).toContain(units[2].routeFromNode)
    // Only the first unit is the contact's groundUnitId; every unit starts on a road node.
    expect(useDroneStore.getState().thermalContacts[0].groundUnitId).toBe(units[0].id)
    for (const u of units) expect(u.position).toEqual(net.nodes[u.routeFromNode!])
    expect(useDroneStore.getState().metrics.groundUnitDispatch).toBe(3)
  }, 60_000)

  it('a contact more than 2 km from any road gets no unit and the access reason says so', async () => {
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 1)
    const net = getRoadNetwork(scenario)!
    const far = findGapPoint(net, 2600)
    expect(far).toBeTruthy()
    useDroneStore.getState().addThermalContact({ sourceId: 'far-1', class: 'generic-person', position: far!, confidence: 0.9, tick: 0 })
    const access = contactAccess(scenario, { sourceId: 'far-1', position: far! })
    expect(access.access).toBe('none')
    expect(access.reason).toMatch(/Nearest road 2\.\d km/)
    const before = useDroneStore.getState()
    before.dispatchGroundUnit('far-1', 'intervention', scenario.startPosition)
    const after = useDroneStore.getState()
    expect(after.groundUnits).toHaveLength(0)
    expect(after.thermalContacts[0].groundUnitId).toBeUndefined()
    expect(after.metrics.groundUnitDispatch).toBe(before.metrics.groundUnitDispatch)
  }, 60_000)

  for (const [label, id] of [['custom scenario (no fixture)', 'custom_roadless_mission'], ['parked scenario (loader not found)', 'parked_roadless_scenario']] as const) {
    it(`${label}: no throw, no vehicle, "No road access", and recovery still completes`, async () => {
      const base = scenarioById('demo_basic')
      const scenario: ScenarioConfig = { ...base, id, terrainFixtureId: undefined }
      await setupScenario(scenario, 5)
      expect(getRoadNetwork(scenario)).toBeNull()
      const hs = scenario.heatSources[0]
      addContact(hs)
      expect(contactAccess(scenario, { sourceId: hs.id, position: hs.position })).toMatchObject({ access: 'none', gapM: null })
      expect(contactAccess(scenario, { sourceId: hs.id, position: hs.position }).reason).toContain("can't reach")
      expect(() => useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)).not.toThrow()
      expect(useDroneStore.getState().groundUnits).toHaveLength(0)
      // Recovery on a roadless scenario: unrouted team, legacy timing, mission completes.
      const drone = useDroneStore.getState().drones[0]
      useDroneStore.setState((s) => ({ drones: s.drones.map((d) => (d.id === drone.id ? { ...d, position: { lat: scenario.startPosition.lat + 0.002, lng: scenario.startPosition.lng + 0.002 } } : d)) }))
      useDroneStore.getState().remoteLandDrone(drone.id)
      stepUntil(allExtracted(1), 20_000)
      const team = useDroneStore.getState().recoveryTeams[0]
      expect(team.roadRouted).toBe(false)
      expect(team.status).toBe('extracted')
      expect(team.position).toEqual(scenario.startPosition)
      expect(getTeamRoute(team, scenario)).toBeNull()
      expect(['recovered', 'landed']).toContain(useDroneStore.getState().drones.find((d) => d.id === drone.id)?.missionState)
    }, 120_000)
  }
})

// ── Recovery teams ──────────────────────────────────────────────────────────────
describe('recovery teams drive the roads (real tick loop)', () => {
  /** Force remote_landed on drone `index` at `position` and return the id. */
  function strand(index: number, position: LatLng): string {
    const id = useDroneStore.getState().drones[index].id
    useDroneStore.setState((s) => ({ drones: s.drones.map((d) => (d.id === id ? { ...d, position } : d)) }))
    useDroneStore.getState().remoteLandDrone(id)
    return id
  }

  for (const [cls, id] of [['urban', 'hist_joplin_ef5_2011'], ['wildfire', 'demo_wildfire'], ['flood', 'train_flood_corridor']] as const) {
    it(`${cls} (${id}): team stays on the road, matches at simSpeed 1 and 5, walks in before extraction`, async () => {
      const scenario = scenarioById(id)
      await prepareScenarioTerrain(scenario)
      const net = getRoadNetwork(scenario)!
      const nearest = makeNearestEdgeDistM(net)
      // The largest gap this scenario offers inside comms range (dense urban/flood networks have no
      // point 320 m from any road near the base, so they use a smaller gap; all stay below the 750 m walk-in limit).
      let point: LatLng | null = null
      for (const maxM of [200, 350, 600, 1000]) {
        for (const gap of [320, 250, 180, 120, 80, 50]) {
          point = findGapPoint(net, gap, { near: { center: scenario.startPosition, maxM } })
          if (point) break
        }
        if (point) break
      }
      expect(point, 'a point 50-320 m off the network inside comms range').toBeTruthy()
      const trajectories: LatLng[][] = []
      let extractedTick = 0
      for (const speed of [1, 5] as const) {
        await setupScenario(scenario, speed)
        const rec = recordTrajectories()
        strand(0, point!)
        stepUntil(allExtracted(1), 40_000 / speed)
        rec.stop()
        const team = useDroneStore.getState().recoveryTeams[0]
        expect(team.status).toBe('extracted')
        expect(team.roadRouted).toBe(true)
        const traj = rec.teams[team.id]
        let worst = 0
        for (const p of traj) worst = Math.max(worst, nearest(p))
        expect(worst, `${id} @${speed}x`).toBeLessThanOrEqual(0.5)
        trajectories.push(traj)
        const events = useDroneStore.getState().events
        const requested = events.find((e) => e.eventType === 'drone_recovery_requested')!
        expect(requested.payload).toMatchObject({ roadAccess: 'ok' })
        const onScene = events.find((e) => e.eventType === 'ground_unit_on_scene' && (e.payload as { teamId?: string }).teamId === team.id)!
        const recovered = events.find((e) => e.eventType === 'drone_recovered')!
        const gap = team.accessGapM!
        expect(gap).toBeGreaterThan(40)
        expect(gap).toBeLessThan(330)
        expect(onScene.payload).toMatchObject({ teamId: team.id, accessGapM: gap })
        const walkTicks = recoveryWalkTicks(gap, useDroneStore.getState().weatherState)
        expect(recovered.tick - onScene.tick).toBe(Math.max(100, walkTicks))
        expect((recovered.payload as { accessGapM?: number }).accessGapM).toBe(gap)
        extractedTick = recovered.tick
      }
      expect(trajectories[1]).toEqual(trajectories[0])
      expect(extractedTick).toBeGreaterThan(0)
    }, 120_000)
  }

  it('a 40 m gap: extraction waits max(100, ceil(40/1.3*20)) = 616 steps after arrival', async () => {
    const clear = getDefaultWeatherState(1)
    expect(recoveryWalkTicks(40, { ...clear, groundUnitEtaMultiplier: 1 })).toBe(616)
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 5)
    const net = getRoadNetwork(scenario)!
    const point = findGapPoint(net, 40, { near: { center: scenario.startPosition, maxM: 600 } })
    expect(point).toBeTruthy()
    strand(0, point!)
    stepUntil(allExtracted(1), 20_000)
    const team = useDroneStore.getState().recoveryTeams[0]
    const events = useDroneStore.getState().events
    const onScene = events.find((e) => e.eventType === 'ground_unit_on_scene')!
    const recovered = events.find((e) => e.eventType === 'drone_recovered')!
    const expected = recoveryWalkTicks(team.accessGapM!, useDroneStore.getState().weatherState)
    expect(expected).toBeGreaterThan(600)
    expect(recovered.tick - onScene.tick).toBe(Math.max(100, expected))
  }, 120_000)

  it('far from road (over 750 m): unrouted, frozen at staging, no route data, legacy timing', async () => {
    // demo_sar_coastal has water beside its base, so a point 800 m from any road exists inside comms range.
    const scenario = scenarioById('demo_sar_coastal')
    await setupScenario(scenario, 5)
    const net = getRoadNetwork(scenario)!
    const point = findGapPoint(net, 800, { near: { center: scenario.startPosition, maxM: 1000 } })!
    expect(point, 'a point 800 m from the coastal network near its base').toBeTruthy()
    const weather = useDroneStore.getState().weatherState
    strand(0, point!)
    const rec = recordTrajectories()
    stepUntil(allExtracted(1), 30_000)
    rec.stop()
    const state = useDroneStore.getState()
    const team = state.recoveryTeams[0]
    expect(team.roadRouted).toBe(false)
    expect(team.accessGapM).toBeGreaterThan(750)
    expect(team.accessNote).toMatch(/nearest road \d+ m/)
    expect(getTeamRoute(team, scenario)).toBeNull()
    expect(routeMemo.get(team.id)).toBeUndefined()
    expect(new Set(rec.teams[team.id].map((p) => `${p.lat},${p.lng}`)).size).toBe(1)     // never leaves staging
    // Staging is a road node (snapped), so no off-road coordinate is ever recorded.
    expect(makeNearestEdgeDistM(net)(team.position)).toBeLessThanOrEqual(0.5)
    // Legacy timing oracle: arrival = ceil(max(0, d - 15) / (5 / mult * 0.05)), extraction 100 steps later.
    const events = state.events
    const requested = events.find((e) => e.eventType === 'drone_recovery_requested')!
    expect(requested.payload).toMatchObject({ roadAccess: 'none' })
    const onScene = events.find((e) => e.eventType === 'ground_unit_on_scene')!
    const recovered = events.find((e) => e.eventType === 'drone_recovered')!
    const d = haversineDistanceM(team.position, team.targetPosition)
    const stepM = (5 / weather.groundUnitEtaMultiplier) * FIXED_DT
    expect(onScene.tick - requested.tick).toBe(Math.ceil(Math.max(0, d - 15) / stepM))
    expect(recovered.tick - onScene.tick).toBe(100)
    // And it agrees with the retained legacy functions run on the same geometry.
    let legacy = createRecoveryTeam('x', 'uav', team.position, team.targetPosition, weather)
    let n = 0
    while (legacy.status === 'enroute' && n < 100_000) { legacy = tickRecoveryTeam(legacy, weather, FIXED_DT); n++ }
    expect(onScene.tick - requested.tick).toBe(n - 1)
  }, 120_000)

  it('two concurrent recoveries: distinct ids and staging nodes, both on-road, both recovered', async () => {
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 5)
    const net = getRoadNetwork(scenario)!
    const nearest = makeNearestEdgeDistM(net)
    const near = { center: scenario.startPosition, maxM: 700 }
    const a = findGapPoint(net, 80, { near })!
    const b = findGapPoint(net, 80, { near, avoid: [a], minSeparationM: 250 })!
    expect(a && b).toBeTruthy()
    const rec = recordTrajectories()
    strand(0, a)
    strand(1, b)
    stepUntil(allExtracted(2), 30_000)
    rec.stop()
    const teams = useDroneStore.getState().recoveryTeams
    expect(teams).toHaveLength(2)
    expect(new Set(teams.map((t) => t.id)).size).toBe(2)
    expect(new Set(teams.map((t) => t.routeFromNode)).size).toBe(2)
    expect(net.entries).toContain(teams[1].routeFromNode)
    for (const t of teams) {
      expect(t.status).toBe('extracted')
      let worst = 0
      for (const p of rec.teams[t.id]) worst = Math.max(worst, nearest(p))
      expect(worst).toBeLessThanOrEqual(0.5)
    }
    expect(useDroneStore.getState().events.filter((e) => e.eventType === 'drone_recovered')).toHaveLength(2)
  }, 120_000)

  it('replay: with the memo cleared, getTeamRoute and getUnitRoute rebuild the driven polyline byte for byte', async () => {
    const scenario = scenarioById('demo_basic')
    await setupScenario(scenario, 5)
    const net = getRoadNetwork(scenario)!
    const [hs] = dispatchableSources(scenario, 1)
    addContact(hs)
    useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)
    useDroneStore.getState().dispatchGroundUnit(hs.id, 'intervention', scenario.startPosition)
    strand(0, findGapPoint(net, 60, { near: { center: scenario.startPosition, maxM: 600 } })!)
    stepUntil(allExtracted(1), 20_000)
    const live = useDroneStore.getState()
    const secondUnit = live.groundUnits[1]
    const driven = {
      unit: JSON.stringify(routeMemo.get(secondUnit.id)!.route),
      team: JSON.stringify(routeMemo.get(live.recoveryTeams[0].id)!.route),
    }
    endMission()
    const frames = useDroneStore.getState().replaySession!.frames
    const k = frames.findIndex((f) => f.recoveryTeams.length > 0 && f.groundUnits.length > 1)
    expect(k).toBeGreaterThanOrEqual(0)
    routeMemo.clear()
    useDroneStore.getState().setReplayIndex(k)
    const shown = useDroneStore.getState()
    expect(shown.recoveryTeams[0]).toEqual(frames[k].recoveryTeams[0])
    expect(JSON.stringify(getTeamRoute(frames[k].recoveryTeams[0], scenario))).toBe(driven.team)
    expect(JSON.stringify(getUnitRoute(frames[k].groundUnits[1], scenario))).toBe(driven.unit)   // via heatSources, no live contact
    // Second unit's recomputed route differs from the first unit's (different staging node).
    expect(JSON.stringify(getUnitRoute(frames[k].groundUnits[0], scenario))).not.toBe(driven.unit)
    expect(snapToRoad(net, hs.position, { role: 'target' })).toBeTruthy()
  }, 120_000)
})
