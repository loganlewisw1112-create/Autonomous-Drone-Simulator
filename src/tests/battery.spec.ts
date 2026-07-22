import { describe, it, expect } from 'vitest'
import {
  ocvFromSoc,
  terminalVoltage,
  capacityTempMultiplier,
  enduranceMinutes,
  reserveSocForVoltage,
  CELL_FULL_V,
  CELL_CUTOFF_V,
} from '@/sim/drone/battery'
import { PLATFORM_CATALOG, LEGACY_PLATFORM } from '@/sim/drone/platformCatalog'

describe('battery discharge model (WP-11)', () => {
  it('OCV is monotonic increasing across the full SoC range', () => {
    let prev = -Infinity
    for (let s = 0; s <= 1; s += 0.05) {
      const v = ocvFromSoc(s)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
    expect(ocvFromSoc(1)).toBeCloseTo(CELL_FULL_V, 5)
    expect(ocvFromSoc(0)).toBeCloseTo(CELL_CUTOFF_V, 5)
  })

  it('has a low-SoC voltage knee — steeper below 20% than in the mid band', () => {
    const kneeSlope = (ocvFromSoc(0.2) - ocvFromSoc(0.0)) / 0.2
    const midSlope = (ocvFromSoc(0.7) - ocvFromSoc(0.5)) / 0.2
    expect(kneeSlope).toBeGreaterThan(midSlope * 2)
  })

  it('clamps SoC out of range', () => {
    expect(ocvFromSoc(-1)).toBeCloseTo(CELL_CUTOFF_V, 5)
    expect(ocvFromSoc(2)).toBeCloseTo(CELL_FULL_V, 5)
  })

  it('temperature derate is 1.0 in the reference band and drops in the cold', () => {
    expect(capacityTempMultiplier(20)).toBe(1)
    expect(capacityTempMultiplier(25)).toBe(1)
    expect(capacityTempMultiplier(0)).toBeLessThan(1)
    expect(capacityTempMultiplier(-10)).toBeLessThan(capacityTempMultiplier(0))
    // monotonic decreasing as it gets colder below the reference band
    let warmer = capacityTempMultiplier(19)
    for (let t = 18; t >= -20; t -= 2) {
      const colder = capacityTempMultiplier(t)
      expect(colder).toBeLessThanOrEqual(warmer)
      warmer = colder
    }
  })

  it('reproduces published endurance within 5% at 20C, still air, for every platform', () => {
    for (const spec of [...Object.values(PLATFORM_CATALOG), LEGACY_PLATFORM]) {
      const modelled = enduranceMinutes({ publishedMin: spec.enduranceMin, tempC: 20, loadFactor: 1 })
      const relErr = Math.abs(modelled - spec.enduranceMin) / spec.enduranceMin
      expect(relErr).toBeLessThanOrEqual(0.05)
    }
  })

  it('cold weather and heavier load both reduce endurance', () => {
    const base = enduranceMinutes({ publishedMin: 40, tempC: 20, loadFactor: 1 })
    expect(enduranceMinutes({ publishedMin: 40, tempC: -5, loadFactor: 1 })).toBeLessThan(base)
    expect(enduranceMinutes({ publishedMin: 40, tempC: 20, loadFactor: 1.4 })).toBeLessThan(base)
  })

  it('voltage-aware reserve fires earlier (higher SoC) under load than at rest', () => {
    const reserveVolts = 3.6
    const rested = reserveSocForVoltage(reserveVolts, 0)
    const underLoad = reserveSocForVoltage(reserveVolts, 0.15)
    expect(underLoad).toBeGreaterThan(rested)
    // and both are a meaningful reserve, not near-empty
    expect(rested).toBeGreaterThan(0.15)
    expect(terminalVoltage(rested)).toBeGreaterThanOrEqual(reserveVolts)
  })
})
