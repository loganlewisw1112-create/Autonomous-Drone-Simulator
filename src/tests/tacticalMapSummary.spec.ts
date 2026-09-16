import { describe, it, expect } from 'vitest'
import {
  buildTacticalSummary,
  describeDrone,
  compassPoint,
} from '@/components/tacticalMapSummary'
import type { DroneState } from '@/types'

function drone(over: Partial<DroneState> = {}): DroneState {
  return {
    id: 'd1',
    label: 'UAV-01',
    color: '#00d4ff',
    position: { lat: 34.05, lng: -118.24 },
    altitudeFt: 200,
    headingDeg: 90,
    speedMs: 12,
    batteryPct: 80,
    signalDbm: -60,
    missionState: 'navigate',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...over,
  }
}

describe('compassPoint', () => {
  it('maps cardinal and intercardinal headings', () => {
    expect(compassPoint(0)).toBe('north')
    expect(compassPoint(90)).toBe('east')
    expect(compassPoint(180)).toBe('south')
    expect(compassPoint(270)).toBe('west')
    expect(compassPoint(45)).toBe('northeast')
  })
  it('wraps and rounds', () => {
    expect(compassPoint(360)).toBe('north')
    expect(compassPoint(359)).toBe('north')
    expect(compassPoint(-90)).toBe('west')
  })
})

describe('describeDrone', () => {
  it('reports state, altitude, heading, battery, and coordinates for an airborne drone', () => {
    const line = describeDrone(drone({ missionState: 'navigate', altitudeFt: 250, headingDeg: 90, batteryPct: 77 }))
    expect(line).toContain('UAV-01: en route')
    expect(line).toContain('250 feet')
    expect(line).toContain('heading east')
    expect(line).toContain('battery 77 percent')
    expect(line).toContain('34.0500, -118.2400')
  })

  it('omits altitude and heading for idle/landed drones', () => {
    const line = describeDrone(drone({ missionState: 'idle', altitudeFt: 0 }))
    expect(line).toContain('UAV-01: idle')
    expect(line).not.toContain('feet')
    expect(line).not.toContain('heading')
  })

  it('surfaces warning flags in the line', () => {
    const line = describeDrone(drone({ batteryPct: 12, conflictFlag: true, missionState: 'emergency' }))
    expect(line).toContain('low battery')
    expect(line).toContain('traffic conflict')
    expect(line).toContain('EMERGENCY')
  })
})

describe('buildTacticalSummary', () => {
  it('reports no scenario when empty and unnamed', () => {
    const s = buildTacticalSummary({ drones: [] })
    expect(s.headline).toBe('No scenario loaded.')
    expect(s.drones).toEqual([])
    expect(s.alerts).toEqual([])
  })

  it('reports a named scenario with no aircraft', () => {
    const s = buildTacticalSummary({ scenarioName: 'Camp Fire', drones: [] })
    expect(s.headline).toContain('Camp Fire')
    expect(s.headline).toContain('No aircraft')
  })

  it('counts aircraft and airborne aircraft', () => {
    const s = buildTacticalSummary({
      scenarioName: 'Wildfire Flank',
      drones: [
        drone({ id: 'a', label: 'UAV-01', missionState: 'navigate' }),
        drone({ id: 'b', label: 'UAV-02', missionState: 'sar_grid' }),
        drone({ id: 'c', label: 'UAV-03', missionState: 'idle' }),
      ],
    })
    expect(s.headline).toContain('Wildfire Flank')
    expect(s.headline).toContain('3 aircraft, 2 airborne')
    expect(s.drones).toHaveLength(3)
  })

  it('includes active thermal contact count in the headline', () => {
    const s = buildTacticalSummary({ scenarioName: 'X', drones: [drone()], activeThermalContacts: 2 })
    expect(s.headline).toContain('2 active thermal contacts')
  })

  it('singularizes one contact', () => {
    const s = buildTacticalSummary({ scenarioName: 'X', drones: [drone()], activeThermalContacts: 1 })
    expect(s.headline).toContain('1 active thermal contact.')
    expect(s.headline).not.toContain('contacts')
  })

  it('collects per-drone alerts only for drones with warnings', () => {
    const s = buildTacticalSummary({
      scenarioName: 'X',
      drones: [
        drone({ id: 'a', label: 'UAV-01', batteryPct: 90 }),
        drone({ id: 'b', label: 'UAV-02', batteryPct: 15 }),
        drone({ id: 'c', label: 'UAV-03', commsLostSec: 42 }),
      ],
    })
    expect(s.alerts).toHaveLength(2)
    expect(s.alerts.some((a) => a.startsWith('UAV-02') && a.includes('low battery'))).toBe(true)
    expect(s.alerts.some((a) => a.startsWith('UAV-03') && a.includes('link lost'))).toBe(true)
  })
})
