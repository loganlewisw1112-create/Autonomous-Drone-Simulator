import { useEffect, useMemo, useState } from 'react'
import type {
  FleetRetaskApplyResult,
  FleetRetaskReason,
  FleetRetaskResultEntry,
} from '@/store/droneStore'

export interface FleetRetaskReviewProps {
  result: FleetRetaskApplyResult | null
  undoUntil?: number | null
  onUndo: () => boolean
  compact?: boolean
}

const REASON_LABELS: Record<FleetRetaskReason, string> = {
  not_retaskable: 'not retaskable',
  critical_battery: 'critical battery',
  battery_reserve: 'below battery reserve',
  geofence_breach: 'geofence breach',
  weather: 'weather safety hold',
  no_viable_assignment: 'no viable assignment',
  advisor_hold: 'hold position',
  cooldown_active: 'cooldown active',
  route_capped: 'route capped',
  route_safety_rejected: 'route safety rejected',
  route_unchanged: 'route unchanged',
  route_applied: 'route applied',
  persistence_failed: 'route save failed',
}

const STATUS_LABELS: Record<FleetRetaskApplyResult['status'], string> = {
  applied: 'FLEET RETASKED',
  no_change: 'FLEET RETASK · NO CHANGES',
  cached: 'FLEET RETASK · CACHED PLAN',
  cooldown: 'FLEET RETASK · COOLDOWN ACTIVE',
  failed: 'FLEET RETASK FAILED',
}

export function FleetRetaskReview({ result, undoUntil = null, onUndo, compact = false }: FleetRetaskReviewProps) {
  const [clockMs, setClockMs] = useState(() => Date.now())
  const [undoFailed, setUndoFailed] = useState(false)

  useEffect(() => {
    setClockMs(Date.now())
    setUndoFailed(false)
    if (undoUntil == null) return
    const timer = window.setInterval(() => setClockMs(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [result, undoUntil])

  const counts = useMemo(() => countStatuses(result?.entries ?? []), [result])
  const detailEntries = useMemo(
    () => (result?.entries ?? []).filter((entry) => entry.status !== 'applied'),
    [result],
  )
  // The store accepts undo at the exact deadline and rejects only after it.
  const canUndo = undoUntil != null && clockMs <= undoUntil
  const undoSeconds = undoUntil == null ? 0 : Math.max(0, Math.ceil((undoUntil - clockMs) / 1000))

  if (!result && !canUndo) return null

  function handleUndo() {
    setUndoFailed(onUndo() === false)
  }

  return (
    <section
      className={`fleet-retask-review${compact ? ' fleet-retask-review--compact' : ''}`}
      aria-live="polite"
      data-status={result?.status ?? 'undo'}
    >
      <div className="fleet-retask-review__main">
        <strong>{result ? STATUS_LABELS[result.status] : 'FLEET RETASK'}</strong>
        {result && result.changedDroneIds.length > 0 && (
          <span>{result.changedDroneIds.length} {result.changedDroneIds.length === 1 ? 'DRONE' : 'DRONES'}</span>
        )}
        {result && (
          <span className="fleet-retask-review__counts">{statusSummary(counts)}</span>
        )}
        {result?.message && <span className="fleet-retask-review__message">{result.message}</span>}
      </div>

      {detailEntries.length > 0 && (
        <ul className="fleet-retask-review__details" aria-label="Fleet retask results">
          {detailEntries.map((entry, index) => (
            <li key={`${entry.droneId}-${entry.status}-${entry.reason}-${index}`}>
              <b>{entry.droneId.toUpperCase()}</b> · {entry.status.toUpperCase()} · {entry.detail?.trim() || REASON_LABELS[entry.reason]}
            </li>
          ))}
        </ul>
      )}

      {canUndo && (
        <button type="button" className="fleet-retask-review__undo" onClick={handleUndo}>
          ↶ UNDO FLEET RETASK ({undoSeconds}s)
        </button>
      )}
      {undoFailed && <span className="fleet-retask-review__undo-error">UNDO FAILED · TRY AGAIN</span>}
    </section>
  )
}

function countStatuses(entries: readonly FleetRetaskResultEntry[]) {
  return entries.reduce(
    (counts, entry) => ({ ...counts, [entry.status]: counts[entry.status] + 1 }),
    { applied: 0, held: 0, skipped: 0, failed: 0, warning: 0 },
  )
}

function statusSummary(counts: ReturnType<typeof countStatuses>): string {
  const parts = [
    counts.applied > 0 && `${counts.applied} APPLIED`,
    counts.held > 0 && `${counts.held} HELD`,
    counts.skipped > 0 && `${counts.skipped} SKIPPED`,
    counts.failed > 0 && `${counts.failed} FAILED`,
    counts.warning > 0 && `${counts.warning} WARNING`,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'NO ELIGIBLE ROUTE CHANGES'
}
