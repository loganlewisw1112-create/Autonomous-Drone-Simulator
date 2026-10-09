// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildReportHtml, escapeHtml, reportHtmlFilename, REPORT_HTML_CSP } from '@/sim/demo/reportHtml'
import { buildReportViewModel, type ReportSource, type ReportViewModel } from '@/sim/demo/reportViewModel'
import { reportSourceFromLive } from '@/sim/demo/reportAdapters'
import { buildEvent, getGenesisHash } from '@/utils/chainOfCustody'
import type { MissionEvent } from '@/types'
import { FIXED_ISO, makeFixture, type EventSpec } from './reportFixtures'

const SCRIPT_PAYLOAD = '<img src=x onerror=alert(1)>'
const OPERATOR_PAYLOAD = 'operator:<b>x'
const DRONE_LABEL_PAYLOAD = 'UAV "><script>alert(2)</script>'

function liveSource(fx = makeFixture()): ReportSource {
  const source = reportSourceFromLive(fx.live)
  if (!source) throw new Error('fixture has a scenario')
  return { ...source, package: fx.pkg, generatedAtIso: FIXED_ISO }
}

function vmOf(fx = makeFixture()): ReportViewModel {
  return buildReportViewModel(liveSource(fx))
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** A valid hash chain whose events carry hostile strings in every free-text slot a report could read. */
function hostileChain(): MissionEvent[] {
  const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(FIXED_ISO))
  try {
    const specs: Array<[number, string, EventSpec[2], Record<string, unknown>]> = [
      [0, 'system', 'preflight_complete', {}],
      [0, 'uav-01', 'mission_start', {}],
      [20, 'uav-01', 'sortie_launch', {}],
      [400, 'uav-01', 'thermal_detection', { class: SCRIPT_PAYLOAD, sourceId: 'hs-1' }],
      [450, OPERATOR_PAYLOAD, 'operator_command', { command: OPERATOR_PAYLOAD, operatorId: OPERATOR_PAYLOAD }],
      [1400, 'system', 'mission_complete', {}],
    ]
    const events: MissionEvent[] = []
    let prev = getGenesisHash()
    for (const [tick, droneId, type, payload] of specs) {
      const event = buildEvent(prev, tick, droneId, OPERATOR_PAYLOAD, 'pic', type, payload)
      events.push(event)
      prev = event.hash
    }
    return events
  } finally {
    spy.mockRestore()
  }
}

function hostileVm(): ReportViewModel {
  const fx = makeFixture()
  const events = hostileChain()
  const live = {
    ...fx.live,
    events,
    scenario: { ...fx.live.scenario!, name: SCRIPT_PAYLOAD },
    drones: fx.drones.map((d, i) => (i === 0 ? { ...d, label: DRONE_LABEL_PAYLOAD } : d)),
    replaySession: null,
  }
  const source = reportSourceFromLive(live)!
  return buildReportViewModel({
    ...source,
    generatedAtIso: FIXED_ISO,
    package: {
      ...fx.pkg,
      scenarioName: SCRIPT_PAYLOAD,
      missionReport: { ...fx.pkg.missionReport, title: SCRIPT_PAYLOAD },
    },
  })
}

/** Replaces every string leaf (including enum-like slots and colours) and optionally every number. */
function mapLeaves(value: unknown, onString: (s: string) => string, onNumber: (n: number) => number): unknown {
  if (typeof value === 'string') return onString(value)
  if (typeof value === 'number') return onNumber(value)
  if (Array.isArray(value)) return value.map((v) => mapLeaves(v, onString, onNumber))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapLeaves(v, onString, onNumber)]))
  }
  return value
}

const NETWORK_URL = /^\s*(?:https?:)?\/\//i

afterEach(() => vi.restoreAllMocks())

