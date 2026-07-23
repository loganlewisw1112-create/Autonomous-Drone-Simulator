/**
 * NIST lane trial, driven through the REAL SimulationLoop (REALISM_ROADMAP WP-9).
 *
 * `laneScoring.spec.ts` covers the rubric and the fold in isolation. This pins the part that
 * only the live loop can show: that flying an actual aircraft down an actual lane emits real
 * identification events, that the score is what the rubric says about that flight, and — the
 * accept criterion that motivated the whole package — that the OBSTRUCTED lane scores lower than
 * the open one purely because real terrain (WP-4) denies line of sight.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopSimLoop, endMission, initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { laneForScenario } from '@/scenarios/nistLanes'
import { occlusionServiceFor } from '@/scenarios/terrainFixtures'
import { LANE_FEATURE_EVENT, scoreLane, type LaneScore } from '@/sim/mission/laneScoring'
import { verifyChain } from '@/utils/chainOfCustody'

const CLOCK_ORIGIN = new Date('2026-01-01T00:00:00Z')
const TICK_MS = 50
/** 10 minutes of sim time — inside the 20-minute limit, enough to fly the whole grid. */
const TRIAL_TICKS = 10 * 60 * 20

function flyLane(scenarioId: string): { score: LaneScore; laneEvents: number; chainOk: boolean } {
  const scenario = ALL_SCENARIOS.find((s) => s.id === scenarioId)!
  const lane = laneForScenario(scenarioId)!

  vi.setSystemTime(CLOCK_ORIGIN)
  useDroneStore.setState({
    scenario,
    weatherState: getDefaultWeatherState(scenario.seed),
    launchPlan: null,
  })
  initFleet()
  useDroneStore.getState().beginLaunchSequence()
  useDroneStore.getState().setRunning(true)
  startSimLoop()
  vi.advanceTimersByTime(TRIAL_TICKS * TICK_MS)
  endMission()

  const state = useDroneStore.getState()
  return {
    score: scoreLane(lane, state.events, state.elapsedSec),
    laneEvents: state.events.filter((e) => e.eventType === LANE_FEATURE_EVENT).length,
    chainOk: verifyChain([...state.events]),
  }
}

describe('NIST lane trial through the production loop (WP-9)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDroneStore.getState().resetMission()
  })
  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it('flying the open lane brief scores against the published rubric', () => {
    const { score, laneEvents, chainOk } = flyLane('nist_open_lane')

    expect(laneEvents).toBeGreaterThan(0)
    expect(score.score).toBeGreaterThan(0)
    expect(score.score).toBeLessThanOrEqual(100)
    expect(score.withinTimeLimit).toBe(true)
    expect(score.featuresRejectedLate).toBe(0)

    // The brief sweeps every target, so all should be attempted...
    expect(score.targetsAttempted).toBe(20)
    // ...but flying it unchanged must NOT hand out a perfect score: the finest features need a
    // deliberate descent, and deciding where to spend the clock is the trial.
    expect(score.score).toBeLessThan(100)
    expect(score.targetsComplete).toBe(0)

    // The score is backed by the same tamper-evident chain as the rest of the after-action pack.
    expect(chainOk).toBe(true)
  })

  it('is deterministic: the same trial flown twice scores identically', () => {
    const first = flyLane('nist_open_lane')
    useDroneStore.getState().resetMission()
    const second = flyLane('nist_open_lane')
    expect(second.score).toEqual(first.score)
    expect(second.laneEvents).toBe(first.laneEvents)
  })

  it('terrain masking makes the obstructed lane harder — the WP-4 dependency, measured', () => {
    // Precondition: the obstructed lane must actually have a committed DEM bound to it, or this
    // test would silently pass by comparing two identical open-air flights.
    expect(occlusionServiceFor('nist_obstructed_lane')).toBeDefined()
    expect(occlusionServiceFor('nist_open_lane')).toBeUndefined()

    const open = flyLane('nist_open_lane')
    useDroneStore.getState().resetMission()
    const obstructed = flyLane('nist_obstructed_lane')

    // Same rubric, same aircraft, every target inside acuity range — the only difference is that
    // real East Bay terrain stands between the aircraft and some of them. Measured 44 vs 80.
    expect(obstructed.score.score).toBeLessThan(open.score.score)
    expect(open.score.score - obstructed.score.score).toBeGreaterThan(20)

    // The open lane's overflight resolves the same depth on every target, so its profile is flat.
    // The obstructed lane's is ragged, because how much each target gives up depends on what the
    // ridge does to that particular sightline. A uniform profile would mean range was deciding,
    // not terrain — which is the failure mode this assertion exists to catch.
    const openDepths = new Set(open.score.perTarget.map((t) => t.featuresIdentified))
    const obstructedDepths = new Set(obstructed.score.perTarget.map((t) => t.featuresIdentified))
    expect(openDepths.size).toBe(1)
    expect(obstructedDepths.size).toBeGreaterThan(2)

    // Terrain degrades the trial; it does not make it unflyable.
    expect(obstructed.score.score).toBeGreaterThan(0)
    expect(Math.min(...obstructed.score.perTarget.map((t) => t.featuresIdentified))).toBeGreaterThan(0)
  })
})
