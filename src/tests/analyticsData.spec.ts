import { describe, it, expect } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import {
  UNASSIGNED_PLATFORM_LABEL,
  UNKNOWN_REASON_LABEL,
  buildAggregates,
  buildTimeline,
  completionReasons,
  eventTypeTotals,
  runsByScenario,
  safetyTrend,
  sortiesByPlatform,
} from '@/components/account/analyticsData'
import type { StoredRunSummary } from '@/account/types'
import type { MissionMetrics } from '@/types'

const metrics = (patch: Partial<MissionMetrics> = {}): MissionMetrics => ({
  totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0,
  thermalContacts: 0, geofenceBreaches: 0, rtbTriggers: 0,
  recoveryDispatches: 0, groundUnitDispatch: 0,
  ...patch,
})

/** A modern summary, with every field the upgrade added. */
const modernRun = (patch: Partial<StoredRunSummary> = {}): StoredRunSummary => ({
  scenarioId: 'demo_basic',
  scenarioVariant: {
    seed: 42, timeOfDay: 'day', season: 'summer', weatherSeverity: 0,
    commsDegradation: 0, thermalDensity: 1, batteryPressure: 0, terrainDifficulty: 0,
  },
  completedAt: Date.UTC(2026, 6, 1),
  completionReason: 'all_drones_complete',
  durationSec: 100,
  metrics: metrics(),
  eventCount: 3,
  firstHash: 'a', lastHash: 'b', chainVerified: true,
  droneOutcomes: [
    { id: 'uav-01', missionState: 'landed', batteryPct: 60, platformId: 'skydio_x10' },
    { id: 'uav-02', missionState: 'landed', batteryPct: 55, platformId: 'teal_2' },
  ],
  eventTypeCounts: { mission_start: 1, waypoint_reached: 2 },
  ...patch,
})

/**
 * A summary as recorded BEFORE this upgrade: no platformId on outcomes, no
 * eventTypeCounts, no completionReason. These still decrypt, so every aggregate
 * has to tolerate them.
 */
const legacyRun = (patch: Partial<StoredRunSummary> = {}): StoredRunSummary => {
  const run = modernRun(patch)
  delete run.completionReason
  delete run.eventTypeCounts
  run.droneOutcomes = [
    { id: 'uav-01', missionState: 'landed', batteryPct: 40 },
    { id: 'uav-02', missionState: 'landed', batteryPct: 35 },
  ]
  return run
}

describe('buildAggregates', () => {
  it('returns zeroed aggregates for an empty history without dividing by zero', () => {
    const agg = buildAggregates([])
    expect(agg.total).toBe(0)
    expect(agg.avgDuration).toBe(0)
    expect(agg.distanceKm).toBe(0)
  })

  it('sums the five newly surfaced safety/dispatch metrics', () => {
    const agg = buildAggregates([
      modernRun({ metrics: metrics({ conflictsDetected: 2, geofenceBreaches: 1, rtbTriggers: 3, recoveryDispatches: 1, groundUnitDispatch: 4 }) }),
      modernRun({ metrics: metrics({ conflictsDetected: 5, geofenceBreaches: 2, rtbTriggers: 1, recoveryDispatches: 2, groundUnitDispatch: 1 }) }),
    ])

    expect(agg.conflicts).toBe(7)
    expect(agg.geofenceBreaches).toBe(3)
    expect(agg.rtbTriggers).toBe(4)
    expect(agg.recoveryDispatches).toBe(3)
    expect(agg.groundDispatches).toBe(5)
  })

  it('converts distance to km and averages duration', () => {
    const agg = buildAggregates([
      modernRun({ durationSec: 100, metrics: metrics({ totalFlightDistanceM: 1500 }) }),
      modernRun({ durationSec: 300, metrics: metrics({ totalFlightDistanceM: 500 }) }),
    ])
    expect(agg.distanceKm).toBe(2)
    expect(agg.avgDuration).toBe(200)
  })

  it('counts a run as verified only when it has events AND a verified chain', () => {
    const agg = buildAggregates([
      modernRun({ eventCount: 5, chainVerified: true }),
      modernRun({ eventCount: 0, chainVerified: true }),   // no events — not evidence
      modernRun({ eventCount: 5, chainVerified: false }),
    ])
    expect(agg.verified).toBe(1)
  })
})

