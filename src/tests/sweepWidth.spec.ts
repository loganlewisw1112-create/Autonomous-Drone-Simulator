import { describe, it, expect } from 'vitest'
import {
  sweepWidthM,
  coverage,
  podFromCoverage,
  probabilityOfDetection,
  cumulativePod,
  SWEEP_WIDTH_FACTOR,
} from '@/sim/sensors/sweepWidth'

describe('SAR sweep width and POD (WP-6)', () => {
  it('sweep width is 1.645 × detection radius', () => {
    expect(sweepWidthM(100)).toBeCloseTo(SWEEP_WIDTH_FACTOR * 100, 6)
    expect(sweepWidthM(0)).toBe(0)
  })

  it('reproduces textbook coverage and POD for a known track/area/W', () => {
    // 10 km of track, W = 164.5 m (R_d = 100 m), 1 km² sector → coverage 1.645, POD ≈ 0.807.
    const w = sweepWidthM(100)
    const cov = coverage(10_000, w, 1_000_000)
    expect(cov).toBeCloseTo(1.645, 3)
    expect(podFromCoverage(cov)).toBeCloseTo(1 - Math.exp(-1.645), 6)
    expect(podFromCoverage(cov)).toBeCloseTo(0.807, 2)
  })

  it('POD follows the random-search curve and is clamped to [0,1]', () => {
    expect(podFromCoverage(0)).toBe(0)
    expect(podFromCoverage(1)).toBeCloseTo(1 - 1 / Math.E, 6) // ≈ 0.632
    expect(podFromCoverage(10)).toBeLessThanOrEqual(1)
    expect(podFromCoverage(-5)).toBe(0)
    // monotonic increasing in coverage
    let prev = -1
    for (let c = 0; c <= 5; c += 0.25) {
      const pod = podFromCoverage(c)
      expect(pod).toBeGreaterThanOrEqual(prev)
      prev = pod
    }
  })

  it('POD is 0 when the detection radius is 0 (LOS never achieved)', () => {
    const r = probabilityOfDetection({ detectionRadiusM: 0, trackLengthM: 10_000, sectorAreaM2: 1_000_000 })
    expect(r.pod).toBe(0)
  })

  it('re-sweeping the same sector raises cumulative POD', () => {
    const single = probabilityOfDetection({ detectionRadiusM: 60, trackLengthM: 3_000, sectorAreaM2: 500_000 })
    const twice = cumulativePod([single.pod, single.pod])
    expect(twice).toBeGreaterThan(single.pod)
    expect(twice).toBeCloseTo(1 - (1 - single.pod) ** 2, 6)
  })

  it('handles a degenerate (zero-area) sector without dividing by zero', () => {
    expect(coverage(1000, 100, 0)).toBe(0)
  })
})