describe('buildReportHtml: content', () => {
  it('contains the mission objectives and the chain-verified text', () => {
    const vm = vmOf()
    const html = buildReportHtml(vm)
    const text = parse(html).body.textContent ?? ''
    expect(vm.scores.mission.objectives.length).toBeGreaterThan(0)
    for (const objective of vm.scores.mission.objectives) {
      expect(text).toContain(objective.label)
      expect(text).toContain(`${objective.percent}%`)
    }
    expect(text).toContain(`${vm.scores.mission.percent}% of mission objectives complete`)
    expect(text).toMatch(/Event chain: VERIFIED/)
    expect(text).toMatch(/Chain verified/)
    expect(text).toContain(vm.chain.headHash)
    expect(text).toContain(`${vm.chain.eventCount} application event records`)
  })

  it('renders the same five sections in the same order as the in-app report, and every timeline row', () => {
    const vm = vmOf()
    const doc = parse(buildReportHtml(vm))
    expect(Array.from(doc.querySelectorAll('[data-section]')).map((el) => el.getAttribute('data-section'))).toEqual([
      'summary', 'timeline', 'map', 'scores', 'chain',
    ])
    expect(doc.querySelectorAll('[data-section="timeline"] li').length).toBe(vm.timeline.rows.length)
    for (const row of vm.timeline.rows) expect(doc.body.textContent).toContain(row.label)
    expect(doc.querySelector('title')?.textContent).toBe(vm.summary.title)
    expect(doc.documentElement.getAttribute('lang')).toBe('en')
    expect(doc.body.textContent).toContain(vm.summary.dateLabel)
  })

  it('draws the map as one inline svg with the supplied routes, contacts, base and dashed vehicle tracks', () => {
    const fx = makeFixture()
    const s = fx.live.scenario!.startPosition
    const source = {
      ...liveSource(fx),
      vehicleTracks: [{ id: 'rt-1', kind: 'recovery' as const, points: [s, { lat: s.lat + 0.01, lng: s.lng + 0.01 }], onFootTo: { lat: s.lat + 0.011, lng: s.lng + 0.011 } }],
    }
    const vm = buildReportViewModel(source)
    const doc = parse(buildReportHtml(vm))
    const svgs = doc.querySelectorAll('svg.map')
    expect(svgs.length).toBe(1)
    expect(svgs[0].getAttribute('viewBox')).toBe(`0 0 ${vm.map.width} ${vm.map.height}`)
    expect(svgs[0].getAttribute('role')).toBe('img')
    expect(svgs[0].querySelectorAll('polyline').length).toBeGreaterThanOrEqual(vm.map.routes.filter((r) => r.points.length > 1).length + 1)
    const recovery = Array.from(svgs[0].querySelectorAll('polyline')).find((el) => el.getAttribute('stroke') === '#ff88ff')
    expect(recovery?.getAttribute('stroke-dasharray')).toBeTruthy()
    expect(svgs[0].querySelectorAll('circle').length).toBeGreaterThanOrEqual(vm.map.contacts.length)
    for (const entry of vm.map.legend) expect(doc.body.textContent).toContain(entry.label)
  })

  it('says so instead of drawing an empty map when there is no position data', () => {
    const vm = vmOf()
    const empty = { ...vm, map: { ...vm.map, empty: true, routes: [], contacts: [], searchArea: [], geofences: [], tracks: [], base: null, legend: [] } }
    const doc = parse(buildReportHtml(empty))
    expect(doc.querySelector('svg.map')).toBeNull()
    expect(doc.body.textContent).toContain('No position data was recorded for this run.')
  })

  it('is pure and self-describing: identical output for identical input, print CSS present', () => {
    const vm = vmOf()
    const html = buildReportHtml(vm)
    expect(buildReportHtml(vm)).toBe(html)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('@media print')
    const source = readFileSync('src/sim/demo/reportHtml.ts', 'utf8')
    expect(source).not.toMatch(/Date\.now|Math\.random|new Date|document\.|window\.|Blob|localStorage/)
  })
})

