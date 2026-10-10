/**
 * Offline HTML export of the after-action report (demo blocker c5b).
 *
 * `buildReportHtml(vm)` is pure: it turns the SAME ReportViewModel the in-app view renders into one
 * self-contained HTML document, so the file and the screen cannot drift apart. It reads no clock, no
 * DOM and no store, and the file it produces has:
 *   - one inline <style> and one inline <svg> map (no tiles: they would break offline viewing),
 *   - the Content-Security-Policy meta below, no <script>, and no external resource of any kind,
 *   - every dynamic string passed through the single `escapeHtml`,
 *   - every interpolated number passed through `Number.isFinite` first,
 *   - every colour re-validated here (the view model validates too, but this builder takes any vm).
 */
import type { ReportLegendEntry, ReportMap, ReportMapPoint, ReportViewModel } from '@/sim/demo/reportViewModel'

export const REPORT_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"

const FALLBACK_COLOR = '#00d4ff'
const DEFAULT_MAP_WIDTH = 800
const DEFAULT_MAP_HEIGHT = 520
const MAX_FILE_STEM = 60

// ─── Escaping and number guards ──────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** The only place dynamic text is made safe: & < > " ' become entities. Non-text input becomes ''. */
export function escapeHtml(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value !== 'string') return ''
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function finite(n: unknown, fallback = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/** Whole number as text; non-finite becomes 0. */
function int(n: unknown): string {
  return String(Math.round(finite(n)))
}

/** Percentage clamped to 0..100 as a whole number. */
function pctInt(n: unknown): number {
  return Math.min(100, Math.max(0, Math.round(finite(n))))
}

/** SVG coordinate (one decimal). Callers only pass points that already passed isPoint. */
function coord(n: number): string {
  return String(Math.round(n * 10) / 10)
}

function isPoint(p: ReportMapPoint | null | undefined): p is ReportMapPoint {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y)
}

function safeColor(color: unknown): string {
  return typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : FALLBACK_COLOR
}

function pointsAttr(points: readonly ReportMapPoint[] | undefined): string {
  return (points ?? []).filter(isPoint).map((p) => `${coord(p.x)},${coord(p.y)}`).join(' ')
}

function validPoints(points: readonly ReportMapPoint[] | undefined): ReportMapPoint[] {
  return (points ?? []).filter(isPoint)
}

// ─── Filename ────────────────────────────────────────────────────────────────────

/** `<sanitized-scenario-id>-report.html`: only A-Z a-z 0-9 _ - survive, so no path, dot or quote can get through. */
export function reportHtmlFilename(vm: Pick<ReportViewModel, 'summary'>): string {
  const raw = typeof vm.summary?.scenarioId === 'string' ? vm.summary.scenarioId : ''
  const stem = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_FILE_STEM)
    .replace(/-+$/, '')
  return `${stem || 'mission'}-report.html`
}

// ─── Styles ──────────────────────────────────────────────────────────────────────

