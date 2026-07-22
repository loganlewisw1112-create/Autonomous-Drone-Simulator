import { describe, it, expect } from 'vitest'
import {
  drydenCoefficients,
  drydenSeries,
  lowAltitudeDryden,
  exceedsGustLimit,
  type DrydenConfig,
} from '@/sim/weather/dryden'

const CFG: DrydenConfig = { sigmaMs: 3, lengthScaleM: 20, airspeedMs: 20, dtSec: 0.05 }

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function variance(xs: number[]): number {
  const m = mean(xs)
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length
}
function lag1Autocorr(xs: number[]): number {
  const m = mean(xs)
  let num = 0
  let den = 0
  for (let i = 1; i < xs.length; i++) num += (xs[i] - m) * (xs[i - 1] - m)
  for (let i = 0; i < xs.length; i++) den += (xs[i] - m) ** 2
  return num / den
}

describe('Dryden turbulence (WP-10)', () => {
  it('is deterministic — same seed and config reproduce the series exactly', () => {
    expect(drydenSeries(1337, CFG, 500)).toEqual(drydenSeries(1337, CFG, 500))
  })

  it('a different seed produces a different series', () => {
    expect(drydenSeries(1, CFG, 500)).not.toEqual(drydenSeries(2, CFG, 500))
  })

  it('coefficients: a in [0,1), b > 0, and b scales linearly with σ', () => {
    const { a, b } = drydenCoefficients(CFG)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(1)
    expect(b).toBeGreaterThan(0)
    const doubled = drydenCoefficients({ ...CFG, sigmaMs: CFG.sigmaMs * 2 })
    expect(doubled.b).toBeCloseTo(b * 2, 6)
  })

  it('steady-state variance approximates σ²', () => {
    const series = drydenSeries(20260721, CFG, 40000)
    const target = CFG.sigmaMs ** 2
    const v = variance(series)
    expect(v).toBeGreaterThan(target * 0.8)
    expect(v).toBeLessThan(target * 1.2)
  })

  it('output is temporally correlated (a gust, not white noise)', () => {
    const series = drydenSeries(42, CFG, 40000)
    expect(lag1Autocorr(series)).toBeGreaterThan(0.5)
  })

  it('MIL low-altitude model: intensity falls and length scale grows with altitude', () => {
    const low = lowAltitudeDryden(10, 50)
    const high = lowAltitudeDryden(10, 500)
    expect(high.sigmaMs).toBeLessThan(low.sigmaMs)
    expect(high.lengthScaleM).toBeGreaterThan(low.lengthScaleM)
  })

  it('MIL low-altitude intensity scales linearly with the wind at 20 ft', () => {
    expect(lowAltitudeDryden(10, 100).sigmaMs).toBeCloseTo(lowAltitudeDryden(5, 100).sigmaMs * 2, 6)
  })

  it('gust-limit abort fires when sustained wind + gust exceeds the platform tolerance', () => {
    expect(exceedsGustLimit(10, 5, 12)).toBe(true)
    expect(exceedsGustLimit(8, 2, 12)).toBe(false)
  })
})