describe('buildReportHtml: offline and CSP guarantees', () => {
  const html = buildReportHtml(vmOf())
  const doc = parse(html)

  it('carries the exact Content-Security-Policy meta', () => {
    expect(REPORT_HTML_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    const metas = Array.from(doc.querySelectorAll('meta[http-equiv]'))
    expect(metas.length).toBe(1)
    expect(metas[0].getAttribute('http-equiv')).toBe('Content-Security-Policy')
    expect(metas[0].getAttribute('content')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:")
    expect(doc.querySelector('meta[charset]')?.getAttribute('charset')?.toLowerCase()).toBe('utf-8')
  })

  it('parses in jsdom with zero script elements and no active or embedding elements', () => {
    expect(doc.querySelectorAll('script').length).toBe(0)
    expect(html).not.toMatch(/<script/i)
    for (const tag of ['iframe', 'object', 'embed', 'link', 'base', 'form', 'img', 'audio', 'video', 'source', 'frame', 'applet']) {
      expect(doc.querySelectorAll(tag).length, tag).toBe(0)
    }
    expect(doc.querySelectorAll('style').length).toBe(1)
    expect(doc.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
  })

  it('has no inline event handlers and no javascript: urls', () => {
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith('on'), `${el.tagName}.${attr.name}`).toBe(false)
        expect(attr.value).not.toMatch(/javascript:/i)
      }
    }
  })

  it('has no src=, href= or url( values pointing at http(s) or protocol-relative addresses (xmlns is allowed)', () => {
    const urlAttrs = ['src', 'href', 'srcset', 'xlink:href', 'action', 'formaction', 'poster', 'data', 'background', 'cite', 'ping']
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const name of urlAttrs) {
        const value = el.getAttribute(name)
        if (value !== null) expect(value, `${el.tagName}[${name}]`).not.toMatch(NETWORK_URL)
      }
      expect(el.getAttribute('style') ?? '').not.toMatch(/url\(\s*['"]?\s*(?:https?:)?\/\//i)
    }
    const css = Array.from(doc.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n')
    expect(css).not.toMatch(/url\(\s*['"]?\s*(?:https?:)?\/\//i)
    expect(css).not.toMatch(/@import/i)
    // The only absolute address allowed anywhere in the document is the SVG namespace declaration.
    const withoutXmlns = html.replace(/xmlns(?::\w+)?="[^"]*"/g, '')
    expect(withoutXmlns).not.toMatch(/https?:\/\//i)
    expect(withoutXmlns).not.toMatch(/(?:src|href)\s*=\s*["']?\/\//i)
  })

  it('keeps every font size at 12px or larger', () => {
    const css = Array.from(doc.querySelectorAll('style')).map((s) => s.textContent ?? '').join('\n')
    const sizes = Array.from(css.matchAll(/font(?:-size)?\s*:[^;}]*?(\d+(?:\.\d+)?)\s*(px|pt|em|rem|%)/g))
    expect(sizes.length).toBeGreaterThan(3)
    for (const [, size, unit] of sizes) {
      expect(unit).toBe('px')
      expect(Number(size)).toBeGreaterThanOrEqual(12)
    }
    expect(html).not.toMatch(/font-size\s*:\s*(?:xx-small|x-small|small|smaller)\b/i)
  })
})

describe('buildReportHtml: chain failure', () => {
  it('shows FAIL and the first failing link for a tampered chain, and never claims verified', () => {
    const fx = makeFixture()
    const tampered = fx.events.map((e, i) => (i === 3 ? { ...e, payload: { x: 1 } } : e))
    const source = reportSourceFromLive({ ...fx.live, events: tampered, replaySession: { ...fx.session, events: tampered } })!
    const vm = buildReportViewModel(source)
    expect(vm.chain.verified).toBe(false)
    const html = buildReportHtml(vm)
    const doc = parse(html)
    const status = doc.querySelector('#chain-status')
    expect(status?.textContent).toMatch(/Event chain: FAIL/)
    expect(status?.textContent).toContain('#4')
    expect(status?.className).toContain('failed')
    const text = doc.body.textContent ?? ''
    expect(text).not.toMatch(/Event chain: VERIFIED/)
    expect(text).not.toMatch(/Chain verified/)
  })

  it('shows a distinct message when no events were recorded', () => {
    const vm = vmOf()
    const empty: ReportViewModel = { ...vm, chain: { ...vm.chain, status: 'no-events', verified: false, label: 'NO EVENTS RECORDED', eventCount: 0, failureIndex: null } }
    const text = parse(buildReportHtml(empty)).body.textContent ?? ''
    expect(text).toMatch(/Event chain: NO EVENTS RECORDED/)
    expect(text).not.toMatch(/Chain verified/)
  })
})

describe('buildReportHtml: escaping', () => {
  it('escapes a hostile scenario name, operator id and drone label; the raw strings never appear', () => {
    const vm = hostileVm()
    // Sanity: the hostile strings really did reach the view model through the real pipeline.
    const reachable = JSON.stringify(vm)
    expect(reachable).toContain(SCRIPT_PAYLOAD.replace(/"/g, '\\"'))
    expect(reachable).toContain(OPERATOR_PAYLOAD)
    expect(reachable).toContain('UAV \\"><script>alert(2)</script>')

    const html = buildReportHtml(vm)
    expect(html).not.toContain(SCRIPT_PAYLOAD)
    expect(html).not.toContain(OPERATOR_PAYLOAD)
    expect(html).not.toContain(DRONE_LABEL_PAYLOAD)
    expect(html).not.toContain('<b>x')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('operator:&lt;b&gt;x')
    expect(html).toContain('UAV &quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;')

    const doc = parse(html)
    expect(doc.querySelectorAll('img, b, script').length).toBe(0)
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      expect(el.hasAttribute('onerror')).toBe(false)
      expect(el.getAttribute('src')).toBeNull()
    }
    // They are shown as text, not dropped.
    const text = doc.body.textContent ?? ''
    expect(text).toContain(SCRIPT_PAYLOAD)
    expect(text).toContain(OPERATOR_PAYLOAD)
    expect(doc.querySelector('title')?.textContent).toBe(SCRIPT_PAYLOAD)
  })

  it('escapeHtml covers & < > " \' and tolerates non-strings', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml('&amp;')).toBe('&amp;amp;')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })

  it('survives a hostile string in EVERY text slot, including enum-like slots and colours', () => {
    const vm = hostileVm()
    const attack = `"><img src=x onerror=alert(1)><script>alert(1)</script>'&`
    const poisoned = mapLeaves(vm, () => attack, (n) => n) as ReportViewModel
    const html = buildReportHtml(poisoned)
    const doc = parse(html)
    expect(doc.querySelectorAll('script, img, iframe, object, embed, link, base, form').length).toBe(0)
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith('on'), `${el.tagName}.${attr.name}`).toBe(false)
    }
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain(attack)
    // Colours are re-validated by the builder: no attack text ever lands inside a style or paint attribute.
    for (const el of Array.from(doc.querySelectorAll('[style], [stroke], [fill]'))) {
      const painted = `${el.getAttribute('style') ?? ''}${el.getAttribute('stroke') ?? ''}${el.getAttribute('fill') ?? ''}`
      expect(painted).not.toMatch(/[<>"']|script|onerror/i)
    }
  })

  it('never interpolates a non-finite number, undefined or a stray object', () => {
    const vm = hostileVm()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const poisoned = mapLeaves(vm, (s) => s, () => bad) as ReportViewModel
      const html = buildReportHtml(poisoned)
      expect(html, String(bad)).not.toMatch(/NaN|Infinity|undefined|\[object/)
      const doc = parse(html)
      for (const el of Array.from(doc.querySelectorAll('svg *'))) {
        for (const attr of Array.from(el.attributes)) expect(attr.value, `${el.tagName}.${attr.name}`).not.toMatch(/NaN|Infinity/)
      }
    }
  })

  it('does not throw on a minimal, partly missing view model', () => {
    const vm = vmOf()
    const bare = { ...vm, timeline: { ...vm.timeline, rows: [] }, scores: { mission: { percent: 0, objectives: [] } } }
    const doc = parse(buildReportHtml(bare))
    expect(doc.body.textContent).toContain('No reportable events were recorded.')
    expect(doc.querySelectorAll('[data-section]').length).toBe(5)
  })
})

describe('reportHtmlFilename', () => {
  it('is built from the sanitized scenario id', () => {
    const vm = vmOf()
    expect(reportHtmlFilename(vm)).toBe(`${vm.summary.scenarioId.replace(/[^A-Za-z0-9_-]+/g, '-')}-report.html`)
  })

  it('strips path separators, dots, quotes, control characters and reserved characters', () => {
    const vm = vmOf()
    for (const evil of ['../../etc/passwd', '..\\..\\win.ini', 'a<b>c:"d|e?f*g', 'name\u0000\r\n.exe', '"><script>x</script>', '   ', '', '日本語']) {
      const name = reportHtmlFilename({ ...vm, summary: { ...vm.summary, scenarioId: evil } })
      expect(name, evil).toMatch(/^[A-Za-z0-9_-]+-report\.html$/)
      expect(name).not.toContain('..')
    }
    expect(reportHtmlFilename({ ...vm, summary: { ...vm.summary, scenarioId: '' } })).toBe('mission-report.html')
  })

  it('caps the length', () => {
    const vm = vmOf()
    const name = reportHtmlFilename({ ...vm, summary: { ...vm.summary, scenarioId: 'x'.repeat(500) } })
    expect(name.length).toBeLessThanOrEqual(60 + '-report.html'.length)
  })
})
