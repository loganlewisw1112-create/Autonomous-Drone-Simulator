// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ReviewStep } from '@/components/designer/CustomMissionHub'
import { customDroneId } from '@/components/designer/designerValidation'
import type { CustomMissionDefinition } from '@/types'

// Audit F-10 regression suite for the review wording.
//
// The review previously said only "passes the available training checks", which read as a
// safety validation while geofences compiled empty and the return leg was never audited.
// The step must now state what WAS checked (including each RTB leg and its resolver-derived
// destination) and carry the explicit unknowns for what was NOT modeled.

function definition(): CustomMissionDefinition {
  const droneId = customDroneId(0)
  return {
    id: 'mission-review-1',
    name: 'Harbor sweep',
    locationLabel: 'San Pedro',
    purpose: 'Sweep the harbor perimeter.',
    endGoal: 'All berths confirmed clear.',
    center: { lat: 34.05, lng: -118.24 },
    droneCount: 1,
    sites: [
      { id: 'site-l', kind: 'building_rooftop', label: 'Launch roof', position: { lat: 34.05, lng: -118.25 }, capacityDrones: 1 },
      { id: 'site-r', kind: 'helipad', label: 'North helipad', position: { lat: 34.06, lng: -118.24 }, capacityDrones: 1 },
    ],
    launchAssignments: { [droneId]: 'site-l' },
    recoveryAssignments: { [droneId]: 'site-r' },
    routes: { [droneId]: [{ id: 'wp-1', label: 'Berth line', position: { lat: 34.05, lng: -118.24 }, altitudeFt: 120, dwellTimeSec: 5 }] },
    geographicMode: 'synthetic_training',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('custom mission review step (F-10)', () => {
  it('lists the per-drone RTB leg with its resolver-derived destination', () => {
    render(<ReviewStep value={definition()} />)
    const audit = screen.getByTestId('designer-review-audit')
    expect(audit.textContent).toContain('UAV-01 return leg → North helipad (assigned recovery site)')
    expect(audit.textContent).toContain('clear of active geofences')
  })

  it('surfaces the no-geofence and no-terrain-fixture unknowns next to the pass line', () => {
    render(<ReviewStep value={definition()} />)
    const unknowns = screen.getByTestId('designer-review-unknowns')
    expect(unknowns.textContent).toContain('No geofences authored — no airspace containment is modeled or enforced for this mission.')
    expect(unknowns.textContent).toContain('No sourced terrain/building fixture — ground and structure clearance are not modeled.')
    // The honest pass line survives, but now says exactly what the checks covered.
    expect(screen.getByText(/passes the available training checks/i).textContent)
      .toContain('return-to-base leg')
  })

  it('shows rejection errors when the return leg breaches an authored no-fly zone', () => {
    const value: CustomMissionDefinition = {
      ...definition(),
      geofences: [{
        id: 'gf-return-block',
        label: 'Stadium TFR',
        type: 'no_fly',
        maxAltitudeFt: 400,
        polygon: [
          { lat: 34.054, lng: -118.242 },
          { lat: 34.054, lng: -118.238 },
          { lat: 34.056, lng: -118.238 },
          { lat: 34.056, lng: -118.242 },
        ],
      }],
    }
    render(<ReviewStep value={value} />)
    expect(screen.getByRole('alert').textContent).toContain('return-to-base leg to North helipad')
    expect(screen.queryByText(/passes the available training checks/i)).toBeNull()
  })
})
