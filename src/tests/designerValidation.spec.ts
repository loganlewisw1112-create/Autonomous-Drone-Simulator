import { describe, expect, it } from 'vitest'
import {
  MAX_WAYPOINTS_PER_DRONE,
  compileCustomMission,
  customDroneId,
  validateCustomMission,
} from '@/components/designer/designerValidation'
import type { CustomMissionDefinition } from '@/types'

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
    expect(compiled.defaultLaunchAssignments).toEqual({ [customDroneId(0)]: customDroneId(0) })
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
