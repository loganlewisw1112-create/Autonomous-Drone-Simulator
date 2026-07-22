import { useClassroomStore, type ClassRunResult } from '@/classroom/classroomStore'

// Class comparison across the metrics that already exist on every run submission —
// no new scoring invented. chainVerified is the tamper-evidence badge; the CSV is
// the per-session record for a documented-training-hours case.
const COLUMNS: Array<{ key: string; label: string; get: (r: ClassRunResult) => string | number }> = [
  { key: 'student', label: 'Student', get: (r) => r.displayName },
  { key: 'outcome', label: 'Outcome', get: (r) => outcome(r) },
  { key: 'durationSec', label: 'Dur(s)', get: (r) => r.summary.durationSec },
  { key: 'waypointsReached', label: 'WP', get: (r) => r.summary.metrics.waypointsReached },
  { key: 'conflictsDetected', label: 'Conflicts', get: (r) => r.summary.metrics.conflictsDetected },
  { key: 'geofenceBreaches', label: 'Geofence', get: (r) => r.summary.metrics.geofenceBreaches },
  { key: 'rtbTriggers', label: 'RTB', get: (r) => r.summary.metrics.rtbTriggers },
  { key: 'thermalContacts', label: 'Thermal', get: (r) => r.summary.metrics.thermalContacts },
  { key: 'recoveryDispatches', label: 'Recovery', get: (r) => r.summary.metrics.recoveryDispatches },
  { key: 'minBatteryPct', label: 'MinBatt%', get: (r) => minBattery(r) },
  { key: 'chainVerified', label: 'Verified', get: (r) => (r.summary.chainVerified ? 'yes' : 'no') },
]

function outcome(r: ClassRunResult): string {
  return r.summary.completionReason === 'all_drones_complete' ? 'complete'
    : r.summary.completionReason === 'operator_ended' ? 'ended' : '—'
}

function minBattery(r: ClassRunResult): number {
  const outs = r.summary.droneOutcomes
  return outs.length ? Math.min(...outs.map((o) => o.batteryPct)) : 0
}

function toCsv(runs: ClassRunResult[]): string {
  const head = COLUMNS.map((c) => c.label).join(',')
  const rows = runs.map((r) => COLUMNS.map((c) => JSON.stringify(c.get(r))).join(','))
  return [head, ...rows].join('\n')
}

export function ClassResults({ classId }: { classId: string }) {
  const runs = useClassroomStore((s) => s.runs)

  function exportCsv() {
    const blob = new Blob([toCsv(runs)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `class-${classId}-results.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div style={{ fontWeight: 700 }}>Results ({runs.length})</div>
        <button className="cls-btn ghost" style={{ padding: '4px 10px', fontSize: 12, marginLeft: 'auto' }}
          disabled={runs.length === 0} onClick={exportCsv}>
          Export CSV
        </button>
      </div>
      {runs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          Submissions arrive here, encrypted, as students end their missions.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="cls-table">
            <thead><tr>{COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.studentId}>{COLUMNS.map((c) => <td key={c.key}>{c.get(r)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
