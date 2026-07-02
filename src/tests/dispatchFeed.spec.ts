import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { buildMissionStatusFeed } from '@/sim/mission/dispatchFeed'
import type { DroneState, MissionEvent } from '@/types'

const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_sar_coastal') ?? ALL_SCENARIOS[0]

function event(eventType: MissionEvent['eventType'], droneId: string, tick: number, payload: Record<string, unknown> = {}): MissionEvent {
  return {
    tick,
    timestamp: 1_700_000_000_000 + tick,
    droneId,
    operatorId: 'operator-1',
    role: 'pic',
    eventType,
    payload,
    prevHash: '0'.repeat(64),
    hash: `${eventType}-${droneId}-${tick}`.padEnd(64, '0').slice(0, 64),
  }
}

const drone: DroneState = {
  id: 'uav-01',
  label: 'UAV-01',
  color: '#00d4ff',
  position: { lat: 37.7712, lng: -122.5109 },
  altitudeFt: 100,
  headingDeg: 0,
  speedMs: 0,
  batteryPct: 80,
  signalDbm: -55,
  missionState: 'navigate',
  currentWaypointIndex: 0,
  conflictFlag: false,
  geofenceBreachFlag: false,
  bvlosFlag: false,
  sortieCount: 0,
}

describe('mission status feed builder', () => {
  it('shows authored dispatch entries only when due', () => {
    const early = buildMissionStatusFeed({ scenario, elapsedSec: 0, events: [], drones: [], thermalDetections: [] })
    const later = buildMissionStatusFeed({ scenario, elapsedSec: 120, events: [], drones: [], thermalDetections: [] })

    expect(early.some((e) => e.kind === 'authored')).toBe(true)
    expect(later.length).toBeGreaterThan(early.length)
  })

  it('translates derived events into operational dispatch copy and dedupes repeats', () => {
    const feed = buildMissionStatusFeed({
      scenario,
      elapsedSec: 130,
      drones: [drone],
      thermalDetections: [{ sourceId: 'hs-swim-a', class: 'generic-person', position: drone.position, confidence: 0.76, tick: 100 }],
      events: [
        event('thermal_detection', 'uav-01', 100, { sourceId: 'hs-swim-a', confidence: 76 }),
        event('thermal_detection', 'uav-01', 101, { sourceId: 'hs-swim-a', confidence: 77 }),
        event('rtb_triggered', 'uav-01', 120, { reason: 'operator_command' }),
      ],
    })

    expect(feed.some((e) => e.source.includes('UAV-01') && e.message.includes('thermal contact'))).toBe(true)
    expect(feed.filter((e) => e.message.includes('thermal contact'))).toHaveLength(1)
    expect(feed.some((e) => e.message.includes('return-to-base'))).toBe(true)
  })

  it('returns a safe standby feed when no scenario is loaded', () => {
    expect(buildMissionStatusFeed({ scenario: null, elapsedSec: 0, events: [], drones: [], thermalDetections: [] })).toEqual([])
  })

  it('includes local dispatch, field-unit status, and operator-task categories for SF pursuit', () => {
    const sfPursuit = ALL_SCENARIOS.find((s) => s.id === 'extreme_multiagency_sf_pursuit')
    expect(sfPursuit).toBeTruthy()
    if (!sfPursuit) return

    const feed = buildMissionStatusFeed({ scenario: sfPursuit, elapsedSec: 180, events: [], drones: [], thermalDetections: [] })
    const categories = new Set(feed.map((entry) => entry.category))
    const sources = new Set(feed.map((entry) => entry.source))
    const messages = feed.map((entry) => entry.message).join('\n')

    expect([...categories]).toEqual(expect.arrayContaining(['dispatch', 'field_unit', 'operator_task', 'agency_update', 'safety']))
    expect(sources.has('SFPD DISPATCH')).toBe(true)
    expect(sources.has('OPD DISPATCH')).toBe(true)
    expect(messages).toMatch(/officer|unit|ground team|on scene|en route/i)
    expect(messages).toMatch(/OPERATOR TASK: move UAV-05 to I-580 hold point/i)
  })

  it('categorizes live operator commands as operator task feed entries', () => {
    const feed = buildMissionStatusFeed({
      scenario,
      elapsedSec: 130,
      drones: [drone],
      thermalDetections: [],
      events: [event('operator_command', 'uav-01', 100, { command: 'deep_scan' })],
    })

    expect(feed.some((entry) => entry.category === 'operator_task' && entry.message.includes('deep scan'))).toBe(true)
  })

  it('names Rio Grande roadside recharge stations in derived recharge updates', () => {
    const rioGrande = ALL_SCENARIOS.find((s) => s.id === 'extreme_cbp_rio_grande_longrange')
    expect(rioGrande).toBeTruthy()
    if (!rioGrande) return

    const feed = buildMissionStatusFeed({
      scenario: rioGrande,
      elapsedSec: 160,
      drones: [drone],
      thermalDetections: [],
      events: [
        event('rtb_triggered', 'uav-03', 130, {
          reason: 'low_battery',
          rechargeStationId: 'rg-rs-rgc-us83',
          rechargeStationLabel: 'Rio Grande City / US-83 Recharge',
        }),
        event('recharge_start', 'uav-03', 150, {
          sortieNum: 3,
          rechargeStationId: 'rg-rs-rgc-us83',
          rechargeStationLabel: 'Rio Grande City / US-83 Recharge',
        }),
      ],
    })

    expect(feed.some((entry) =>
      entry.source === 'UAV-03' &&
      entry.message.includes('Rio Grande City / US-83 Recharge')
    )).toBe(true)
    expect(feed.some((entry) =>
      entry.message.includes('diverting to Rio Grande City / US-83 Recharge')
    )).toBe(true)
  })
})

