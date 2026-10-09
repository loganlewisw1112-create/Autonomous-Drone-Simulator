import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  buildReportViewModel,
  type ReportLegendEntry,
  type ReportMap,
  type ReportMapPoint,
  type ReportSource,
  type ReportViewModel,
} from '@/sim/demo/reportViewModel'
import { serializeAfterActionPackage } from '@/sim/demo/missionReport'
import { exportChainAsJsonl } from '@/utils/chainOfCustody'
import { buildFullKML } from '@/utils/kmlExport'
import { buildGeoJSON } from '@/utils/geojsonExport'
import '@/styles/report.css'

/**
 * Readable after-action report. Renders the pure ReportViewModel in a fixed section order:
 * summary, timeline, map, scores, chain. React escaping only (no raw-HTML injection); every
 * number in the SVG comes pre-projected and finite from the view model.
 *
 * Always load this module with lazy(() => import('@/components/debrief/AfterActionReport')
 * .then((m) => ({ default: m.AfterActionReport }))) so it never lands in the startup path.
 */
export interface AfterActionReportProps {
  source: ReportSource
  /** 'dialog' (default) portals a full-screen overlay to document.body; 'inline' renders in flow. */
  mode?: 'dialog' | 'inline'
  onClose?: () => void
  /** Secondary JSON / KML / GeoJSON / evidence buttons. Default true. */
  showExports?: boolean
}

