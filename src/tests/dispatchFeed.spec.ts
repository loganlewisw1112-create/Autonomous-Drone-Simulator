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

  it('includes multi-agency dispatch categories for Harvey TFR scenario', () => {
    const harvey = ALL_SCENARIOS.find((s) => s.id === 'hist_harvey_houston_2017')
    expect(harvey).toBeTruthy()
    if (!harvey) return

    const feed = buildMissionStatusFeed({ scenario: harvey, elapsedSec: 120, events: [], drones: [], thermalDetections: [] })
    const categories = new Set(feed.map((entry) => entry.category))
    const sources = new Set(feed.map((entry) => entry.source))

    expect([...categories]).toEqual(expect.arrayContaining(['dispatch', 'field_unit', 'operator_task', 'agency_update', 'safety']))
    expect(sources.has('ICP')).toBe(true)
    expect(sources.has('FEMA LIAISON')).toBe(true)
  })

  it('categorizes live operator commands as operator task feed entries', () => {
    const feed = buildMissionStatusFeed({
      scenario,
      elapsedSec: 130,
      drones: [drone],
      thermalDetections: [],
      events: [event('operator_command', 'uav-01', 100, { command: 'deep_scan' })],
    })

    expect(feed).toContainEqual(expect.objectContaining({
      source: 'OPERATOR',
      category: 'operator_task',
      message: 'UAV-01 received operator command: deep scan.',
    }))
  })

  it('narrates fleet retasks as Route Advisor decision support', () => {
    const feed = buildMissionStatusFeed({
      scenario,
      elapsedSec: 130,
      drones: [drone],
      thermalDetections: [],
      events: [event('operator_command', 'uav-01', 100, {
        command: 'set_route',
        source: 'fleet_retask',
        tacticalAction: 'deep_scan',
        objectiveId: 'contact-alpha',
      })],
    })

    expect(feed).toContainEqual(expect.objectContaining({
      source: 'ROUTE ADVISOR',
      category: 'operator_task',
      message: 'UAV-01 Route Advisor decision support: deep scan for objective contact-alpha.',
    }))
    expect(feed.some((entry) => entry.message.includes('received operator command'))).toBe(false)
  })

  it('names recharge station labels in derived recharge updates when stations exist', () => {
    const maritime = ALL_SCENARIOS.find((s) => s.id === 'train_uscg_maritime_sar')
    expect(maritime).toBeTruthy()
    if (!maritime) return

    const feed = buildMissionStatusFeed({
      scenario: maritime,
      elapsedSec: 160,
      drones: [drone],
      thermalDetections: [],
      events: [
        event('recharge_start', 'uav-01', 150, {
          sortieNum: 2,
          rechargeStationLabel: 'Forward staging recharge',
        }),
      ],
    })

    expect(feed.some((entry) => entry.message.includes('Forward staging recharge'))).toBe(true)
  })
})