describe('runsByScenario', () => {
  it('resolves real scenario names and sorts by frequency', () => {
    const known = ALL_SCENARIOS.find((s) => s.id !== 'demo_basic')!
    const rows = runsByScenario([
      modernRun({ scenarioId: 'demo_basic' }),
      modernRun({ scenarioId: known.id }),
      modernRun({ scenarioId: known.id }),
    ])

    expect(rows[0].scenarioId).toBe(known.id)
    expect(rows[0].count).toBe(2)
    expect(rows[0].label).toBe(known.name)
    expect(rows[0].label).not.toBe(known.id)
  })

  it('falls back to the raw id for a custom mission absent from the catalog', () => {
    const rows = runsByScenario([modernRun({ scenarioId: 'custom-abc123' })])
    expect(rows[0].label).toBe('custom-abc123')
  })
})

describe('sortiesByPlatform', () => {
  it('counts one sortie per drone outcome and labels with the short airframe tag', () => {
    const rows = sortiesByPlatform([modernRun(), modernRun()])
    const x10 = rows.find((r) => r.platformId === 'skydio_x10')
    expect(x10?.sorties).toBe(2)
    expect(x10?.label).toBe('X10')
  })

  it('buckets pre-upgrade outcomes as UNASSIGNED instead of dropping them', () => {
    const rows = sortiesByPlatform([legacyRun(), modernRun()])
    const unassigned = rows.find((r) => r.platformId === UNASSIGNED_PLATFORM_LABEL)

    expect(unassigned?.sorties).toBe(2)
    // Nothing is lost: 2 legacy + 2 modern outcomes are all represented.
    expect(rows.reduce((sum, r) => sum + r.sorties, 0)).toBe(4)
  })
})

describe('completionReasons', () => {
  it('buckets runs recorded before completionReason existed as unknown', () => {
    const rows = completionReasons([legacyRun(), legacyRun(), modernRun()])
    expect(rows.find((r) => r.reason === UNKNOWN_REASON_LABEL)?.count).toBe(2)
    expect(rows.find((r) => r.reason === 'all_drones_complete')?.count).toBe(1)
  })
})

describe('eventTypeTotals', () => {
  it('sums per-type counts across runs and reports how many runs lacked them', () => {
    const breakdown = eventTypeTotals([
      modernRun({ eventTypeCounts: { mission_start: 1, waypoint_reached: 4 } }),
      modernRun({ eventTypeCounts: { mission_start: 1, geofence_breach: 2 } }),
      legacyRun(),
    ])

    expect(breakdown.totals[0]).toEqual({ eventType: 'waypoint_reached', count: 4 })
    expect(breakdown.totals.find((t) => t.eventType === 'mission_start')?.count).toBe(2)
    expect(breakdown.runsWithoutCounts).toBe(1)
  })

  it('limits to the requested number of event types', () => {
    const breakdown = eventTypeTotals([
      modernRun({ eventTypeCounts: { mission_start: 9, waypoint_reached: 8, low_battery: 7, rtb_triggered: 6 } }),
    ], 2)
    expect(breakdown.totals).toHaveLength(2)
    expect(breakdown.totals.map((t) => t.eventType)).toEqual(['mission_start', 'waypoint_reached'])
  })

  it('reports an all-legacy history as having no chartable event data', () => {
    const breakdown = eventTypeTotals([legacyRun(), legacyRun()])
    expect(breakdown.totals).toEqual([])
    expect(breakdown.runsWithoutCounts).toBe(2)
  })
})

describe('timeline and safety trend', () => {
  it('numbers runs sequentially and rounds distance to 2dp', () => {
    const points = buildTimeline([modernRun({ metrics: metrics({ totalFlightDistanceM: 1234.5 }) })])
    expect(points[0].run).toBe(1)
    expect(points[0].distanceKm).toBe(1.23)
  })

  it('totals conflicts and breaches per run', () => {
    const trend = safetyTrend([
      modernRun({ metrics: metrics({ conflictsDetected: 2, geofenceBreaches: 3 }) }),
    ])
    expect(trend[0]).toEqual({ run: 1, conflicts: 2, breaches: 3, total: 5 })
  })
})
