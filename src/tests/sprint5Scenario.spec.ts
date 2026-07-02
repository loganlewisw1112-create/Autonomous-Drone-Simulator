import { describe, expect, it } from 'vitest'
import { multiAgencySFPursuit, nypdTimesSqMCI } from '@/scenarios/extremeScenarios'

describe('Sprint 5 scenario fixes', () => {
  it('allows NYPD Aviation mission bypass through both Times Square control zones', () => {
    const byId = new Map(nypdTimesSqMCI.geofences.map((gf) => [gf.id, gf]))

    expect(byId.get('gf-ts-theatre-row')?.bypassForMission).toBe(true)
    expect(byId.get('gf-ts-nypd-perim')?.bypassForMission).toBe(true)
  })

  it('stages SF pursuit drones at agency-specific launch positions', () => {
    expect(multiAgencySFPursuit.perDroneStartPositions).toMatchObject({
      'uav-01': { lat: 37.7908, lng: -122.3933 },
      'uav-02': { lat: 37.7900, lng: -122.3940 },
      'uav-06': { lat: 37.8698, lng: -122.2980 },
      'uav-07': { lat: 37.8942, lng: -122.3010 },
      'uav-08': { lat: 37.7213, lng: -122.2205 },
    })
  })

  it('starts UAV-01 pursuit route at Bay Bridge mid-span after Embarcadero staging', () => {
    expect(multiAgencySFPursuit.perDroneWaypoints?.['uav-01'][0]).toMatchObject({
      id: 'sf-01-bb-mid',
      position: { lat: 37.8058, lng: -122.3565 },
    })
  })

  it('describes mixed SF, East Bay, and Oakland Airport staging truthfully', () => {
    expect(multiAgencySFPursuit.description).not.toContain('all drones stage from Oakland Airport')
    expect(multiAgencySFPursuit.description).toContain('agency-specific staging')
  })
})
