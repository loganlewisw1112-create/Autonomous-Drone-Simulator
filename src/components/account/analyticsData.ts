import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { PLATFORM_CATALOG } from '@/sim/drone/platformCatalog'
import type { StoredRunSummary } from '@/account/types'
import type { EventType } from '@/types'

// ─── Analytics aggregation ───────────────────────────────────────────────────
// Pure reducers over decrypted run summaries, extracted from AccountPanels so
// they can be tested without mounting the panel or touching IndexedDB.
//
// Every field these read may be absent: summaries recorded before a given field
// existed still decrypt and must still chart. Missing data is bucketed
// explicitly ("UNASSIGNED", "unknown") rather than dropped, so a chart never
// silently under-reports.

const SCENARIO_NAMES = new Map(ALL_SCENARIOS.map((s) => [s.id, s.name]))

/** Bucket label for runs recorded before per-platform physics existed. */
export const UNASSIGNED_PLATFORM_LABEL = 'UNASSIGNED'

/** Bucket label for runs recorded before completionReason existed. */
export const UNKNOWN_REASON_LABEL = 'unknown'

export interface AnalyticsAggregates {
  total: number
  distanceKm: number
  contacts: number
  waypoints: number
  avgDuration: number
  verified: number
  conflicts: number
  geofenceBreaches: number
  rtbTriggers: number
  recoveryDispatches: number
  groundDispatches: number
}

export function buildAggregates(summaries: StoredRunSummary[]): AnalyticsAggregates {
  const total = summaries.length
  const sum = (pick: (s: StoredRunSummary) => number) =>
    summaries.reduce((acc, s) => acc + pick(s), 0)

  return {
    total,
    distanceKm: sum((s) => s.metrics.totalFlightDistanceM) / 1000,
    contacts: sum((s) => s.metrics.thermalContacts),
    waypoints: sum((s) => s.metrics.waypointsReached),
    avgDuration: total ? sum((s) => s.durationSec) / total : 0,
    verified: summaries.filter((s) => s.eventCount > 0 && s.chainVerified).length,
    conflicts: sum((s) => s.metrics.conflictsDetected),
    geofenceBreaches: sum((s) => s.metrics.geofenceBreaches),
    rtbTriggers: sum((s) => s.metrics.rtbTriggers),
    recoveryDispatches: sum((s) => s.metrics.recoveryDispatches),
    groundDispatches: sum((s) => s.metrics.groundUnitDispatch),
  }
}

export interface TimelinePoint {
  name: string
  run: number
  distanceKm: number
  contacts: number
}

export function buildTimeline(summaries: StoredRunSummary[]): TimelinePoint[] {
  return summaries.map((s, i) => ({
    name: new Date(s.completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    run: i + 1,
    distanceKm: Number((s.metrics.totalFlightDistanceM / 1000).toFixed(2)),
    contacts: s.metrics.thermalContacts,
  }))
}

export interface ScenarioCount {
  scenarioId: string
  /** Human-readable scenario name, falling back to the raw id for custom missions. */
  label: string
  count: number
}

export function runsByScenario(summaries: StoredRunSummary[]): ScenarioCount[] {
  const counts = new Map<string, number>()
  for (const s of summaries) counts.set(s.scenarioId, (counts.get(s.scenarioId) ?? 0) + 1)
  return [...counts.entries()]
    .map(([scenarioId, count]) => ({
      scenarioId,
      // Custom missions aren't in the static catalog — show their id rather than
      // an empty label.
      label: SCENARIO_NAMES.get(scenarioId) ?? scenarioId,
      count,
    }))
    .sort((a, b) => b.count - a.count)
}

export interface PlatformCount {
  platformId: string
  label: string
  sorties: number
}

/**
 * Counts drone sorties per airframe. Each droneOutcome is one sortie; outcomes
 * without a platformId came from pre-upgrade runs and aggregate under
 * UNASSIGNED_PLATFORM_LABEL.
 */
export function sortiesByPlatform(summaries: StoredRunSummary[]): PlatformCount[] {
  const counts = new Map<string, number>()
  for (const summary of summaries) {
    for (const outcome of summary.droneOutcomes) {
      const key = outcome.platformId ?? UNASSIGNED_PLATFORM_LABEL
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([platformId, sorties]) => ({
      platformId,
      label: platformId === UNASSIGNED_PLATFORM_LABEL
        ? UNASSIGNED_PLATFORM_LABEL
        : PLATFORM_CATALOG[platformId as keyof typeof PLATFORM_CATALOG]?.shortName ?? platformId,
      sorties,
    }))
    .sort((a, b) => b.sorties - a.sorties)
}

export interface ReasonCount {
  reason: string
  count: number
}

export function completionReasons(summaries: StoredRunSummary[]): ReasonCount[] {
  const counts = new Map<string, number>()
  for (const s of summaries) {
    const reason = s.completionReason ?? UNKNOWN_REASON_LABEL
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
}

export interface SafetyPoint {
  run: number
  conflicts: number
  breaches: number
  total: number
}

/** Per-run safety event counts, for spotting a trend across a profile's history. */
export function safetyTrend(summaries: StoredRunSummary[]): SafetyPoint[] {
  return summaries.map((s, i) => ({
    run: i + 1,
    conflicts: s.metrics.conflictsDetected,
    breaches: s.metrics.geofenceBreaches,
    total: s.metrics.conflictsDetected + s.metrics.geofenceBreaches,
  }))
}

export interface EventTypeTotal {
  eventType: string
  count: number
}

export interface EventTypeBreakdown {
  totals: EventTypeTotal[]
  /** Runs lacking eventTypeCounts (recorded before the field existed). */
  runsWithoutCounts: number
}

export function eventTypeTotals(summaries: StoredRunSummary[], limit = 8): EventTypeBreakdown {
  const counts = new Map<string, number>()
  let runsWithoutCounts = 0

  for (const summary of summaries) {
    if (!summary.eventTypeCounts) { runsWithoutCounts++; continue }
    for (const [eventType, count] of Object.entries(summary.eventTypeCounts) as Array<[EventType, number]>) {
      counts.set(eventType, (counts.get(eventType) ?? 0) + count)
    }
  }

  const totals = [...counts.entries()]
    .map(([eventType, count]) => ({ eventType, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)

  return { totals, runsWithoutCounts }
}
