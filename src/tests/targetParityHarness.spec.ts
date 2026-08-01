import { describe, expect, it } from 'vitest'
import { buildTargetParityManifest } from '@/parity/artifactParity'

const build = {
  target: 'windows' as const,
  version: 'test',
  gitSha: '0'.repeat(40),
}

describe('target parity mission harness', () => {
  it('produces repeatable terrain, building, thermal, replay and event evidence', async () => {
    const first = await buildTargetParityManifest(build)
    const second = await buildTargetParityManifest(build)

    expect(second).toEqual(first)
    expect(first.fixtures.terrainPackageIds).toHaveLength(7)
    expect(first.fixtures.terrainScenarioIds).toContain('nist_obstructed_lane')
    expect(first.fixtures.buildingScenarioIds).toEqual(
      expect.arrayContaining(['demo_wildfire', 'hist_surfside_cts_2021']),
    )
    expect(first.missions.map((mission) => mission.kind)).toEqual([
      'terrain',
      'building',
      'thermal',
    ])
    expect(new Set(first.missions.map((mission) => mission.digest)).size).toBe(3)
    expect(first.missions.every((mission) => mission.eventCount >= 2)).toBe(true)
    expect(first.missions.every((mission) => mission.replayFrameCount === 6)).toBe(true)
    expect(first.missions.find((mission) => mission.kind === 'building')?.safetyDecisionCount)
      .toBeGreaterThan(0)
    expect(first.missions.find((mission) => mission.kind === 'thermal')?.detectionCount)
      .toBeGreaterThan(0)
    expect(first.aggregateDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the simulation evidence target-neutral', async () => {
    const windows = await buildTargetParityManifest(build)
    const mobile = await buildTargetParityManifest({ ...build, target: 'mobile' })
    const classroom = await buildTargetParityManifest({ ...build, target: 'classroom' })

    expect(mobile.fixtures).toEqual(windows.fixtures)
    expect(classroom.fixtures).toEqual(windows.fixtures)
    expect(mobile.missions).toEqual(windows.missions)
    expect(classroom.missions).toEqual(windows.missions)
    expect(mobile.aggregateDigest).toBe(windows.aggregateDigest)
    expect(classroom.aggregateDigest).toBe(windows.aggregateDigest)
  })
})
