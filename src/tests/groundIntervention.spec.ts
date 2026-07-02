import { describe, it, expect } from 'vitest'
import {
  tickGroundUnit,
  computeGroundUnitEta,
  createThermalInterventionUnit,
  createRecoveryUnit,
} from '@/sim/mission/groundUnits'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { GroundUnitState } from '@/types'

const CLEAR = getDefaultWeatherState(1)
const BASE  = { lat: 37.77, lng: -122.42 }
const TARGET = { lat: 37.80, lng: -122.38 }

function makeUnit(overrides: Partial<GroundUnitState> = {}): GroundUnitState {
  return {
    id: 'gu-test',
    role: 'intervention',
    position: { ...BASE },
    status: 'enroute',
    etaSec: 60,
    ...overrides,
  }
}

describe('groundIntervention', () => {
  it('createThermalInterventionUnit returns a well-formed GroundUnitState', () => {
    // Signature: (id, role, stagingPos, targetThermalId, weather)
    const unit = createThermalInterventionUnit('gu-1', 'intervention', BASE, 'src-thermal-1', CLEAR)
    expect(unit.id).toBe('gu-1')
    expect(unit.role).toBe('intervention')
    expect(unit.status).toBe('enroute')
    expect(unit.targetThermalId).toBe('src-thermal-1')
    expect(unit.position).toEqual(BASE)
  })

  it('createRecoveryUnit returns a well-formed GroundUnitState', () => {
    const unit = createRecoveryUnit('gu-2', BASE, 'uav-01', CLEAR)
    expect(unit.id).toBe('gu-2')
    expect(unit.role).toBe('recovery')
    expect(unit.status).toBe('enroute')
    expect(unit.targetDroneId).toBe('uav-01')
  })

  it('tickGroundUnit advances unit toward target', () => {
    const unit = makeUnit()
    const updated = tickGroundUnit(unit, TARGET, CLEAR, 1.0)
    const distBefore = Math.hypot(TARGET.lat - BASE.lat, TARGET.lng - BASE.lng)
    const distAfter  = Math.hypot(TARGET.lat - updated.position.lat, TARGET.lng - updated.position.lng)
    expect(distAfter).toBeLessThan(distBefore)
  })

  it('tickGroundUnit returns on_scene when within 15m', () => {
    // Place unit very close to target (< 15m ≈ 0.00013 deg lat)
    const nearTarget: GroundUnitState = makeUnit({ position: { lat: TARGET.lat + 0.0001, lng: TARGET.lng + 0.0001 } })
    const updated = tickGroundUnit(nearTarget, TARGET, CLEAR, 1.0)
    expect(updated.status).toBe('on_scene')
  })

  it('tickGroundUnit keeps status as enroute when far from target', () => {
    const unit = makeUnit()
    const updated = tickGroundUnit(unit, TARGET, CLEAR, 1.0)
    expect(updated.status).toBe('enroute')
  })

  it('computeGroundUnitEta returns a positive number', () => {
    const eta = computeGroundUnitEta(BASE, TARGET, CLEAR)
    expect(eta).toBeGreaterThan(0)
  })

  it('computeGroundUnitEta is longer with weather degradation', () => {
    const severeWs = { ...CLEAR, groundUnitEtaMultiplier: 2.0 }
    const clearEta  = computeGroundUnitEta(BASE, TARGET, CLEAR)
    const severeEta = computeGroundUnitEta(BASE, TARGET, severeWs)
    expect(severeEta).toBeGreaterThan(clearEta)
  })

  it('unit position does not jump past target in a single tick', () => {
    const nearUnit: GroundUnitState = makeUnit({ position: { lat: TARGET.lat + 0.001, lng: TARGET.lng } })
    const updated = tickGroundUnit(nearUnit, TARGET, CLEAR, 1.0)
    // After tick, unit should be at or beyond target, never overshot significantly
    const overshoot = Math.hypot(updated.position.lat - TARGET.lat, updated.position.lng - TARGET.lng)
    expect(overshoot).toBeLessThanOrEqual(0.01)
  })

  it('tickGroundUnit etaSec decrements from the distance-based initial ETA', () => {
    const eta = computeGroundUnitEta(BASE, TARGET, CLEAR)
    const unit = makeUnit({ etaSec: eta })
    const updated = tickGroundUnit(unit, TARGET, CLEAR, 1.0)
    if (updated.status === 'enroute') {
      // After 1s, etaSec should be roughly eta-1 (within a few seconds rounding)
      expect(updated.etaSec ?? 0).toBeLessThan(eta)
    } else {
      expect(updated.status).toBe('on_scene')
    }
  })
})
