import { describe, expect, it } from 'vitest'
import {
  ARCMIN_RAD,
  FEATURE_SIZES_M,
  FEATURES_PER_TARGET,
  featureRangesM,
  LANE_FEATURE_EVENT,
  LANE_MAX_SCORE,
  LANE_TARGET_COUNT,
  LANE_TIME_LIMIT_SEC,
  resolvableFeatureIndex,
  resolvableRangeM,
  scoreLane,
  type NistLaneDefinition,
} from '@/sim/mission/laneScoring'
import { allLanes, laneForScenario, NIST_OPEN_LANE, NIST_LANE_SCENARIOS } from '@/scenarios/nistLanes'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { MissionEvent } from '@/types'

// REALISM_ROADMAP WP-9.

let hashCounter = 0
function event(
  targetId: string,
  featureIndex: number,
  elapsedSec: number,
  overrides: Partial<MissionEvent> = {},
): MissionEvent {
  hashCounter += 1
  return {
    hash: `h${hashCounter}`,
    prevHash: `h${hashCounter - 1}`,
    eventType: LANE_FEATURE_EVENT,
    droneId: 'uav-01',
    operatorId: 'student-1',
        role: 'pic',
    tick: Math.round(elapsedSec * 20),
    timestamp: elapsedSec * 1000,
    payload: { laneId: NIST_OPEN_LANE.id, targetId, featureIndex, elapsedSec },
    ...overrides,
  }
}

/** Every feature on every target, inside the limit. */
function perfectRun(lane: NistLaneDefinition): MissionEvent[] {
  return lane.targets.flatMap((target, t) =>
    Array.from({ length: FEATURES_PER_TARGET }, (_, f) => event(target.id, f, 10 + t * 5)))
}

describe('NIST lane rubric (WP-9)', () => {
  it('matches the published rubric: 20 targets × 5 features = 100 points', () => {
    expect(LANE_TARGET_COUNT).toBe(20)
    expect(FEATURES_PER_TARGET).toBe(5)
    expect(LANE_MAX_SCORE).toBe(100)
    expect(FEATURE_SIZES_M).toHaveLength(FEATURES_PER_TARGET)
    // "Increasingly small features".
    for (let i = 1; i < FEATURE_SIZES_M.length; i += 1) {
      expect(FEATURE_SIZES_M[i]).toBeLessThan(FEATURE_SIZES_M[i - 1])
    }
    // NIST's stated 15–20 minute limit, sized to one battery charge.
    expect(LANE_TIME_LIMIT_SEC).toBeGreaterThanOrEqual(15 * 60)
    expect(LANE_TIME_LIMIT_SEC).toBeLessThanOrEqual(20 * 60)
  })

  it('resolves features at the one-arcminute acuity standard', () => {
    expect(ARCMIN_RAD).toBeCloseTo(0.000290888, 9)
    // A 5 mm feature at 1 arcmin is resolvable to ~17.2 m; 80 mm to ~275 m.
    expect(resolvableRangeM(0.005)).toBeCloseTo(17.19, 1)
    expect(resolvableRangeM(0.08)).toBeCloseTo(275.0, 0)
    // Range scales linearly with feature size.
    expect(resolvableRangeM(0.04) / resolvableRangeM(0.02)).toBeCloseTo(2, 9)
    // Sharper eyes see further; the parameter is real, not decorative.
    expect(resolvableRangeM(0.02, 0.5)).toBeCloseTo(resolvableRangeM(0.02, 1) * 2, 6)

    const ranges = featureRangesM()
    expect(ranges).toHaveLength(FEATURES_PER_TARGET)
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i]).toBeLessThan(ranges[i - 1])
  })

  it('requires both close range and line of sight to resolve a feature', () => {
    const base = {
      observer: { position: { lat: 37, lng: -122 }, altMslM: 50 },
      target: NIST_OPEN_LANE.targets[0],
      targetMslM: 1.5,
    }
    // Beyond the largest feature's range: nothing.
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 400 })).toBe(-1)
    // Just inside the largest feature only.
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 270 })).toBe(0)
    // Closing range resolves progressively finer features.
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 130 })).toBe(1)
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 60 })).toBe(2)
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 30 })).toBe(3)
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: true, slantRangeM: 10 })).toBe(4)
    // No LOS is no score, at any range — this is the WP-4 dependency.
    expect(resolvableFeatureIndex({ ...base, hasLineOfSight: false, slantRangeM: 1 })).toBe(-1)
  })
})

