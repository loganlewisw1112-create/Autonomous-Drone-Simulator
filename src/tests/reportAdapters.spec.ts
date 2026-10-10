import { describe, expect, it } from 'vitest'
import { reportSourceFromLive, reportSourceFromStoredRun } from '@/sim/demo/reportAdapters'
import { buildReportViewModel } from '@/sim/demo/reportViewModel'
import { buildVehicleTracks } from '@/sim/demo/reportVehicleTracks'
import { makeDrone, makeFixture, scenario } from './reportFixtures'
import type { MissionEvent } from '@/types'

describe('report adapters', () => {
  it('live and stored adapters produce the same timeline, map and chain for the same run', () => {
    const fx = makeFixture()
    const live = reportSourceFromLive(fx.live)!
    const stored = reportSourceFromStoredRun(fx.summary, fx.detail)!
    const a = buildReportViewModel(live)
    const b = buildReportViewModel(stored)
    expect(a.timeline).toEqual(b.timeline)
    expect(a.map).toEqual(b.map)
    expect(a.chain).toEqual(b.chain)
    expect(a.chain.status).toBe('verified')
    expect(a.scores).toEqual(b.scores)
  })

  it('a tampered event gives chain.verified=false with failureIndex = the tampered index (live and stored)', () => {
    const fx = makeFixture()
    const tampered: MissionEvent[] = fx.events.map((e, i) => (i === 5 ? { ...e, payload: { class: 'edited' } } : e))
    const live = reportSourceFromLive({ ...fx.live, events: tampered, replaySession: { ...fx.session, events: tampered } })!
    expect(live.chain).toMatchObject({ verified: false, failureIndex: 5, eventCount: tampered.length })
    const vm = buildReportViewModel(live)
    expect(vm.chain).toMatchObject({ status: 'failed', verified: false, label: 'FAIL', failureIndex: 5 })

    const stored = reportSourceFromStoredRun(fx.summary, { ...fx.detail, events: tampered })!
    expect(stored.chain).toMatchObject({ verified: false, failureIndex: 5 })
  })

  it('uses the replay session snapshot, not the scrubbed live fields', () => {
    const fx = makeFixture()
    const scrubbed = { ...fx.live, drones: [makeDrone('uav-01', { label: 'SCRUBBED' })], thermalContacts: [] }
    const source = reportSourceFromLive(scrubbed)!
    expect(source.finalDrones.map((d) => d.id)).toEqual(['uav-01', 'uav-02'])
    expect(source.thermalContacts).toHaveLength(1)
    expect(source.finalDrones.some((d) => d.label === 'SCRUBBED')).toBe(false)
  })

  it('returns null with no scenario (live) or no detail (stored)', () => {
    const fx = makeFixture()
    expect(reportSourceFromLive({ ...fx.live, scenario: null })).toBeNull()
    expect(reportSourceFromStoredRun(fx.summary, null)).toBeNull()
  })

  it('reports an empty live chain as no events instead of verified', () => {
    const fx = makeFixture()
    const source = reportSourceFromLive({ ...fx.live, events: [], replaySession: null })!
    expect(buildReportViewModel(source).chain.status).toBe('no-events')
  })

  it('stored run with no loaded road network yields no vehicle track and does not throw', () => {
    const fx = makeFixture()
    const withUnits = {
      ...fx.detail,
      replayFrames: [{
        ...fx.detail.replayFrames[0],
        groundUnits: [{ id: 'gu-1', role: 'recovery' as const, position: scenario.startPosition, status: 'on_scene' as const }],
        recoveryTeams: [{
          id: 'rt-1', droneId: 'uav-02', position: scenario.startPosition, targetPosition: scenario.startPosition,
          status: 'on_scene' as const, etaSec: 0, routePoints: [],
        }],
      }],
    }
    let source: ReturnType<typeof reportSourceFromStoredRun> = null
    expect(() => { source = reportSourceFromStoredRun(fx.summary, withUnits) }).not.toThrow()
    expect(source!.vehicleTracks).toBeUndefined()
    expect(() => buildReportViewModel(source!)).not.toThrow()
    expect(buildReportViewModel(source!).map.tracks).toEqual([])
  })

  it('a stored run with no replay frames still builds (thermal contacts fall back to none)', () => {
    const fx = makeFixture()
    const source = reportSourceFromStoredRun(fx.summary, { ...fx.detail, replayFrames: [] })!
    expect(source.thermalContacts).toEqual([])
    expect(source.vehicleTracks).toBeUndefined()
  })

  it('buildVehicleTracks with no units or teams returns no tracks', () => {
    expect(buildVehicleTracks([], [], scenario)).toBeUndefined()
  })
})
