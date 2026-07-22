import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { buildAutoLaunchDoctrinePlan, buildLaunchBayPlan } from '@/sim/mission/launchDoctrine'
import { buildLaunchSlotsForPlan } from '@/sim/mission/launchPlanGeometry'
import type {
  LaunchBayPlan,
  LaunchBayStatus,
  LaunchDoctrineCandidate,
  LaunchDoctrineRejectCode,
  LaunchRecoverySite,
  ScenarioConfig,
} from '@/types'

const REJECTION_LABELS: Record<LaunchDoctrineRejectCode, string> = {
  missing_route: 'mission route is missing',
  missing_recovery: 'recovery site is missing',
  unreachable: 'round trip falls below battery reserve',
  launch_geofence: 'launch point breaches an active geofence',
  climbout_geofence: 'climb-out corridor breaches an active geofence',
  weather_exposure: 'weather exposure exceeds site limits',
  capacity: 'site capacity is exceeded',
  pad_footprint: 'pad footprint cannot maintain launch separation',
}

export function LaunchBayPlanner() {
  const { scenario, ui, weatherState, launchPlan, droneWaypoints, applyParkedLaunchPlan, setShowLaunchBay } = useDroneStore(
    useShallow((state) => ({
      scenario: state.scenario,
      ui: state.ui,
      weatherState: state.weatherState,
      launchPlan: state.launchPlan,
      droneWaypoints: state.droneWaypoints,
      applyParkedLaunchPlan: state.applyParkedLaunchPlan,
      setShowLaunchBay: state.setShowLaunchBay,
    })),
  )

  const [assignments, setAssignments] = useState<Record<string, string>>({})
  const [applyError, setApplyError] = useState<string | null>(null)

  useEffect(() => {
    if (!ui.showLaunchBay || !scenario) return
    setAssignments(seedAssignments(scenario, launchPlan))
    setApplyError(null)
  }, [launchPlan, scenario, ui.showLaunchBay])

  const plan = useMemo(
    () => (scenario ? buildLaunchBayPlan(scenario, weatherState, assignments) : null),
    [assignments, scenario, weatherState],
  )
  const launchSites = useMemo(() => canonicalSites(scenario?.launchSites), [scenario])
  const droneIds = useMemo(() => Object.keys(plan?.candidatesByDrone ?? {}).sort(), [plan])

  if (!ui.showLaunchBay || !scenario || !plan) return null

  function handleAssign(droneId: string, siteId: string) {
    setApplyError(null)
    setAssignments((current) => {
      if (!siteId) {
        const next = { ...current }
        delete next[droneId]
        return next
      }
      return { ...current, [droneId]: siteId }
    })
  }

  function handleAutoAssign() {
    if (!scenario) return
    setApplyError(null)
    setAssignments(buildAutoLaunchDoctrinePlan(scenario, weatherState).assignments)
  }

  function handleConfirm() {
    if (!scenario || !plan) return
    const placements = buildLaunchSlotsForPlan(scenario, plan, droneWaypoints)
    if (applyParkedLaunchPlan(plan, placements)) {
      setApplyError(null)
      setShowLaunchBay(false)
    } else {
      setApplyError('Launch plan could not be applied. Confirm the fleet is parked and try again.')
    }
  }

  const assignedCount = Object.keys(plan.assignmentDetails ?? {}).length
  const usedSiteCount = new Set(Object.values(assignments)).size

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && setShowLaunchBay(false)}>
      <div
        className="modal launch-bay-modal launch-doctrine-planner"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-doctrine-title"
      >
        <header className="launch-doctrine-header">
          <div>
            <div className="modal-title" id="launch-doctrine-title">⬡ Launch Doctrine Brief</div>
            <p>Assign each aircraft from a reachable, legal, weather-safe site.</p>
          </div>
          <div className="launch-doctrine-coverage" aria-label="Launch plan coverage">
            <strong>{assignedCount}/{droneIds.length}</strong> AIRCRAFT
            <span>{usedSiteCount}/{Object.keys(launchSites).length} SITES USED</span>
          </div>
        </header>

        <div className="launch-doctrine-weather" data-hazards={weatherState.activeHazards.length > 0 ? 'active' : 'clear'}>
          <strong>{weatherState.activeHazards.length > 0 ? '⚠ CURRENT CONDITIONS' : '✓ CURRENT CONDITIONS'}</strong>
          <span>{weatherState.activeHazards.join(', ') || 'clear'}</span>
          <span>wind {weatherState.windKts}kt · gusts {weatherState.gustKts}kt · ceiling {weatherState.ceilingFt}ft</span>
        </div>

        <section className="launch-doctrine-sites" aria-labelledby="launch-sites-heading">
          <h2 id="launch-sites-heading">SITE AVAILABILITY</h2>
          <div className="launch-doctrine-site-grid">
            {plan.bayStatuses.map((status) => (
              <SiteStatusCard key={status.siteId} status={status} site={launchSites[status.siteId]} />
            ))}
          </div>
        </section>

        <section className="launch-doctrine-assignments" aria-labelledby="launch-assignments-heading">
          <h2 id="launch-assignments-heading">AIRCRAFT ASSIGNMENTS</h2>
          <div className="launch-doctrine-assignment-list">
            {droneIds.map((droneId) => {
              const candidates = plan.candidatesByDrone?.[droneId] ?? []
              const assignedSiteId = assignments[droneId] ?? ''
              const assigned = candidates.find((candidate) => candidate.siteId === assignedSiteId)
              const detail = plan.assignmentDetails?.[droneId] ?? assigned
              const rejected = plan.rejectedByDrone?.[droneId] ?? []
              const brief = scenario.droneRouteBriefs?.[droneId]

              return (
                <article className="launch-doctrine-assignment" key={droneId} data-drone-id={droneId}>
                  <div className="launch-doctrine-assignment-heading">
                    <div>
                      <strong>{droneId.toUpperCase()}</strong>
                      <span>{brief?.role ?? scenario.perDroneMissionRoles?.[droneId] ?? 'Mission support'}</span>
                    </div>
                    <label htmlFor={`launch-site-${droneId}`}>LAUNCH SITE</label>
                    <select
                      id={`launch-site-${droneId}`}
                      value={assignedSiteId}
                      onChange={(event) => handleAssign(droneId, event.target.value)}
                    >
                      <option value="">— Unassigned —</option>
                      {candidates.map((candidate) => {
                        const site = launchSites[candidate.siteId]
                        return (
                          <option
                            key={candidate.siteId}
                            value={candidate.siteId}
                            disabled={candidate.rejectedBy.length > 0 && candidate.siteId !== assignedSiteId}
                          >
                            {optionLabel(site, candidate)}
                          </option>
                        )
                      })}
                    </select>
                  </div>

                  {detail ? (
                    <CandidateBrief candidate={detail} site={launchSites[detail.siteId]} />
                  ) : (
                    <p className="launch-doctrine-empty">No site selected. Choose an eligible launch site or run Auto-Assign.</p>
                  )}

                  {rejected.length > 0 && (
                    <details className="launch-doctrine-rejections">
                      <summary>{rejected.length} REJECTED {rejected.length === 1 ? 'SITE' : 'SITES'} — SHOW REASONS</summary>
                      <ul>
                        {rejected.map((candidate) => (
                          <li key={candidate.siteId} data-site-id={candidate.siteId}>
                            <strong>{launchSites[candidate.siteId]?.label ?? candidate.siteId}</strong>
                            <span>{candidate.rejectedBy.map((reason) => REJECTION_LABELS[reason]).join(' · ')}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        {plan.blockers.length > 0 ? (
          <section className="launch-doctrine-blockers" aria-labelledby="launch-blockers-heading">
            <h2 id="launch-blockers-heading">LAUNCH BLOCKED</h2>
            <ul>{plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
          </section>
        ) : (
          <div className="launch-doctrine-ready" role="status">✓ Doctrine checks passed — ready to confirm</div>
        )}

        {applyError && <div className="launch-doctrine-apply-error" role="alert">{applyError}</div>}

        <div className="launch-doctrine-disclaimer">⚠ SIMULATION ONLY — Not for operational deployment.</div>

        <footer className="launch-bay-actions">
          <button className="btn" onClick={handleAutoAssign}>⚡ Auto-Assign</button>
          <button className="btn" onClick={() => setShowLaunchBay(false)}>Cancel</button>
          <button
            className="btn primary"
            onClick={handleConfirm}
            disabled={!plan.readyToLaunch}
            title={!plan.readyToLaunch ? plan.blockers[0] : undefined}
          >
            ✓ Confirm Launch Plan
          </button>
        </footer>
      </div>
    </div>
  )
}

function SiteStatusCard({ status, site }: { status: LaunchBayStatus; site?: LaunchRecoverySite }) {
  const capacity = status.effectiveCapacityDrones ?? status.capacityDrones
  const remaining = Math.max(0, capacity - status.assignedDroneIds.length)
  const availability = status.weatherClosed ? 'closed' : remaining <= 1 ? 'limited' : 'open'
  return (
    <article className={`launch-doctrine-site site-${availability}`} data-availability={availability}>
      <div>
        <strong>{availability.toUpperCase()}</strong>
        <span>{status.assignedDroneIds.length}/{capacity} SLOTS</span>
      </div>
      <h3>{site?.label ?? status.siteId}</h3>
      <p>{site?.agency ?? 'UAS operations'} · {(status.exposure ?? site?.exposure ?? 'semi').toUpperCase()} EXPOSURE</p>
      {status.closureReason && <small>{status.closureReason}</small>}
    </article>
  )
}

function CandidateBrief({ candidate, site }: { candidate: LaunchDoctrineCandidate; site?: LaunchRecoverySite }) {
  const rejected = candidate.rejectedBy.length > 0
  return (
    <div className={`launch-doctrine-candidate${rejected ? ' candidate-rejected' : ''}`}>
      <dl>
        <div><dt>TO TASK</dt><dd>{formatDistance(candidate.firstTaskDistanceM)}</dd></div>
        <div><dt>TRANSIT</dt><dd>{formatDuration(candidate.transitSec)}</dd></div>
        <div><dt>ROUND TRIP</dt><dd>{formatDistance(candidate.routeDistanceM)}</dd></div>
        <div><dt>RESERVE</dt><dd>{candidate.reserveMarginPct.toFixed(1)}%</dd></div>
        <div><dt>EXPOSURE</dt><dd>{(site?.exposure ?? 'semi').toUpperCase()}</dd></div>
      </dl>
      <p>{candidate.rationale}</p>
      {rejected && (
        <div className="launch-doctrine-candidate-reasons">
          {candidate.rejectedBy.map((reason) => REJECTION_LABELS[reason]).join(' · ')}
        </div>
      )}
    </div>
  )
}

function seedAssignments(scenario: ScenarioConfig, existing: LaunchBayPlan | null): Record<string, string> {
  if (existing?.assignments && Object.keys(existing.assignments).length > 0) return { ...existing.assignments }
  if (scenario.defaultLaunchAssignments) return { ...scenario.defaultLaunchAssignments }
  return Object.fromEntries(Object.entries(scenario.launchSites ?? {})
    .filter(([recordKey]) => /^uav-\d+$/.test(recordKey))
    .map(([recordKey, site]) => [recordKey, site.id ?? recordKey]))
}

function canonicalSites(sites: Record<string, LaunchRecoverySite> | undefined): Record<string, LaunchRecoverySite> {
  return Object.fromEntries(Object.entries(sites ?? {}).map(([recordKey, site]) => [site.id ?? recordKey, site]))
}

function optionLabel(site: LaunchRecoverySite | undefined, candidate: LaunchDoctrineCandidate): string {
  const label = site?.label ?? candidate.siteId
  const exposure = (site?.exposure ?? 'semi').toUpperCase()
  const transit = formatDuration(candidate.transitSec)
  return candidate.rejectedBy.length > 0
    ? `${label} — REJECTED: ${candidate.rejectedBy.map((reason) => REJECTION_LABELS[reason]).join(', ')}`
    : `${label} — ${transit} · ${candidate.reserveMarginPct.toFixed(1)}% reserve · ${exposure}`
}

function formatDistance(distanceM: number): string {
  return distanceM < 1_000 ? `${Math.round(distanceM)} m` : `${(distanceM / 1_000).toFixed(1)} km`
}

function formatDuration(durationSec: number): string {
  return durationSec < 60 ? `${Math.round(durationSec)} sec` : `${(durationSec / 60).toFixed(1)} min`
}
