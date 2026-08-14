import { describe, expect, it } from 'vitest'
import {
  MAX_WAYPOINTS_PER_DRONE,
  compileCustomMission,
  customDroneId,
  validateCustomMission,
} from '@/components/designer/designerValidation'
import { resolveRtbDestination } from '@/sim/mission/rtbDestination'
import type { CustomMissionDefinition, Geofence } from '@/types'

function validDefinition(): CustomMissionDefinition {
  const droneId = customDroneId(0)
  return {
    id: 'mission-1',
    name: 'Downtown response',
    locationLabel: 'Los Angeles',
    purpose: 'Inspect the incident perimeter.',
    endGoal: 'Confirm every assigned waypoint is clear.',
    center: { lat: 34.0522, lng: -118.2437 },
    droneCount: 1,
    sites: [{ id: 'site-1', kind: 'building_rooftop', label: 'Station roof', position: { lat: 34.052, lng: -118.244 }, capacityDrones: 1 }],
    launchAssignments: { [droneId]: 'site-1' },
    recoveryAssignments: { [droneId]: 'site-1' },
    routes: { [droneId]: [{ id: 'wp-1', label: 'Perimeter', position: { lat: 34.053, lng: -118.242 }, altitudeFt: 120, dwellTimeSec: 5 }] },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('custom mission designer validation', () => {
  it('compiles a complete definition without changing its authored route', () => {
    const definition = validDefinition()
    const result = validateCustomMission(definition)
    expect(result.valid).toBe(true)
    const compiled = compileCustomMission(definition)
    expect(compiled.isCustom).toBe(true)
    expect(compiled.authoredRoutes?.[customDroneId(0)]).toEqual(definition.routes[customDroneId(0)])
    expect(compiled.defaultLaunchAssignments).toEqual({ [customDroneId(0)]: 'site-1' })
    expect(compiled.defaultRecoveryAssignments).toEqual({ [customDroneId(0)]: 'site-1' })
    expect(compiled.launchSites?.['site-1']?.id).toBe('site-1')
    expect(compiled.recoverySites?.['site-1']?.id).toBe('site-1')
  })

  it('rejects altitude, missing assignment, capacity, and waypoint-limit failures', () => {
    const definition = validDefinition()
    definition.droneCount = 2
    definition.routes[customDroneId(0)][0].altitudeFt = 401
    definition.routes[customDroneId(0)] = Array.from({ length: MAX_WAYPOINTS_PER_DRONE + 1 }, (_, index) => ({
      id: `wp-${index}`,
      position: { lat: 34.053, lng: -118.242 },
      altitudeFt: index === 0 ? 401 : 120,
    }))
    definition.routes[customDroneId(1)] = [{ id: 'wp-two', position: { lat: 34.054, lng: -118.241 }, altitudeFt: 120 }]
    definition.launchAssignments[customDroneId(1)] = 'site-1'
    definition.recoveryAssignments[customDroneId(1)] = 'missing'

    const errors = validateCustomMission(definition).errors.join(' ')
    expect(errors).toContain(`maximum is ${MAX_WAYPOINTS_PER_DRONE}`)
    expect(errors).toContain('20-400 ft')
    expect(errors).toContain('capacity 1')
    expect(errors).toContain('Recovery site is required')
  })

  it('rejects invalid coordinates and empty mission intent', () => {
    const definition = validDefinition()
    definition.purpose = ''
    definition.center.lat = 91
    const errors = validateCustomMission(definition).errors
    expect(errors).toContain('Mission purpose is required.')
    expect(errors).toContain('Mission center coordinates are invalid.')
  })
})

// ─── Audit F-10: RTB-leg audit + explicit unknowns ─────────────────────────────
//
// Geometry: launch site L and the single waypoint W share latitude 34.05; the recovery
// site R sits due north of W. The no-fly square straddles ONLY the W→R return leg
// (lat 34.054–34.056 at lng −118.24), so any rejection can only come from the RTB audit,
// never from the outbound audit.

function rtbFixture(): CustomMissionDefinition {
  const droneId = customDroneId(0)
  return {
    ...validDefinition(),
    sites: [
      { id: 'site-l', kind: 'building_rooftop', label: 'Launch roof', position: { lat: 34.05, lng: -118.25 }, capacityDrones: 1 },
      { id: 'site-r', kind: 'helipad', label: 'North helipad', position: { lat: 34.06, lng: -118.24 }, capacityDrones: 1 },
    ],
    launchAssignments: { [droneId]: 'site-l' },
    recoveryAssignments: { [droneId]: 'site-r' },
    routes: { [droneId]: [{ id: 'wp-1', label: 'East survey', position: { lat: 34.05, lng: -118.24 }, altitudeFt: 120, dwellTimeSec: 5 }] },
  }
}

function rtbCrossingGeofence(bypassForMission?: boolean): Geofence {
  return {
    id: 'gf-return-block',
    label: 'Stadium TFR',
    type: 'no_fly',
    maxAltitudeFt: 400,
    bypassForMission,
    polygon: [
      { lat: 34.054, lng: -118.242 },
      { lat: 34.054, lng: -118.238 },
      { lat: 34.056, lng: -118.238 },
      { lat: 34.056, lng: -118.242 },
    ],
  }
}

describe('custom mission RTB-leg audit and explicit unknowns (F-10)', () => {
  it('rejects a mission whose return leg crosses an active no-fly geofence, naming the RTB leg', () => {
    const definition = { ...rtbFixture(), geofences: [rtbCrossingGeofence()] }
    const result = validateCustomMission(definition)
    expect(result.valid).toBe(false)
    const rtbErrors = result.errors.filter((error) => error.includes('return-to-base leg'))
    expect(rtbErrors.length).toBeGreaterThan(0)
    expect(rtbErrors.join(' ')).toContain('UAV-01 return-to-base leg to North helipad')
    expect(rtbErrors.join(' ')).toContain('Stadium TFR')
    // The review still carries the per-drone leg audit even though the mission was rejected.
    expect(result.review?.rtbLegs[0].findings.length).toBeGreaterThan(0)
  })

  it('accepts the identical geometry when the geofence is bypassForMission', () => {
    const definition = { ...rtbFixture(), geofences: [rtbCrossingGeofence(true)] }
    const result = validateCustomMission(definition)
    expect(result.valid).toBe(true)
    expect(result.review?.rtbLegs[0].findings).toEqual([])
    // A bypassed geofence is still an authored geofence, so no "no geofences" unknown.
    expect(result.review?.geofenceCount).toBe(1)
    expect(result.review?.unknowns.join(' ')).not.toContain('No geofences authored')
  })

  it('keeps a geofence-free mission valid but persists the explicit no-geofence unknown', () => {
    const result = validateCustomMission(validDefinition())
    expect(result.valid).toBe(true)
    expect(result.review?.geofenceCount).toBe(0)
    expect(result.review?.unknowns).toContain('No geofences authored — no airspace containment is modeled or enforced for this mission.')
  })

  it('persists the explicit no_fixture terrain unknown when no sourced fixture exists', () => {
    const result = validateCustomMission(validDefinition())
    expect(result.valid).toBe(true)
    expect(result.review?.terrainFixtureSourced).toBe(false)
    expect(result.review?.terrainWarnings.some((warning) => warning.kind === 'no_fixture')).toBe(true)
    expect(result.review?.unknowns.some((line) => line.includes('No sourced terrain/building fixture'))).toBe(true)
  })

  it('audits the destination resolveRtbDestination reports, not scenario.startPosition', () => {
    const result = validateCustomMission(rtbFixture())
    expect(result.valid).toBe(true)
    const leg = result.review!.rtbLegs[0]
    const resolved = resolveRtbDestination(result.scenario!, {
      id: customDroneId(0),
      missionState: 'return_to_base',
      sortieCount: 0,
      currentWaypointIndex: 0,
    })
    // The recovery site outranks the scenario start, so the audited destination must be
    // the resolver's answer — validating startPosition here would be the F-04 bug again.
    expect(resolved.source).toBe('recovery_site')
    expect(leg.destinationSource).toBe('recovery_site')
    expect(leg.destination).toEqual(resolved.position)
    expect(leg.destination).toEqual({ lat: 34.06, lng: -118.24 })
    expect(leg.destination).not.toEqual(result.scenario!.startPosition)
  })
})
