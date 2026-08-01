import { describe, expect, it } from 'vitest'
import { buildCustomMissionExport, missionFingerprint, parseCustomMissionImport } from '@/components/designer/customMissionImport'
import type { CustomMissionDefinition } from '@/types'

const mission: CustomMissionDefinition = {
  id: 'old-id',
  name: 'Fixture exercise',
  locationLabel: 'Synthetic sector A',
  purpose: 'Practice a route',
  endGoal: 'Recover safely',
  center: { lat: 34, lng: -118 },
  droneCount: 1,
  sites: [{ id: 'site-1', kind: 'field_icp', label: 'ICP', position: { lat: 34, lng: -118 }, capacityDrones: 1 }],
  launchAssignments: { 'uav-01': 'site-1' },
  recoveryAssignments: { 'uav-01': 'site-1' },
  routes: { 'uav-01': [{ id: 'wp-1', position: { lat: 34.001, lng: -118.001 }, altitudeFt: 120 }] },
  geographicMode: 'synthetic_training',
  createdAt: 1,
  updatedAt: 1,
}

describe('individual custom mission import', () => {
  it('accepts the versioned envelope, regenerates identity, and preserves content fingerprint', () => {
    const sourceFingerprint = missionFingerprint(mission)
    const parsed = parseCustomMissionImport(JSON.stringify(buildCustomMissionExport(mission)), () => 'new-id', 50)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.definition.id).toBe('new-id')
    expect(parsed.definition.createdAt).toBe(50)
    expect(parsed.fingerprint).toBe(sourceFingerprint)
  })

  it('rejects malformed, unsupported, and oversized input with recovery guidance', () => {
    expect(parseCustomMissionImport('{', () => 'id').ok).toBe(false)
    expect(parseCustomMissionImport(JSON.stringify({ kind: 'drone-sim-custom-mission', schemaVersion: 99 }), () => 'id')).toMatchObject({ ok: false })
    expect(parseCustomMissionImport(' '.repeat(256 * 1024 + 1), () => 'id')).toMatchObject({ ok: false })
  })

  it('fully validates imported coordinates and fleet doctrine', () => {
    const bad = structuredClone(mission)
    bad.center.lat = 91
    bad.droneCount = 8
    const parsed = parseCustomMissionImport(JSON.stringify(bad), () => 'id')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('Mission center coordinates are invalid')
  })
})
