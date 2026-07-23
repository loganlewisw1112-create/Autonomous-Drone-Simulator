import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearGustFieldCache,
  drydenSeries,
  exceedsGustLimit,
  gustAtTick,
  gustFieldCacheSize,
  lowAltitudeDryden,
  normalizedGustSeries,
} from '@/sim/weather/dryden'
import {
  flightLoadFactor,
  isAtVoltageReserve,
  modelledDrainRatePerSec,
  reserveBatteryPct,
  RESERVE_CELL_V,
  stepDrone,
  type FlightEnvironment,
} from '@/sim/drone/DroneEntity'
import { PLATFORM_CATALOG, type PlatformId } from '@/sim/drone/platformCatalog'
import type { DroneState } from '@/types'

// REALISM_ROADMAP WP-10 (Dryden live wiring) and WP-11 (discharge curve live wiring).

const PLATFORM_IDS = Object.keys(PLATFORM_CATALOG) as PlatformId[]
const X10 = PLATFORM_CATALOG.skydio_x10

function drone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#fff',
    position: { lat: 37.9, lng: -122.24 },
    altitudeFt: 200, headingDeg: 0, speedMs: 0, batteryPct: 100, signalDbm: -55,
    missionState: 'hover', currentWaypointIndex: 0,
    conflictFlag: false, geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
    ...overrides,
  }
}

const STILL_20C: FlightEnvironment = { tempC: 20, windMs: 0, gustMs: 0 }

describe('WP-10 Dryden turbulence, live', () => {
  beforeEach(() => clearGustFieldCache())

  it('is reproducible from the seed and pure in the tick index', () => {
    const a = gustAtTick(5005, 'uav-01', 400, 8, 200)
    const b = gustAtTick(5005, 'uav-01', 400, 8, 200)
    expect(b).toBe(a)

    // Reaching tick 400 after touching other ticks cannot change it — this is what makes
    // sub-stepping and replay safe, and it is the whole reason the AR(1) is not stepped live.
    for (let t = 0; t < 400; t += 1) gustAtTick(5005, 'uav-01', t, 8, 200)
    expect(gustAtTick(5005, 'uav-01', 400, 8, 200)).toBe(a)

    // A cold cache reproduces a warm one bit-for-bit.
    clearGustFieldCache()
    expect(gustFieldCacheSize()).toBe(0)
    expect(gustAtTick(5005, 'uav-01', 400, 8, 200)).toBe(a)
  })

  it('gives every aircraft and every seed its own gust history', () => {
    const base = gustAtTick(5005, 'uav-01', 250, 8, 200)
    expect(gustAtTick(5005, 'uav-02', 250, 8, 200)).not.toBe(base)
    expect(gustAtTick(9001, 'uav-01', 250, 8, 200)).not.toBe(base)
  })

  it('gust magnitude falls with altitude per the MIL-F-8785C gradient', () => {
    // The accept criterion. σ_u = σ_w / (0.177 + 0.000823h)^0.4 decreases with h.
    const low = lowAltitudeDryden(10, 50)
    const high = lowAltitudeDryden(10, 800)
    expect(high.sigmaMs).toBeLessThan(low.sigmaMs)
    // Length scale grows with altitude.
    expect(high.lengthScaleM).toBeGreaterThan(low.lengthScaleM)

    // And that shows up in the live gust: RMS over a long window must fall with altitude.
    const rms = (altFt: number) => {
      let sum = 0
      for (let t = 0; t < 6000; t += 1) sum += gustAtTick(5005, 'uav-01', t, 10, altFt) ** 2
      return Math.sqrt(sum / 6000)
    }
    expect(rms(800)).toBeLessThan(rms(50))
    // Calm air produces no gusts at all rather than a floor.
    expect(gustAtTick(5005, 'uav-01', 100, 0, 200)).toBe(0)
  })

  it('scales linearly with wind, because only σ is live', () => {
    const single = gustAtTick(5005, 'uav-01', 321, 5, 200)
    const double = gustAtTick(5005, 'uav-01', 321, 10, 200)
    expect(double).toBeCloseTo(single * 2, 9)
  })

  it('the cached shape is unit-variance and genuinely Dryden', () => {
    const series = normalizedGustSeries(5005, 'uav-01')
    const mean = series.reduce((s, v) => s + v, 0) / series.length
    const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length

    // Steady-state variance of the AR(1) is σ² = 1 by construction, and that IS tight.
    expect(variance).toBeGreaterThan(0.85)
    expect(variance).toBeLessThan(1.15)

    // The mean is only loosely bounded, and deliberately so. The filter's correlation time is
    // ~20 s, so 30 minutes of samples is only ~90 INDEPENDENT ones — the standard error of the
    // mean is ~0.1, not ~0.005. Demanding a tighter mean would be demanding that correlated
    // turbulence behave like white noise, and would fail on a correct implementation.
    expect(Math.abs(mean)).toBeLessThan(0.4)

    // Successive samples are correlated — turbulence, not white noise.
    let cov = 0
    for (let i = 1; i < series.length; i += 1) cov += (series[i] - mean) * (series[i - 1] - mean)
    expect(cov / (series.length - 1) / variance).toBeGreaterThan(0.5)

    // Same seed still reproduces the underlying generator exactly.
    const cfg = { sigmaMs: 1, lengthScaleM: 200, airspeedMs: 10, dtSec: 0.05 }
    expect(drydenSeries(42, cfg, 50)).toEqual(drydenSeries(42, cfg, 50))
  })

  it('exceeding the published gust tolerance is an abort condition', () => {
    // The accept criterion, at the model level; the loop turns this into a weather_divert.
    expect(exceedsGustLimit(5, 2, X10.gustToleranceMs)).toBe(false)
    expect(exceedsGustLimit(11, 3, X10.gustToleranceMs)).toBe(true)
    // Direction does not matter — a downward gust is just as much load.
    expect(exceedsGustLimit(11, -3, X10.gustToleranceMs)).toBe(true)
    // Every platform carries a real published tolerance above its sustained wind limit.
    for (const id of PLATFORM_IDS) {
      const p = PLATFORM_CATALOG[id]
      expect(p.gustToleranceMs).toBeGreaterThanOrEqual(p.windToleranceMs)
    }
  })
})