// Every font-size below is >= 12px. No url(), no @import, no web fonts: system stacks only.
const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html { background: #0d1117; }
body {
  margin: 0;
  padding: 24px 16px 40px;
  background: #0d1117;
  color: #e6edf3;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
.doc { max-width: 920px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; line-height: 1.25; overflow-wrap: anywhere; }
h2 { margin: 0 0 10px; color: #58a6ff; font-size: 13px; letter-spacing: 1.6px; text-transform: uppercase; }
.headline { margin: 0 0 12px; color: #9aa7b4; font-size: 14px; overflow-wrap: anywhere; }
section { margin-top: 22px; padding-top: 14px; border-top: 1px solid #30363d; }
section:first-of-type { margin-top: 0; padding-top: 0; border-top: 0; }
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 0; }
.facts div { padding: 8px 10px; border: 1px solid #30363d; border-radius: 6px; background: #161b22; }
.facts dt { color: #9aa7b4; font-size: 12px; }
.facts dd { margin: 2px 0 0; font-size: 14px; font-weight: 700; overflow-wrap: anywhere; }
.timeline { margin: 0; padding: 0; list-style: none; }
.timeline li { display: grid; grid-template-columns: 72px 1fr auto; gap: 10px; padding: 5px 0; border-bottom: 1px solid #30363d; }
.time { color: #9aa7b4; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.count { color: #e3b341; }
.note { margin: 8px 0 0; color: #9aa7b4; font-size: 12px; }
.map { display: block; width: 100%; height: auto; max-height: 460px; border: 1px solid #30363d; border-radius: 6px; background: #0a1118; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 10px 0 0; padding: 0; list-style: none; font-size: 12px; }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 22px; height: 0; border-top: 3px solid currentColor; }
.swatch--dashed { border-top-style: dashed; }
.swatch--dotted { border-top-style: dotted; }
.swatch--fill { height: 10px; border: 1px solid currentColor; background: rgba(128, 160, 200, 0.22); }
.swatch--dot { width: 10px; height: 10px; border: 0; border-radius: 50%; background: currentColor; }
.score-total { margin: 0 0 8px; font-size: 18px; font-weight: 700; }
.objectives { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.objectives li { display: grid; grid-template-columns: 1fr auto; gap: 2px 12px; }
.bar { grid-column: 1 / -1; display: block; height: 8px; border-radius: 4px; background: #21262d; overflow: hidden; }
.bar > span { display: block; height: 100%; background: #58a6ff; }
.detail { color: #9aa7b4; font-size: 12px; }
.chain-status { margin: 0 0 8px; font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
.chain-status--verified { color: #3fb950; }
.chain-status--failed { color: #ff6b6b; }
.chain-status--no-events { color: #e3b341; }
.chain-detail { margin: 0 0 6px; }
.hash { display: block; margin-top: 2px; overflow-wrap: anywhere; color: #9aa7b4; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.foot { margin-top: 28px; padding-top: 12px; border-top: 1px solid #30363d; color: #9aa7b4; font-size: 12px; }
@media (max-width: 640px) {
  body { padding: 14px 12px 28px; }
  .timeline li { grid-template-columns: 64px 1fr; }
  .timeline li .count { grid-column: 2; }
}
@media print {
  html, body { background: #fff; color: #000; }
  body { padding: 0; }
  h1, h2, .headline, .time, .count, .note, .detail, .hash, .foot, .facts dt, .chain-status { color: #000; }
  section { break-inside: avoid; border-color: #999; }
  .facts div, .timeline li, .map, .foot { border-color: #999; }
  .facts div { background: #fff; }
  .map { max-height: none; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .legend { color: #000; }
  .bar { background: #ddd; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .bar > span { background: #000; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .chain-status--failed { font-weight: 900; }
}
`.trim()

// ─── Sections ────────────────────────────────────────────────────────────────────

const LEGEND_STYLES: ReadonlySet<string> = new Set(['solid', 'dashed', 'dotted', 'fill', 'dot'])
const CHAIN_STATUSES: ReadonlySet<string> = new Set(['verified', 'failed', 'no-events'])

function summarySection(vm: ReportViewModel): string {
  const { summary } = vm
  return [
    '<section id="summary" data-section="summary">',
    `<h1>${escapeHtml(summary.title)}</h1>`,
    `<p class="headline">${escapeHtml(summary.headline)}</p>`,
    '<h2>Summary</h2>',
    '<dl class="facts">',
    `<div><dt>Scenario</dt><dd>${escapeHtml(summary.scenarioName)}</dd></div>`,
    `<div><dt>Date</dt><dd>${escapeHtml(summary.dateLabel)}</dd></div>`,
    `<div><dt>Duration</dt><dd>${escapeHtml(summary.durationLabel)}</dd></div>`,
    `<div><dt>Drones</dt><dd>${int(summary.droneCount)}</dd></div>`,
    '</dl>',
    '</section>',
  ].join('\n')
}

function timelineSection(vm: ReportViewModel): string {
  const { timeline } = vm
  const rows = timeline.rows ?? []
  const body = rows.length === 0
    ? '<p class="note">No reportable events were recorded.</p>'
    : [
        '<ol class="timeline">',
        ...rows.map((row) => {
          const count = finite(row.count, 1)
          return `<li><span class="time">${escapeHtml(row.timeLabel)}</span><span>${escapeHtml(row.label)}</span>${count > 1 ? `<span class="count">&times;${int(count)}</span>` : '<span></span>'}</li>`
        }),
        '</ol>',
      ].join('\n')
  const omitted = finite(timeline.omittedRows)
  const omittedNote = omitted > 0
    ? `<p class="note">${int(omitted)} lower-priority rows are not shown (${int(timeline.relevantEventCount)} events in total).</p>`
    : ''
  return ['<section id="timeline" data-section="timeline">', '<h2>Timeline</h2>', body, omittedNote, '</section>']
    .filter(Boolean)
    .join('\n')
}

function mapSvg(map: ReportMap): string {
  const width = finite(map.width) > 0 ? finite(map.width) : DEFAULT_MAP_WIDTH
  const height = finite(map.height) > 0 ? finite(map.height) : DEFAULT_MAP_HEIGHT
  const parts: string[] = []

  const search = validPoints(map.searchArea)
  if (search.length >= 3) {
    parts.push(`<polygon points="${pointsAttr(search)}" fill="#58a6ff" fill-opacity="0.1" stroke="#58a6ff" stroke-width="1.5" stroke-dasharray="6 4"/>`)
  }
  for (const g of map.geofences ?? []) {
    const pts = validPoints(g.points)
    if (pts.length < 3) continue
    const color = g.kind === 'no_fly' ? '#ff5555' : '#ffaa00'
    parts.push(`<polygon points="${pointsAttr(pts)}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1.5"/>`)
  }
  for (const r of map.routes ?? []) {
    const pts = validPoints(r.points)
    const color = safeColor(r.color)
    if (pts.length > 1) {
      parts.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
    } else if (pts.length === 1) {
      parts.push(`<circle cx="${coord(pts[0].x)}" cy="${coord(pts[0].y)}" r="4" fill="${color}"/>`)
    }
  }
  for (const t of map.tracks ?? []) {
    const pts = validPoints(t.points)
    const color = safeColor(t.color)
    const drawn: string[] = []
    if (pts.length > 1) {
      drawn.push(`<polyline points="${pointsAttr(pts)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="7 5" stroke-linejoin="round"/>`)
    } else if (pts.length === 1) {
      drawn.push(`<rect x="${coord(pts[0].x - 4)}" y="${coord(pts[0].y - 4)}" width="8" height="8" fill="${color}"/>`)
    }
    if (t.onFoot && isPoint(t.onFoot.from) && isPoint(t.onFoot.to)) {
      drawn.push(`<line x1="${coord(t.onFoot.from.x)}" y1="${coord(t.onFoot.from.y)}" x2="${coord(t.onFoot.to.x)}" y2="${coord(t.onFoot.to.y)}" stroke="#c9d1d9" stroke-width="2" stroke-dasharray="1.5 4" stroke-linecap="round"/>`)
    }
    if (drawn.length > 0) parts.push(`<g>${drawn.join('')}</g>`)
  }
  for (const c of map.contacts ?? []) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue
    parts.push(`<circle cx="${coord(c.x)}" cy="${coord(c.y)}" r="5" fill="${c.resolved ? 'none' : '#ff7b54'}" stroke="#ff7b54" stroke-width="2"/>`)
  }
  if (isPoint(map.base)) {
    parts.push(`<rect x="${coord(map.base.x - 5)}" y="${coord(map.base.y - 5)}" width="10" height="10" fill="#3fb950" stroke="#ffffff" stroke-width="1"/>`)
  }

  return [
    `<svg class="map" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${coord(width)} ${coord(height)}" role="img" aria-label="Mission map: search area, geofences, flight tracks and contacts">`,
    '<title>Mission map</title>',
    ...parts,
    '</svg>',
  ].join('\n')
}

function legendList(legend: readonly ReportLegendEntry[]): string {
  if (legend.length === 0) return ''
  return [
    '<ul class="legend" aria-label="Map legend">',
    ...legend.map((entry) => {
      const style = LEGEND_STYLES.has(entry.style) ? entry.style : 'solid'
      const cls = style === 'solid' ? 'swatch' : `swatch swatch--${style}`
      return `<li><span class="${cls}" style="color:${safeColor(entry.color)}" aria-hidden="true"></span><span>${escapeHtml(entry.label)}</span></li>`
    }),
    '</ul>',
  ].join('\n')
}

function mapSection(vm: ReportViewModel): string {
  const { map } = vm
  return [
    '<section id="map" data-section="map">',
    '<h2>Map</h2>',
    map.empty ? '<p class="note">No position data was recorded for this run.</p>' : mapSvg(map),
    legendList(map.legend ?? []),
    '</section>',
  ]
    .filter(Boolean)
    .join('\n')
}

function scoresSection(vm: ReportViewModel): string {
  const mission = vm.scores.mission
  const objectives = mission.objectives ?? []
  const body = objectives.length === 0
    ? '<p class="note">No mission objectives were defined for this scenario.</p>'
    : [
        `<p class="score-total">${int(mission.percent)}% of mission objectives complete</p>`,
        '<ul class="objectives">',
        ...objectives.map((o) =>
          `<li><span>${escapeHtml(o.label)}</span><span>${int(o.percent)}% <span class="detail">(${escapeHtml(o.detail)})</span></span><span class="bar" aria-hidden="true"><span style="width:${pctInt(o.percent)}%"></span></span></li>`,
        ),
        '</ul>',
      ].join('\n')
  return ['<section id="scores" data-section="scores">', '<h2>Mission objectives</h2>', body, '</section>'].join('\n')
}

function chainSection(vm: ReportViewModel): string {
  const { chain } = vm
  const status = CHAIN_STATUSES.has(chain.status) ? chain.status : 'failed'
  const failedAt = chain.failureIndex !== null && Number.isFinite(chain.failureIndex)
    ? ` (first failing link: #${int(finite(chain.failureIndex) + 1)})`
    : ''
  const records = int(chain.eventCount)
  let detail: string
  if (status === 'verified' && chain.verified === true) {
    detail = `Chain verified: each of the ${records} records is linked to the one before it, back to the first record.`
  } else if (status === 'no-events') {
    detail = 'No event records were captured, so there is nothing to verify.'
  } else {
    detail = 'The hash chain does not verify: a record was altered, removed or reordered after it was written.'
  }
  return [
    '<section id="chain" data-section="chain">',
    '<h2>Chain of custody</h2>',
    `<p id="chain-status" class="chain-status chain-status--${status}">Event chain: ${escapeHtml(chain.label)}${failedAt}</p>`,
    `<p class="chain-detail">${escapeHtml(detail)}</p>`,
    `<div>${records} application event records</div>`,
    `<code class="hash">Head hash ${escapeHtml(chain.headHash)}</code>`,
    '<p class="note">Application event-custody records only. External custody is not implied.</p>',
    '</section>',
  ].join('\n')
}

// ─── Document ────────────────────────────────────────────────────────────────────

export function buildReportHtml(vm: ReportViewModel): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${REPORT_HTML_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(vm.summary.title)}</title>`,
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main class="doc">',
    summarySection(vm),
    timelineSection(vm),
    mapSection(vm),
    scoresSection(vm),
    chainSection(vm),
    `<p class="foot">Generated ${escapeHtml(vm.summary.dateLabel)}. Self-contained file: no scripts and no external resources.</p>`,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