describe('lane scoring (WP-9 accept criteria)', () => {
  it('a perfect run scores 100', () => {
    const score = scoreLane(NIST_OPEN_LANE, perfectRun(NIST_OPEN_LANE), 600)
    expect(score.score).toBe(100)
    expect(score.maxScore).toBe(100)
    expect(score.targetsComplete).toBe(20)
    expect(score.targetsAttempted).toBe(20)
    expect(score.featuresRejectedLate).toBe(0)
    expect(score.withinTimeLimit).toBe(true)
  })

  it('3 of 5 features on all 20 targets scores 60, as specified', () => {
    const events = NIST_OPEN_LANE.targets.flatMap((target) =>
      [0, 1, 2].map((f) => event(target.id, f, 30)))
    const score = scoreLane(NIST_OPEN_LANE, events, 600)
    expect(score.score).toBe(60)
    expect(score.featuresIdentified).toBe(60)
    expect(score.targetsComplete).toBe(0)
    expect(score.targetsAttempted).toBe(20)
    expect(score.perTarget.every((t) => t.featuresIdentified === 3)).toBe(true)
  })

  it('enforces the time limit without hiding what was found', () => {
    const inTime = NIST_OPEN_LANE.targets.slice(0, 10).flatMap((target) =>
      [0, 1].map((f) => event(target.id, f, 100)))
    const late = NIST_OPEN_LANE.targets.slice(10).flatMap((target) =>
      [0, 1].map((f) => event(target.id, f, LANE_TIME_LIMIT_SEC + 30)))

    const score = scoreLane(NIST_OPEN_LANE, [...inTime, ...late], LANE_TIME_LIMIT_SEC + 60)
    expect(score.score).toBe(20)
    // Late work is reported, not silently discarded — a trainee who ran over should see why.
    expect(score.featuresRejectedLate).toBe(20)
    expect(score.withinTimeLimit).toBe(false)

    // Exactly at the limit still counts.
    expect(scoreLane(NIST_OPEN_LANE, [event(NIST_OPEN_LANE.targets[0].id, 0, LANE_TIME_LIMIT_SEC)], 10).score).toBe(1)
  })

  it('is idempotent and ignores foreign or malformed events', () => {
    const target = NIST_OPEN_LANE.targets[0].id
    const events = [
      event(target, 0, 10),
      event(target, 0, 20),            // duplicate feature — counted once
      event('not-a-target', 0, 10),    // different lane's target
      event(target, 99, 10),           // out-of-range feature index
      { ...event(target, 1, 10), eventType: 'waypoint_reached' } as MissionEvent, // wrong type
    ]
    const score = scoreLane(NIST_OPEN_LANE, events, 100)
    expect(score.score).toBe(1)
    expect(score.perTarget[0].featuresIdentified).toBe(1)
    // Folding the same events again yields the same score — replay safety.
    expect(scoreLane(NIST_OPEN_LANE, events, 100)).toEqual(score)
  })

  it('an empty run scores zero rather than failing', () => {
    const score = scoreLane(NIST_OPEN_LANE, [], 0)
    expect(score.score).toBe(0)
    expect(score.targetsAttempted).toBe(0)
    expect(score.standardRef).toMatch(/NIST/)
  })

  it('carries its citation, so a score is never a bare number', () => {
    for (const lane of allLanes()) {
      expect(lane.standardRef).toMatch(/NIST/)
      expect(lane.standardRef).toMatch(/NFPA 2400/)
      expect(lane.standardRef).toMatch(/ASTM F38\.03/)
    }
  })
})

