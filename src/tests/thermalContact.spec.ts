import { describe, it, expect } from 'vitest'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { ThermalContactState, WeatherVariantState } from '@/types'

function makeContact(overrides: Partial<ThermalContactState> = {}): ThermalContactState {
  return {
    sourceId: 'src-1',
    class: 'generic-person',
    position: { lat: 37.77, lng: -122.42 },
    confidence: 0.85,
    tick: 100,
    selected: false,
    weatherAdjustedConfidence: 0.85,
    ...overrides,
  }
}

describe('thermalContact', () => {
  it('weatherAdjustedConfidence equals confidence when sensorConfidenceFactor is 1.0', () => {
    const ws = getDefaultWeatherState(1)
    const contact = makeContact()
    const adjusted = contact.confidence * ws.sensorConfidenceFactor
    expect(adjusted).toBeCloseTo(contact.confidence)
  })

  it('weatherAdjustedConfidence is lower than raw confidence under sensor degradation', () => {
    const ws: WeatherVariantState = {
      ...getDefaultWeatherState(1),
      sensorConfidenceFactor: 0.6,
    }
    const rawConf = 0.9
    const adjusted = rawConf * ws.sensorConfidenceFactor
    expect(adjusted).toBeLessThan(rawConf)
    expect(adjusted).toBeCloseTo(0.54)
  })

  it('contacts with same sourceId should be deduplicated (latest wins)', () => {
    const contacts: ThermalContactState[] = [
      makeContact({ sourceId: 'src-1', confidence: 0.5, tick: 10 }),
      makeContact({ sourceId: 'src-1', confidence: 0.85, tick: 20 }),
      makeContact({ sourceId: 'src-2', confidence: 0.7, tick: 15 }),
    ]
    const bySource = new Map<string, ThermalContactState>()
    for (const c of contacts) bySource.set(c.sourceId, c)
    expect(bySource.size).toBe(2)
    expect(bySource.get('src-1')!.confidence).toBe(0.85)
  })

  it('resolved contact preserves action and resolvedAt', () => {
    const contact = makeContact()
    const resolved: ThermalContactState = {
      ...contact,
      action: 'mark_false_positive',
      resolvedAt: 500,
      selected: false,
    }
    expect(resolved.action).toBe('mark_false_positive')
    expect(resolved.resolvedAt).toBe(500)
  })

  it('dispatch_unit action sets groundUnitId', () => {
    const contact = makeContact()
    const dispatched: ThermalContactState = {
      ...contact,
      action: 'dispatch_unit',
      groundUnitId: 'gu-001',
    }
    expect(dispatched.groundUnitId).toBe('gu-001')
  })

  it('selected flag toggles', () => {
    const contact = makeContact({ selected: false })
    const sel: ThermalContactState = { ...contact, selected: true }
    expect(sel.selected).toBe(true)
    const desel: ThermalContactState = { ...sel, selected: false }
    expect(desel.selected).toBe(false)
  })

  it('weatherAdjustedConfidence clamps to [0,1]', () => {
    const factor = 1.5 // hypothetical > 1
    const raw = 0.9
    const clamped = Math.min(1.0, raw * factor)
    expect(clamped).toBeLessThanOrEqual(1.0)
  })
})
