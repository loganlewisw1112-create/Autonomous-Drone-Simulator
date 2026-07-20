import { useMemo, useState } from 'react'
import { buildGeoJSON } from '@/utils/geojsonExport'
import { buildFullKML } from '@/utils/kmlExport'
import { exportChainAsJsonl } from '@/utils/chainOfCustody'
import type { StoredRunDetailV2, StoredRunSummary } from '@/account/types'
import { ArchivedReplay } from './ArchivedReplay'
import { inspectEvidence } from './evidenceStatus'

const TABS = ['Overview', 'Report', 'Event Log', 'Evidence Chain', 'Replay'] as const
type RunDetailTab = typeof TABS[number]

const COMPLETION_LABELS: Record<NonNullable<StoredRunSummary['completionReason']>, string> = {
  all_drones_complete: 'All drones reached idle/landed — mission completed automatically',
  operator_ended: 'Ended by operator (End Mission)',
}

function completionLabel(summary: StoredRunSummary): string {
  return summary.completionReason ? COMPLETION_LABELS[summary.completionReason] : 'Unknown (recorded before this was tracked)'
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 500)
}

function Overview({ summary, detail }: { summary: StoredRunSummary; detail: StoredRunDetailV2 | null }) {
  const status = inspectEvidence(summary, detail)
  return (
    <div className="rundetail-overview">
      <p className="rundetail-completion-reason">{completionLabel(summary)}</p>
      <div className="rundetail-stat-grid">
        <div><strong>{Math.round(summary.durationSec)}s</strong><span>Duration</span></div>
        <div><strong>{(summary.metrics.totalFlightDistanceM / 1000).toFixed(2)} km</strong><span>Distance</span></div>
        <div><strong>{summary.metrics.waypointsReached}</strong><span>Waypoints</span></div>
        <div><strong>{summary.metrics.thermalContacts}</strong><span>Thermal contacts</span></div>
        <div><strong>{summary.droneOutcomes.length}</strong><span>Drones</span></div>
        <div className={`evidence-badge evidence-badge--${status.state}`}><strong>{status.state.replace('-', ' ')}</strong><span>{status.label}</span></div>
      </div>
      {detail ? (
        <div className="rundetail-grid">
          <section><span className="account-label">MISSION SPECIFICATION</span><h3>{detail.scenario.name}</h3><p>{detail.scenario.description}</p><dl><dt>Type</dt><dd>{detail.scenario.missionType}</dd><dt>Seed</dt><dd>{detail.scenario.seed}</dd><dt>Weather</dt><dd>{detail.scenarioVariant.timeOfDay}, severity {detail.scenarioVariant.weatherSeverity}</dd></dl></section>
          <section><span className="account-label">LAUNCH PLAN</span>{detail.launchPlan ? <><p>{detail.launchPlan.readyToLaunch ? 'Launch plan was ready.' : 'Launch plan had blockers.'}</p><dl>{Object.entries(detail.launchPlan.assignments).map(([drone, site]) => <span key={drone}><dt>{drone}</dt><dd>{site}</dd></span>)}</dl></> : <p>No launch plan was stored.</p>}</section>
          <section className="rundetail-span-2"><span className="account-label">FLEET OUTCOMES</span><div className="rundetail-fleet-table">{detail.finalDrones.map((drone) => <div key={drone.id}><strong>{drone.label}</strong><span>{drone.missionState}</span><span>{Math.round(drone.batteryPct)}% battery</span><span>{Math.round(drone.altitudeFt)} ft final altitude</span><span>{(detail.routes[drone.id] ?? []).length} route points</span></div>)}</div></section>
        </div>
      ) : <p className="rundetail-empty">{summary.detailState === 'quota-limited' ? 'The mission summary was preserved, but full detail could not be saved because device storage was full.' : 'This run predates full mission detail storage. Its summary remains available.'}</p>}
    </div>
  )
}

function Report({ detail }: { detail: StoredRunDetailV2 | null }) {
  if (!detail) return <p className="rundetail-empty">No full report is available for this run.</p>
  const report = detail.report
  return <div className="rundetail-report"><h2>{report.missionReport.title}</h2><p>{report.missionReport.summary}</p><div className="rundetail-report-grid"><section><span className="account-label">OUTCOME</span><pre>{JSON.stringify(report.outcome, null, 2)}</pre></section><section><span className="account-label">COMPLIANCE</span><pre>{JSON.stringify(report.compliance, null, 2)}</pre></section><section><span className="account-label">UTM / AIRSPACE</span><pre>{JSON.stringify(report.utm, null, 2)}</pre></section><section><span className="account-label">EVIDENCE</span><pre>{JSON.stringify(report.evidence, null, 2)}</pre></section></div></div>
}

