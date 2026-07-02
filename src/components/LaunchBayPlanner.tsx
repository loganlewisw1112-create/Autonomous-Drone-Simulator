import { useMemo, useState } from 'react'
import { useDroneStore } from '@/store/droneStore'
import type { LaunchBayPlan, LaunchBayStatus, LaunchRecoverySite } from '@/types'

export function LaunchBayPlanner() {
  const { scenario, ui, weatherState, setLaunchPlan, setShowLaunchBay } = useDroneStore()

  const launchSites: Record<string, LaunchRecoverySite> = scenario?.launchSites ?? {}
  const siteEntries = Object.entries(launchSites)
  const droneIds = scenario
    ? Array.from({ length: scenario.droneCount }, (_, i) => `uav-${String(i + 1).padStart(2, '0')}`)
    : []

  // Assignments state: droneId → siteId (string key like 'site-0')
  const [assignments, setAssignments] = useState<Record<string, string>>(() => {
    const rec: Record<string, string> = {}
    droneIds.forEach((id) => {
      if (launchSites[id]) rec[id] = id  // use droneId as siteId when 1:1
    })
    return rec
  })

  const bayStatuses: LaunchBayStatus[] = useMemo(() => {
    return siteEntries.map(([siteId], i) => {
      const bayKey = `bay-${i}`
      const weatherClosed = weatherState.launchBayAvailability[bayKey] === false
      const assignedDroneIds = droneIds.filter((d) => assignments[d] === siteId)
      return {
        siteId,
        capacityDrones: 2,
        assignedDroneIds,
        weatherClosed,
        closureReason: weatherClosed
          ? `Bay closed — ${weatherState.activeHazards.slice(0, 2).join(', ') || 'severe weather'}`
          : undefined,
      }
    })
  }, [siteEntries, assignments, droneIds, weatherState])

  const blockers: string[] = useMemo(() => {
    const b: string[] = []
    droneIds.forEach((id) => {
      if (!assignments[id]) b.push(`${id.toUpperCase()} — no launch bay assigned`)
    })
    bayStatuses.forEach((bay) => {
      if (bay.weatherClosed && bay.assignedDroneIds.length > 0) {
        b.push(`Bay ${bay.siteId} is weather-closed but has drones assigned`)
      }
      if (bay.assignedDroneIds.length > bay.capacityDrones) {
        b.push(`Bay ${bay.siteId} over capacity (${bay.assignedDroneIds.length}/${bay.capacityDrones})`)
      }
    })
    return b
  }, [droneIds, assignments, bayStatuses])

  const readyToLaunch = blockers.length === 0

  if (!ui.showLaunchBay || !scenario) return null

  function handleAssign(droneId: string, siteId: string) {
    setAssignments((prev) => ({ ...prev, [droneId]: siteId }))
  }

  function handleAutoAssign() {
    const auto: Record<string, string> = {}
    droneIds.forEach((id, i) => {
      const siteId = siteEntries[i % siteEntries.length]?.[0]
      if (siteId) auto[id] = siteId
    })
    setAssignments(auto)
  }

  function handleConfirm() {
    const plan: LaunchBayPlan = { assignments, bayStatuses, readyToLaunch, blockers }
    setLaunchPlan(plan)
    setShowLaunchBay(false)
  }

  function handleCancel() {
    setShowLaunchBay(false)
  }

  const siteOptions = siteEntries.length > 0
    ? siteEntries
    : [['default', null]] as [string, null][]

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && handleCancel()}>
      <div className="modal" style={{ maxWidth: 640, minWidth: 480 }}>
        <div className="modal-title">⬡ Launch Bay Planning</div>

        {/* Weather summary */}
        {weatherState.activeHazards.length > 0 && (
          <div style={{
            marginBottom: 12, padding: '6px 10px',
            background: 'rgba(255,170,0,0.08)', border: '1px solid #ffaa0044',
            borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)',
            color: 'var(--accent-yellow)',
          }}>
            ⚠ WEATHER: {weatherState.activeHazards.join(', ')} ·
            {' '}wind {weatherState.windKts}kt gusts {weatherState.gustKts}kt ·
            {' '}vis {weatherState.visibilityMi}mi ·
            {' '}ceil {weatherState.ceilingFt}ft
          </div>
        )}

        {/* Bay capacity overview */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 6, marginBottom: 16 }}>
          {bayStatuses.map((bay) => {
            const site = launchSites[bay.siteId]
            const statusColor = bay.weatherClosed ? 'var(--accent-red)' : bay.assignedDroneIds.length >= bay.capacityDrones ? 'var(--accent-yellow)' : 'var(--accent-green)'
            return (
              <div key={bay.siteId} style={{
                padding: '6px 8px', background: 'var(--bg-input)',
                borderRadius: 4, border: `1px solid ${statusColor}44`,
                fontSize: 10, fontFamily: 'var(--font-mono)',
              }}>
                <div style={{ color: statusColor, fontWeight: 700, marginBottom: 2 }}>
                  {bay.weatherClosed ? '✗ CLOSED' : `${bay.assignedDroneIds.length}/${bay.capacityDrones} SLOTS`}
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>{site?.label ?? bay.siteId}</div>
                <div style={{ color: 'var(--text-dim)', fontSize: 9 }}>{site?.agency}</div>
                {bay.closureReason && (
                  <div style={{ color: 'var(--accent-red)', fontSize: 9, marginTop: 2 }}>{bay.closureReason}</div>
                )}
              </div>
            )
          })}
        </div>

        {/* Per-drone assignment table */}
        <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--accent-blue)', marginBottom: 6, letterSpacing: '0.08em' }}>
          DRONE ASSIGNMENTS
        </div>
        <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
          {droneIds.map((droneId) => {
            const assigned = assignments[droneId]
            const site = launchSites[droneId]
            const brief = scenario.droneRouteBriefs?.[droneId]
            return (
              <div key={droneId} style={{
                display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 8,
                alignItems: 'center', padding: '4px 8px',
                background: 'var(--bg-input)', borderRadius: 4,
                border: assigned ? '1px solid #44ff8833' : '1px solid #ff444433',
              }}>
                <span style={{ color: 'var(--accent-yellow)', fontWeight: 700 }}>
                  {droneId.toUpperCase()}
                </span>
                <div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 9 }}>
                    {brief?.role ?? 'Mission support'}
                  </div>
                  {site && (
                    <div style={{ color: 'var(--text-dim)', fontSize: 8 }}>
                      Rec: {site.label.slice(0, 40)}
                    </div>
                  )}
                </div>
                <select
                  value={assigned ?? ''}
                  onChange={(e) => handleAssign(droneId, e.target.value)}
                  style={{
                    background: 'var(--bg-panel)', color: 'var(--text-primary)',
                    border: '1px solid var(--border-color)', borderRadius: 3,
                    fontFamily: 'var(--font-mono)', fontSize: 9,
                    padding: '2px 4px', cursor: 'pointer',
                  }}
                >
                  <option value="">— Unassigned —</option>
                  {siteOptions.map(([siteId]) => {
                    const s = launchSites[siteId]
                    return (
                      <option key={siteId} value={siteId}>
                        {s ? `${s.agency} — ${s.kind}` : siteId}
                      </option>
                    )
                  })}
                </select>
              </div>
            )
          })}
        </div>

        {/* Blockers */}
        {blockers.length > 0 && (
          <div style={{
            marginBottom: 12, padding: '6px 10px',
            background: 'rgba(255,68,68,0.08)', border: '1px solid #ff444444',
            borderRadius: 4,
          }}>
            <div style={{ fontSize: 10, color: 'var(--accent-red)', fontFamily: 'var(--font-mono)', marginBottom: 4 }}>
              LAUNCH BLOCKED
            </div>
            {blockers.map((b, i) => (
              <div key={i} style={{ fontSize: 9, color: 'var(--accent-red)', fontFamily: 'var(--font-mono)' }}>
                • {b}
              </div>
            ))}
          </div>
        )}

        {readyToLaunch && (
          <div style={{
            marginBottom: 12, padding: '6px 10px',
            background: 'rgba(68,255,136,0.08)', border: '1px solid #44ff8844',
            borderRadius: 4, fontSize: 10, color: 'var(--accent-green)', fontFamily: 'var(--font-mono)',
          }}>
            ✓ All bays assigned and within capacity — ready to launch
          </div>
        )}

        <div style={{ padding: '6px 10px', background: 'var(--bg-input)', borderRadius: 4, fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          ⚠ SIMULATION ONLY — Not for operational deployment. Bay assignments are simulated.
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleAutoAssign} style={{ marginRight: 'auto' }}>
            ⚡ Auto-Assign
          </button>
          <button className="btn" onClick={handleCancel}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleConfirm}
            disabled={!readyToLaunch}
            title={!readyToLaunch ? blockers[0] : undefined}
          >
            ✓ Confirm Launch Plan
          </button>
        </div>
      </div>
    </div>
  )
}
