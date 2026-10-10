import { describe, expect, it } from 'vitest'
import {
  MAX_TIMELINE_ROWS,
  RECOVERY_TRACK_COLOR,
  buildReportViewModel,
  projectToSvg,
  type ReportSource,
} from '@/sim/demo/reportViewModel'
import { reportSourceFromLive } from '@/sim/demo/reportAdapters'
import { chainFrom, FIXED_ISO, makeFixture, scenario, type EventSpec } from './reportFixtures'

function sourceOf(fx = makeFixture()): ReportSource {
  const source = reportSourceFromLive(fx.live)
  if (!source) throw new Error('fixture has a scenario')
  // Pin the clock-derived field so the snapshot is stable.
  return { ...source, package: fx.pkg, generatedAtIso: FIXED_ISO }
}

describe('buildReportViewModel', () => {
  it('matches the committed snapshot for a fixed-timestamp mission', () => {
    expect(buildReportViewModel(sourceOf())).toMatchSnapshot()
  })

  it('is pure: the same source gives a deep-equal model and the timestamp is the injected one', () => {
    const source = sourceOf()
    const a = buildReportViewModel(source)
    const b = buildReportViewModel(source)
    expect(a).toEqual(b)
    expect(a.generatedAtIso).toBe(FIXED_ISO)
    expect(a.summary.dateLabel).toBe('2026-10-09 12:00 UTC')
  })

  it('emits the five sections in order: summary, timeline, map, scores, chain', () => {
    expect(Object.keys(buildReportViewModel(sourceOf())).filter((k) => k !== 'generatedAtIso')).toEqual([
      'summary', 'timeline', 'map', 'scores', 'chain',
    ])
  })

  it('writes the new recovery labels and resolves UAV labels from finalDrones', () => {
    const labels = buildReportViewModel(sourceOf()).timeline.rows.map((r) => r.label)
    expect(labels).toContain('UAV-02 down: recovery team dispatched (no road data)')
    expect(labels).toContain('Recovery team on scene at UAV-02')
    expect(labels).toContain('Ground unit on scene')
    expect(labels).toContain('UAV-02 recovered')
    expect(labels).toContain('Operator aborted recovery of UAV-02')
    // Not in the report's event list.
    expect(labels.join('|')).not.toMatch(/waypoint/i)
  })

  it('drops the (no road data) suffix when roadAccess is not "none"', () => {
    const specs: EventSpec[] = [[0, 'uav-01', 'mission_start'], [10, 'uav-02', 'drone_recovery_requested', { roadAccess: 'full' }]]
    const fx = makeFixture(specs)
    const labels = buildReportViewModel(sourceOf(fx)).timeline.rows.map((r) => r.label)
    expect(labels).toContain('UAV-02 down: recovery team dispatched')
  })

  it('falls back to the upper-cased drone id when the drone is unknown', () => {
    const fx = makeFixture([[0, 'uav-09', 'drone_recovered', { teamId: 'rt-9' }]])
    expect(buildReportViewModel(sourceOf(fx)).timeline.rows[0].label).toBe('UAV-09 recovered')
  })

  it('collapses consecutive identical events into one counted row', () => {
    const fx = makeFixture([
      [0, 'uav-01', 'mission_start'],
      [10, 'uav-01', 'comms_lost'], [11, 'uav-01', 'comms_lost'], [12, 'uav-01', 'comms_lost'],
      [20, 'uav-01', 'comms_restored'],
    ])
    const rows = buildReportViewModel(sourceOf(fx)).timeline.rows
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['Mission started', 1], ['UAV-01 link lost', 3], ['UAV-01 link restored', 1],
    ])
  })

  it('caps the timeline at 30 rows, keeping start and complete and dropping low-priority rows first', () => {
    const specs: EventSpec[] = [[0, 'uav-01', 'mission_start']]
    for (let i = 0; i < 80; i++) specs.push([10 + i, 'uav-01', 'operator_command', { command: `cmd_${i}` }])
    specs.push([500, 'uav-01', 'emergency_land'], [600, 'system', 'mission_complete'])
    const timeline = buildReportViewModel(sourceOf(makeFixture(specs))).timeline
    expect(timeline.rows).toHaveLength(MAX_TIMELINE_ROWS)
    expect(timeline.omittedRows).toBe(83 - MAX_TIMELINE_ROWS)
    const labels = timeline.rows.map((r) => r.label)
    expect(labels[0]).toBe('Mission started')
    expect(labels).toContain('UAV-01 emergency landing')
    expect(labels.at(-1)).toBe('Mission complete')
    // chronological order is preserved
    const times = timeline.rows.map((r) => r.tSec)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('builds objective scores through buildMissionProgress and leaves scores as a typed slot', () => {
    const vm = buildReportViewModel(sourceOf())
    expect(vm.scores.mission.objectives.length).toBeGreaterThan(0)
    expect(vm.scores.mission.percent).toBeGreaterThanOrEqual(0)
    expect(vm.scores.mission.percent).toBeLessThanOrEqual(100)
    for (const o of vm.scores.mission.objectives) {
      expect(Number.isFinite(o.percent)).toBe(true)
      expect(o.detail.length).toBeGreaterThan(0)
    }
    expect(Object.keys(vm.scores)).toEqual(['mission'])
  })

  it('reports chain verified / FAIL / no events', () => {
    const ok = buildReportViewModel(sourceOf()).chain
    expect(ok).toMatchObject({ status: 'verified', verified: true, label: 'VERIFIED', failureIndex: null })

    const source = sourceOf()
    const failed = buildReportViewModel({ ...source, chain: { ...source.chain, verified: false, failureIndex: 4 } }).chain
    expect(failed).toMatchObject({ status: 'failed', verified: false, label: 'FAIL', failureIndex: 4 })

    const none = buildReportViewModel({ ...source, chain: { verified: false, eventCount: 0, headHash: '0'.repeat(64) } }).chain
    expect(none).toMatchObject({ status: 'no-events', verified: false })
  })

  it('never emits a non-finite number or an unsafe colour into the map', () => {
    const source = sourceOf()
    const bad = {
      ...source,
      finalDrones: source.finalDrones.map((d, i) => (i === 0 ? { ...d, color: 'red;" onload="x' } : d)),
      positionHistory: { ...source.positionHistory, 'uav-01': [{ lat: NaN, lng: 1 }, ...source.positionHistory['uav-01']] },
    }
    const map = buildReportViewModel(bad).map
    const nums = [map.width, map.height, ...map.routes.flatMap((r) => r.points.flatMap((p) => [p.x, p.y]))]
    expect(nums.every(Number.isFinite)).toBe(true)
    expect(map.routes.every((r) => /^#[0-9a-fA-F]{3,8}$/.test(r.color))).toBe(true)
  })

  it('exposes no vehicle tracks when none are supplied', () => {
    const vm = buildReportViewModel(sourceOf())
    expect(vm.map.tracks).toEqual([])
    expect(vm.map.legend.some((l) => l.key.endsWith('-track'))).toBe(false)
  })

  it('draws supplied vehicle tracks dashed in the unit colour, with a legend, inside the bounds', () => {
    const s = scenario.startPosition
    const far = { lat: s.lat + 0.05, lng: s.lng + 0.05 }
    const withTracks: ReportSource = {
      ...sourceOf(),
      vehicleTracks: [
        { id: 'rt-1', kind: 'recovery', points: [s, { lat: s.lat + 0.02, lng: s.lng + 0.03 }, far], onFootTo: { lat: far.lat + 0.001, lng: far.lng } },
        { id: 'gu-1', kind: 'ground', points: [s, { lat: s.lat + 0.01, lng: s.lng }] },
      ],
    }
    const base = buildReportViewModel(sourceOf()).map
    const vm = buildReportViewModel(withTracks).map
    expect(vm.tracks).toHaveLength(2)
    const recovery = vm.tracks.find((t) => t.kind === 'recovery')!
    expect(recovery.color).toBe(RECOVERY_TRACK_COLOR)
    expect(recovery.onFoot).not.toBeNull()
    expect(vm.legend.map((l) => l.key)).toEqual(expect.arrayContaining(['recovery-track', 'ground-track', 'on-foot']))
    expect(vm.legend.find((l) => l.key === 'recovery-track')?.style).toBe('dashed')
    // Bounds include the tracks: every projected point stays inside the canvas, and the canvas/projection changed.
    for (const t of vm.tracks) {
      for (const p of t.points) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(vm.width)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(vm.height)
      }
    }
    expect(vm.base).not.toEqual(base.base)
  })

  it('a one-point track draws the final position only', () => {
    const s = scenario.startPosition
    const vm = buildReportViewModel({ ...sourceOf(), vehicleTracks: [{ id: 'rt-1', kind: 'recovery', points: [s] }] }).map
    expect(vm.tracks[0].points).toHaveLength(1)
  })
})

describe('projectToSvg', () => {
  const at = (lat: number, lng: number) => ({ lat, lng })

  it('handles an empty history: default canvas, centred, finite', () => {
    const p = projectToSvg([])
    expect(p.width).toBeGreaterThan(0)
    expect(p.height).toBeGreaterThan(0)
    expect(p.project(at(1, 2))).toEqual({ x: p.width / 2, y: p.height / 2 })
  })

  it('handles a single point: centred, no NaN', () => {
    const p = projectToSvg([at(40, -105)])
    const out = p.project(at(40, -105))
    expect(out).toEqual({ x: p.width / 2, y: p.height / 2 })
    expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true)
  })

  it('ignores non-finite points', () => {
    const p = projectToSvg([at(NaN, 0), at(40, -105), at(40.01, -105.01)])
    const out = p.project(at(40.005, -105.005))
    expect(Number.isFinite(out.x) && Number.isFinite(out.y)).toBe(true)
  })

  it('flips y so north is up, and east is right', () => {
    const p = projectToSvg([at(40, -105), at(40.01, -104.99)])
    const sw = p.project(at(40, -105))
    const ne = p.project(at(40.01, -104.99))
    expect(ne.y).toBeLessThan(sw.y)
    expect(ne.x).toBeGreaterThan(sw.x)
  })

  it('keeps the aspect ratio: equal metres on both axes project to equal pixels (cos(lat) scaling)', () => {
    const lat = 60
    const dLat = 0.01
    const dLng = dLat / Math.cos((lat * Math.PI) / 180)
    const p = projectToSvg([at(lat, 10), at(lat + dLat, 10 + dLng)])
    const a = p.project(at(lat, 10))
    const b = p.project(at(lat + dLat, 10 + dLng))
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(b.y - a.y), 0)
  })

  it('fits wide and tall extents inside the padded canvas without distortion', () => {
    for (const pts of [
      [at(40, -105), at(40.001, -104.9)],
      [at(40, -105), at(40.2, -104.999)],
    ]) {
      const p = projectToSvg(pts)
      for (const pt of pts) {
        const o = p.project(pt)
        expect(o.x).toBeGreaterThanOrEqual(0)
        expect(o.x).toBeLessThanOrEqual(p.width)
        expect(o.y).toBeGreaterThanOrEqual(0)
        expect(o.y).toBeLessThanOrEqual(p.height)
      }
    }
  })
})

describe('event chain fixture', () => {
  it('builds a verifiable chain (guards the snapshot fixture itself)', () => {
    expect(chainFrom([[0, 'uav-01', 'mission_start']])).toHaveLength(1)
  })
})