function EventLog({ detail }: { detail: StoredRunDetailV2 | null }) {
  const [filter, setFilter] = useState('')
  const events = useMemo(() => !detail ? [] : detail.events.filter((event) => {
    const term = filter.trim().toLowerCase()
    return !term || event.eventType.toLowerCase().includes(term) || event.droneId.toLowerCase().includes(term) || JSON.stringify(event.payload).toLowerCase().includes(term)
  }), [detail, filter])
  if (!detail) return <p className="rundetail-empty">No event log is available for this run.</p>
  return <div className="rundetail-events"><label>Filter events<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Type, drone, or payload" /></label><span>{events.length}/{detail.events.length} events</span>{events.map((event, index) => <details key={`${event.hash}-${index}`}><summary><span>#{index + 1}</span><strong>{event.eventType}</strong><span>{event.droneId}</span><span>tick {event.tick}</span><span>{new Date(event.timestamp).toLocaleTimeString()}</span></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div>
}

function EvidenceChain({ summary, detail }: { summary: StoredRunSummary; detail: StoredRunDetailV2 | null }) {
  const status = inspectEvidence(summary, detail)
  return <div className="rundetail-evidence"><div className={`evidence-banner evidence-banner--${status.state}`}><strong>{status.state.replace('-', ' ').toUpperCase()}</strong><span>{status.label}</span></div>{detail && detail.events.length > 0 && <div className="evidence-chain-list">{detail.events.map((event, index) => <article key={`${event.hash}-${index}`} className={'state' in status && status.state === 'failed' && status.failureIndex === index ? 'failed' : ''}><span>LINK {index + 1}</span><strong>{event.eventType}</strong><code>prev {event.prevHash}</code><code>hash {event.hash}</code></article>)}</div>}</div>
}

export function RunDetailView({ summary, detail, onBack, mobile = false }: { summary: StoredRunSummary; detail: StoredRunDetailV2 | null; onBack: () => void; mobile?: boolean }) {
  const [tab, setTab] = useState<RunDetailTab>('Overview')
  const slug = `${summary.scenarioId}-${summary.completedAt}`
  return (
    <section className={`rundetail${mobile ? ' rundetail--mobile' : ''}`} data-testid="run-detail-view">
      <header className="rundetail-header"><button className="btn" onClick={onBack}>← BACK</button><div><span className="modal-title">{detail?.scenario.name ?? summary.scenarioId}</span><small>{new Date(summary.completedAt).toLocaleString()}</small></div><div className="rundetail-exports"><button className="btn" disabled={!detail} onClick={() => detail && download(`${slug}-report.json`, JSON.stringify(detail.report, null, 2), 'application/json')}>REPORT</button><button className="btn" disabled={!detail} onClick={() => detail && download(`${slug}-evidence.jsonl`, exportChainAsJsonl(detail.events), 'application/x-ndjson')}>EVIDENCE</button><button className="btn" disabled={!detail} onClick={() => detail && download(`${slug}.kml`, buildFullKML(detail.finalDrones, detail.positionHistory, detail.scenario, []), 'application/vnd.google-earth.kml+xml')}>KML</button><button className="btn" disabled={!detail} onClick={() => detail && download(`${slug}.geojson`, buildGeoJSON(detail.finalDrones, detail.positionHistory, detail.scenario, []), 'application/geo+json')}>GEOJSON</button></div></header>
      <nav className="rundetail-tabs" aria-label="Run detail sections">{TABS.map((candidate) => <button key={candidate} className={candidate === tab ? 'active' : ''} onClick={() => setTab(candidate)}>{candidate}</button>)}</nav>
      <div className="rundetail-body">
        {tab === 'Overview' && <Overview summary={summary} detail={detail} />}
        {tab === 'Report' && <Report detail={detail} />}
        {tab === 'Event Log' && <EventLog detail={detail} />}
        {tab === 'Evidence Chain' && <EvidenceChain summary={summary} detail={detail} />}
        {tab === 'Replay' && (detail ? <ArchivedReplay detail={detail} /> : <p className="rundetail-empty">No archived replay is available for this run.</p>)}
      </div>
    </section>
  )
}

export default RunDetailView
