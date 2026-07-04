/**
 * Fixed-timestep accumulator math (audit H2). The rAF driver feeds real frame deltas through
 * advanceAccumulator; physics correctness depends on whole-step counting and on capped
 * catch-up (a stall must pause honestly, never burst the sim forward).
 */
import { describe, it, expect } from 'vitest'
import { advanceAccumulator } from '@/sim/SimulationLoop'

const TICK = 50

describe('advanceAccumulator', () => {
  it('runs one step per full tick interval', () => {
    expect(advanceAccumulator(0, 50, TICK, 4)).toEqual({ steps: 1, remainingMs: 0 })
    expect(advanceAccumulator(0, 100, TICK, 4)).toEqual({ steps: 2, remainingMs: 0 })
  })

  it('carries sub-tick remainders across frames (60fps feeding a 20Hz sim)', () => {
    // Three ~16.7ms frames accumulate to one 50ms step with a small carry.
    let acc = 0
    let totalSteps = 0
    for (let i = 0; i < 3; i++) {
      const r = advanceAccumulator(acc, 16.7, TICK, 4)
      acc = r.remainingMs
      totalSteps += r.steps
    }
    expect(totalSteps).toBe(1)
    expect(acc).toBeCloseTo(0.1, 5)
  })

  it('caps catch-up and drops the excess debt after a long stall (honest pause, no burst)', () => {
    // 5 seconds hidden/stalled: with a cap of 4 the sim must NOT fast-forward 100 steps.
    const r = advanceAccumulator(0, 5000, TICK, 4)
    expect(r.steps).toBe(4)
    expect(r.remainingMs).toBe(0)
  })

  it('keeps sub-cap remainders instead of dropping them', () => {
    // 210ms hiccup: 4 steps (200ms) + 10ms carried — under the cap boundary, nothing dropped.
    const r = advanceAccumulator(0, 210, TICK, 4)
    expect(r.steps).toBe(4)
    expect(r.remainingMs).toBe(10)
  })

  it('ignores negative deltas (clock skew safety)', () => {
    expect(advanceAccumulator(20, -500, TICK, 4)).toEqual({ steps: 0, remainingMs: 20 })
  })
})
