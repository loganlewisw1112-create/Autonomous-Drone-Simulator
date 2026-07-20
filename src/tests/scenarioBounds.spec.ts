/**
 * Unit tests for computeScenarioBounds (WS7): a pure helper extracted from TacticalMap's
 * scenario-change camera fit so the envelope math can be verified without a live MapLibre
 * instance. See TacticalMap.tsx's Effect 2, which fitBounds()es the map to this envelope
 * whenever the loaded scenario changes.
 */
import { describe, expect, it } from 'vitest'
import { computeScenarioBounds } from '@/components/TacticalMap'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import type { ScenarioConfig } from '@/types'

function makeMinimalScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    id: 'test-scenario',
    name: 'Test Scenario',
    description: 'Synthetic scenario for bounds testing',
    seed: 1,
    droneCount: 1,
    missionType: 'waypoint',
    startPosition: { lat: 37.7695, lng: -122.4862 },
    waypoints: [],
    geofences: [],
    heatSources: [],
    batteryStartPct: 100,
    batteryDrainRatePerSec: 0.01,
    commsLossWindows: [],
    ...overrides,
  }
}

function isInside(point: { lat: number; lng: number }, bounds: [[number, number], [number, number]]): boolean {
  const [[minLng, minLat], [maxLng, maxLat]] = bounds
  return point.lng >= minLng && point.lng <= maxLng && point.lat >= minLat && point.lat <= maxLat
}

describe('computeScenarioBounds', () => {
  it('every catalog scenario\'s startPosition and waypoints land inside its own bounds', () => {
    for (const scenario of ALL_SCENARIOS) {
      const bounds = computeScenarioBounds(scenario)
      expect(isInside(scenario.startPosition, bounds)).toBe(true)
      scenario.waypoints.forEach((wp) => expect(isInside(wp.position, bounds)).toBe(true))
    }
  })

  it('includes per-drone waypoints and launch/recovery sites when present', () => {
    const scenario = makeMinimalScenario({
      startPosition: { lat: 37.80, lng: -122.40 },
      perDroneWaypoints: {
        'uav-01': [{ id: 'wp-1', position: { lat: 37.90, lng: -122.30 }, altitudeFt: 100 }],
      },
      launchSites: {
        'site-a': { kind: 'rooftop', label: 'Site A', agency: 'PD', position: { lat: 37.70, lng: -122.50 }, surfaceNote: 'n/a' },
      },
      recoverySites: {
        'site-b': { kind: 'helipad', label: 'Site B', agency: 'FD', position: { lat: 37.60, lng: -122.20 }, surfaceNote: 'n/a' },
      },
    })
    const bounds = computeScenarioBounds(scenario)

    expect(isInside({ lat: 37.90, lng: -122.30 }, bounds)).toBe(true) // per-drone waypoint
    expect(isInside({ lat: 37.70, lng: -122.50 }, bounds)).toBe(true) // launch site
    expect(isInside({ lat: 37.60, lng: -122.20 }, bounds)).toBe(true) // recovery site
  })

  it('a degenerate single-point scenario returns a real, non-zero-area box without crashing', () => {
    const scenario = makeMinimalScenario({ startPosition: { lat: 40.0, lng: -74.0 }, waypoints: [] })
    const bounds = computeScenarioBounds(scenario)
    const [[minLng, minLat], [maxLng, maxLat]] = bounds

    expect(Number.isFinite(minLng)).toBe(true)
    expect(Number.isFinite(maxLng)).toBe(true)
    expect(maxLng).toBeGreaterThan(minLng)
    expect(maxLat).toBeGreaterThan(minLat)
    expect(isInside(scenario.startPosition, bounds)).toBe(true)
  })

  it('a scenario where every point coincides also returns a non-zero-area box', () => {
    const p = { lat: 51.5, lng: -0.1 }
    const scenario = makeMinimalScenario({
      startPosition: p,
      waypoints: [
        { id: 'wp-1', position: { ...p }, altitudeFt: 100 },
        { id: 'wp-2', position: { ...p }, altitudeFt: 100 },
      ],
    })
    const [[minLng, minLat], [maxLng, maxLat]] = computeScenarioBounds(scenario)
    expect(maxLng).toBeGreaterThan(minLng)
    expect(maxLat).toBeGreaterThan(minLat)
  })
})