describe('WP-11 battery discharge, live', () => {
  it('reproduces every published endurance within 5% at 20 °C in still air', () => {
    // The accept criterion, measured against WP-1's sourced specs.
    for (const id of PLATFORM_IDS) {
      const platform = PLATFORM_CATALOG[id]
      const rate = modelledDrainRatePerSec(0, platform, STILL_20C)
      const enduranceMin = 100 / rate / 60
      const error = Math.abs(enduranceMin - platform.enduranceMin) / platform.enduranceMin
      expect(error).toBeLessThan(0.05)
    }
  })

  it('cold weather reduces endurance, monotonically', () => {
    const at = (tempC: number) => 100 / modelledDrainRatePerSec(0, X10, { ...STILL_20C, tempC }) / 60
    expect(at(-10)).toBeLessThan(at(0))
    expect(at(0)).toBeLessThan(at(10))
    expect(at(10)).toBeLessThan(at(20))
    // Room temperature is the published reference, so it is not derated.
    expect(at(20)).toBeCloseTo(X10.enduranceMin, 6)
    // A cold-weather scenario is materially shorter, not marginally.
    expect(at(-10) / at(20)).toBeLessThan(0.85)
  })

  it('speed and turbulence raise the burn rate — WP-10 reaching the operator', () => {
    const still = modelledDrainRatePerSec(0, X10, STILL_20C)
    const fast = modelledDrainRatePerSec(X10.maxSpeedMs, X10, STILL_20C)
    const gusty = modelledDrainRatePerSec(0, X10, { tempC: 20, windMs: 8, gustMs: 4 })

    expect(fast).toBeGreaterThan(still)
    expect(gusty).toBeGreaterThan(still)
    // Load factor is 1.0 exactly in the published condition, so nothing is silently penalised.
    expect(flightLoadFactor(0, X10, STILL_20C)).toBe(1)
    expect(flightLoadFactor(X10.maxSpeedMs, X10, { tempC: 20, windMs: 20, gustMs: 10 }))
      .toBeGreaterThan(1.5)
  })

  it('the voltage knee triggers the reserve earlier than a linear percentage gate', () => {
    // WP-11's stated accept criterion. A linear gate calls reserve at 25% remaining; the OCV
    // knee means the pack is already at its reserve VOLTAGE well above that.
    const reservePct = reserveBatteryPct()
    expect(reservePct).toBeGreaterThan(25)

    const low = stepDrone(drone({ batteryPct: reservePct + 5 }), {}, 0.05, X10, STILL_20C)
    const atReserve = stepDrone(drone({ batteryPct: reservePct - 5 }), {}, 0.05, X10, STILL_20C)
    expect(isAtVoltageReserve(low)).toBe(false)
    expect(isAtVoltageReserve(atReserve)).toBe(true)
    expect(atReserve.cellVoltageV!).toBeLessThanOrEqual(RESERVE_CELL_V)
  })

  it('reports pack voltage and the gust being fought once the environment is supplied', () => {
    const stepped = stepDrone(drone(), {}, 0.05, X10, { tempC: 20, windMs: 6, gustMs: 2.5 })
    expect(stepped.cellVoltageV).toBeGreaterThan(3)
    expect(stepped.cellVoltageV).toBeLessThan(4.3)
    expect(stepped.packVoltageV).toBeCloseTo(stepped.cellVoltageV! * 4, 9)
    expect(stepped.gustMs).toBe(2.5)
    // Voltage falls as the pack drains.
    const drained = stepDrone(drone({ batteryPct: 20 }), {}, 0.05, X10, STILL_20C)
    expect(drained.cellVoltageV!).toBeLessThan(stepped.cellVoltageV!)
  })

  it('leaves the legacy linear path untouched when no environment is supplied', () => {
    // Backward compatibility is the reason the whole catalog did not need re-tuning: callers
    // that have not opted in behave exactly as before and report no modelled voltage.
    const legacy = stepDrone(drone(), { batteryDrainRatePerSec: 0.05 }, 1, X10)
    expect(legacy.batteryPct).toBeCloseTo(99.95, 9)
    expect(legacy.cellVoltageV).toBeUndefined()
    expect(legacy.packVoltageV).toBeUndefined()
    // And the reserve check falls back to the linear gate for those aircraft.
    expect(isAtVoltageReserve(drone({ batteryPct: 30 }))).toBe(false)
    expect(isAtVoltageReserve(drone({ batteryPct: 20 }))).toBe(true)
  })

  it('never drains a recharging aircraft', () => {
    const charging = stepDrone(drone({ missionState: 'recharge', batteryPct: 40 }), {}, 1, X10, STILL_20C)
    expect(charging.batteryPct).toBe(40)
  })
})