describe('lane scenarios are registered and well-formed', () => {
  it('ships an open and an obstructed lane in the catalog', () => {
    expect(NIST_LANE_SCENARIOS).toHaveLength(2)
    for (const scenario of NIST_LANE_SCENARIOS) {
      expect(ALL_SCENARIOS.some((s) => s.id === scenario.id)).toBe(true)
      expect(scenario.description).toMatch(/SIMULATION ONLY/)
    }
    expect(allLanes().map((l) => l.kind).sort()).toEqual(['obstructed', 'open'])
  })

  it('binds each lane to its scenario and nothing else', () => {
    expect(laneForScenario('nist_open_lane')?.id).toBe('nist-open-lane')
    expect(laneForScenario('nist_obstructed_lane')?.kind).toBe('obstructed')
    // Ordinary scenarios are not lane trials and must not acquire a score.
    expect(laneForScenario('demo_wildfire')).toBeUndefined()
    expect(laneForScenario(undefined)).toBeUndefined()
  })

  it('lays out 20 unique, adequately separated targets per lane', () => {
    for (const lane of allLanes()) {
      expect(lane.targets).toHaveLength(20)
      expect(new Set(lane.targets.map((t) => t.id)).size).toBe(20)

      // No two targets within the finest feature's range, so one hover cannot sweep two targets'
      // fine detail — the trial has to be flown.
      const finest = Math.min(...featureRangesM())
      for (let i = 0; i < lane.targets.length; i += 1) {
        for (let j = i + 1; j < lane.targets.length; j += 1) {
          const a = lane.targets[i].position
          const b = lane.targets[j].position
          const dLat = (a.lat - b.lat) * 111_320
          const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
          expect(Math.hypot(dLat, dLng)).toBeGreaterThan(finest * 2)
        }
      }
    }
  })

  it('gives the trial enough battery to reach the time limit', () => {
    // NIST sets the limit so a trial fits one charge; a scenario that dies at 12 minutes would
    // make the battery, not the clock, the binding constraint.
    for (const scenario of NIST_LANE_SCENARIOS) {
      const enduranceSec = scenario.batteryStartPct / scenario.batteryDrainRatePerSec
      expect(enduranceSec).toBeGreaterThan(LANE_TIME_LIMIT_SEC)
    }
  })

  it('briefs cruise above the finest feature, so the last point must be bought with a descent', () => {
    const finest = Math.min(...featureRangesM())
    for (const scenario of NIST_LANE_SCENARIOS) {
      expect(scenario.waypoints.length).toBeGreaterThan(0)
      for (const waypoint of scenario.waypoints) {
        expect(waypoint.altitudeFt * 0.3048).toBeGreaterThan(finest)
      }
    }
  })

  it('routes each lane the way its kind requires', () => {
    // The open lane overflies every target...
    const open = NIST_LANE_SCENARIOS.find((s) => s.id === 'nist_open_lane')!
    expect(open.waypoints).toHaveLength(NIST_OPEN_LANE.targets.length)

    // ...but the obstructed lane must NOT. An aircraft directly above a target always has line of
    // sight, so an overflight route would make terrain masking unobservable and the obstructed
    // lane would score identically to the open one. It flies a transect instead.
    const obstructed = NIST_LANE_SCENARIOS.find((s) => s.id === 'nist_obstructed_lane')!
    const lane = laneForScenario('nist_obstructed_lane')!
    expect(obstructed.waypoints.length).toBeLessThan(lane.targets.length)
    for (const waypoint of obstructed.waypoints) {
      const overhead = lane.targets.some((t) =>
        Math.abs(t.position.lat - waypoint.position.lat) < 1e-6
        && Math.abs(t.position.lng - waypoint.position.lng) < 1e-6)
      expect(overhead).toBe(false)
    }

    // Every target still sits inside the largest feature's acuity range of the transect, so a
    // miss is always terrain's doing and never simply distance.
    const reach = Math.max(...featureRangesM())
    for (const target of lane.targets) {
      const nearest = Math.min(...obstructed.waypoints.map((w) => {
        const dLat = (target.position.lat - w.position.lat) * 111_320
        const dLng = (target.position.lng - w.position.lng) * 111_320
          * Math.cos((target.position.lat * Math.PI) / 180)
        return Math.hypot(dLat, dLng)
      }))
      expect(nearest).toBeLessThan(reach)
    }
  })
})