function pts(points: readonly ReportMapPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

function Swatch({ entry }: { entry: ReportLegendEntry }) {
  const cls = entry.style === 'solid' ? 'aar-swatch' : `aar-swatch aar-swatch--${entry.style}`
  return <span className={cls} style={{ color: entry.color }} aria-hidden="true" />
}

function MapSvg({ map }: { map: ReportMap }) {
  return (
    <svg
      className="aar-map"
      viewBox={`0 0 ${map.width} ${map.height}`}
      role="img"
      aria-label="Mission map: search area, geofences, flight tracks and contacts"
      data-testid="aar-map"
    >
      <title>Mission map</title>
      {map.searchArea.length >= 3 && (
        <polygon points={pts(map.searchArea)} fill="#58a6ff" fillOpacity="0.1" stroke="#58a6ff" strokeWidth="1.5" strokeDasharray="6 4" />
      )}
      {map.geofences.map((g) => (
        <polygon
          key={g.id}
          points={pts(g.points)}
          fill={g.kind === 'no_fly' ? '#ff5555' : '#ffaa00'}
          fillOpacity="0.14"
          stroke={g.kind === 'no_fly' ? '#ff5555' : '#ffaa00'}
          strokeWidth="1.5"
        />
      ))}
      {map.routes.map((r) =>
        r.points.length > 1 ? (
          <polyline key={r.id} points={pts(r.points)} fill="none" stroke={r.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        ) : (
          <circle key={r.id} cx={r.points[0].x} cy={r.points[0].y} r="4" fill={r.color} />
        ),
      )}
      {map.tracks.map((t) => (
        <g key={`track-${t.kind}-${t.id}`}>
          {t.points.length > 1 ? (
            <polyline points={pts(t.points)} fill="none" stroke={t.color} strokeWidth="2.5" strokeDasharray="7 5" strokeLinejoin="round" />
          ) : (
            <rect x={t.points[0].x - 4} y={t.points[0].y - 4} width="8" height="8" fill={t.color} />
          )}
          {t.onFoot && (
            <line x1={t.onFoot.from.x} y1={t.onFoot.from.y} x2={t.onFoot.to.x} y2={t.onFoot.to.y} stroke="#c9d1d9" strokeWidth="2" strokeDasharray="1.5 4" strokeLinecap="round" />
          )}
        </g>
      ))}
      {map.contacts.map((c) => (
        <circle key={c.id} cx={c.x} cy={c.y} r="5" fill={c.resolved ? 'none' : '#ff7b54'} stroke="#ff7b54" strokeWidth="2" />
      ))}
      {map.base && <rect x={map.base.x - 5} y={map.base.y - 5} width="10" height="10" fill="#3fb950" stroke="#fff" strokeWidth="1" />}
    </svg>
  )
}

function downloadText(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  window.setTimeout(() => { URL.revokeObjectURL(url); anchor.remove() }, 1000)
}

function fileStem(scenarioId: string): string {
  return scenarioId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 60) || 'mission'
}

function ReportBody({ vm }: { vm: ReportViewModel }) {
  const { summary, timeline, map, scores, chain } = vm
  return (
    <>
      <section className="aar-section" data-section="summary" data-testid="aar-section-summary" style={{ marginTop: 0, paddingTop: 0, borderTop: 0 }}>
        <h1 className="aar-title">{summary.title}</h1>
        <p className="aar-headline">{summary.headline}</p>
        <h2>Summary</h2>
        <dl className="aar-facts">
          <div><dt>Scenario</dt><dd>{summary.scenarioName}</dd></div>
          <div><dt>Date</dt><dd>{summary.dateLabel}</dd></div>
          <div><dt>Duration</dt><dd>{summary.durationLabel}</dd></div>
          <div><dt>Drones</dt><dd>{summary.droneCount}</dd></div>
        </dl>
      </section>

      <section className="aar-section" data-section="timeline" data-testid="aar-section-timeline">
        <h2>Timeline</h2>
        {timeline.rows.length === 0 ? (
          <p className="aar-note">No reportable events were recorded.</p>
        ) : (
          <ol className="aar-timeline">
            {timeline.rows.map((row) => (
              <li key={row.id}>
                <span className="aar-time">{row.timeLabel}</span>
                <span>{row.label}</span>
                {row.count > 1 ? <span className="aar-count">×{row.count}</span> : <span />}
              </li>
            ))}
          </ol>
        )}
        {timeline.omittedRows > 0 && (
          <p className="aar-note">{timeline.omittedRows} lower-priority rows are not shown ({timeline.relevantEventCount} events in total).</p>
        )}
      </section>

      <section className="aar-section" data-section="map" data-testid="aar-section-map">
        <h2>Map</h2>
        {map.empty ? <p className="aar-note">No position data was recorded for this run.</p> : <MapSvg map={map} />}
        {map.legend.length > 0 && (
          <ul className="aar-legend" aria-label="Map legend">
            {map.legend.map((entry) => (
              <li key={entry.key}><Swatch entry={entry} /><span>{entry.label}</span></li>
            ))}
          </ul>
        )}
      </section>

      <section className="aar-section" data-section="scores" data-testid="aar-section-scores">
        <h2>Mission objectives</h2>
        <p className="aar-score-total">{scores.mission.percent}% of mission objectives complete</p>
        <ul className="aar-objectives">
          {scores.mission.objectives.map((o) => (
            <li key={o.id}>
              <span>{o.label}</span>
              <span>{o.percent}% <span className="aar-detail">({o.detail})</span></span>
              <span className="aar-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, o.percent))}%` }} /></span>
            </li>
          ))}
        </ul>
      </section>

      <section className="aar-section" data-section="chain" data-testid="aar-section-chain">
        <h2>Chain of custody</h2>
        <p className={`aar-chain-status aar-chain-status--${chain.status}`} data-testid="aar-chain-status">
          Event chain: {chain.label}
          {chain.failureIndex !== null && ` (first failing link: #${chain.failureIndex + 1})`}
        </p>
        <div>{chain.eventCount} application event records</div>
        <code className="aar-hash">Head hash {chain.headHash}</code>
        <p className="aar-note">Application event-custody records only. External custody is not implied.</p>
      </section>
    </>
  )
}

export function AfterActionReport({ source, mode = 'dialog', onClose, showExports = true }: AfterActionReportProps) {
  const vm = useMemo(() => buildReportViewModel(source), [source])
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialog = mode === 'dialog'

  useEffect(() => {
    if (!dialog) return
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose?.() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, onClose])

  const stem = fileStem(source.package.scenarioId)

  const doc = (
    <article className={`aar-doc${dialog ? '' : ' aar-doc--inline'}`} data-testid="after-action-report" aria-label="Mission report">
      {dialog && (
        <div className="aar-topbar aar-no-print">
          <div className="aar-topbar-actions">
            <button type="button" className="aar-btn aar-btn--primary" onClick={() => window.print()}>PRINT</button>
          </div>
          <button type="button" className="aar-btn" ref={closeRef} onClick={onClose} data-testid="aar-close">CLOSE</button>
        </div>
      )}
      <ReportBody vm={vm} />
      {showExports && (
        <div className="aar-exports aar-no-print" data-testid="aar-exports">
          <p>Raw data exports</p>
          <div className="aar-exports-row">
            <button type="button" className="aar-btn" onClick={() => downloadText(`${stem}-report.json`, serializeAfterActionPackage(source.package), 'application/json')}>JSON</button>
            <button type="button" className="aar-btn" onClick={() => downloadText(`${stem}-evidence.jsonl`, exportChainAsJsonl(source.events), 'application/x-ndjson')}>EVIDENCE</button>
            <button type="button" className="aar-btn" onClick={() => downloadText(`${stem}.kml`, buildFullKML(source.finalDrones, source.positionHistory, source.scenario, source.thermalContacts), 'application/vnd.google-earth.kml+xml')}>KML</button>
            <button type="button" className="aar-btn" onClick={() => downloadText(`${stem}.geojson`, buildGeoJSON(source.finalDrones, source.positionHistory, source.scenario, source.thermalContacts), 'application/geo+json')}>GEOJSON</button>
          </div>
        </div>
      )}
    </article>
  )

  if (!dialog) return doc
  return createPortal(
    <div className="aar-overlay" role="dialog" aria-modal="true" aria-label="Mission report" data-testid="aar-overlay">
      {doc}
    </div>,
    document.body,
  )
}

export default AfterActionReport
