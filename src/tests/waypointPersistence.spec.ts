import { describe, expect, it, vi } from 'vitest'
import {
  clearSavedDroneWaypointRoute,
  loadSavedDroneWaypointRoute,
  restoreSavedWaypointRoutes,
  saveDroneWaypointRoute,
  saveFleetWaypointRoutes,
  storageKeyForWaypointPlan,
} from '@/sim/mission/waypointPersistence'
import type { ScenarioVariantConfig, Waypoint } from '@/types'

const VARIANT: ScenarioVariantConfig = {
  seed: 1337,
  timeOfDay: 'day',
  season: 'spring',
  weatherSeverity: 0,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const OTHER_VARIANT: ScenarioVariantConfig = {
  ...VARIANT,
  seed: 2026,
}

const BASELINE_ROUTE: Waypoint[] = [
  { id: 'baseline-1', label: 'Baseline 1', position: { lat: 37.1, lng: -122.1 }, altitudeFt: 120 },
]

const SAVED_ROUTE: Waypoint[] = [
  { id: 'saved-1', label: 'Saved 1', position: { lat: 37.2, lng: -122.2 }, altitudeFt: 140, dwellTimeSec: 8 },
  { id: 'saved-2', label: 'Saved 2', position: { lat: 37.3, lng: -122.3 }, altitudeFt: 140 },
]

describe('waypoint persistence', () => {
  it('saves and loads one drone route for a scenario variant', () => {
    const storage = makeMemoryStorage()

    const result = saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-01',
      route: SAVED_ROUTE,
      source: 'operator_edit',
      now: 1234,
    })

    expect(result.ok).toBe(true)
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')).toMatchObject({
      scenarioId: 'demo_sar_coastal',
      droneId: 'uav-01',
      source: 'operator_edit',
      updatedAt: 1234,
      route: SAVED_ROUTE,
    })
  })

  it('keeps saved routes isolated by scenario variant', () => {
    const storage = makeMemoryStorage()

    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-01',
      route: SAVED_ROUTE,
      source: 'operator_edit',
      now: 100,
    })
    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: OTHER_VARIANT,
      droneId: 'uav-01',
      route: BASELINE_ROUTE,
      source: 'manual_save',
      now: 200,
    })

    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')?.route).toEqual(SAVED_ROUTE)
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', OTHER_VARIANT, 'uav-01')?.route).toEqual(BASELINE_ROUTE)
  })

  it('persists a fleet route update with one storage write', () => {
    const storage = makeMemoryStorage()
    const setItem = vi.spyOn(storage, 'setItem')

    const result = saveFleetWaypointRoutes({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      routes: {
        'uav-01': SAVED_ROUTE,
        'uav-02': BASELINE_ROUTE,
      },
      source: 'operator_edit',
      now: 300,
    })

    expect(result.ok).toBe(true)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')?.route).toEqual(SAVED_ROUTE)
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-02')?.route).toEqual(BASELINE_ROUTE)
    expect(result.statuses).toMatchObject({
      'uav-01': { state: 'autosaved', updatedAt: 300 },
      'uav-02': { state: 'autosaved', updatedAt: 300 },
    })
  })

  it('batches route saves and draft clears into one storage mutation', () => {
    const storage = makeMemoryStorage()
    saveFleetWaypointRoutes({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      routes: { 'uav-01': BASELINE_ROUTE, 'uav-02': BASELINE_ROUTE },
      source: 'operator_edit',
      now: 100,
    })
    const setItem = vi.spyOn(storage, 'setItem')

    const result = saveFleetWaypointRoutes({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      routes: { 'uav-01': SAVED_ROUTE },
      removedDroneIds: ['uav-02'],
      source: 'route_undo',
      now: 400,
    })

    expect(result.ok).toBe(true)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(result.statuses['uav-01']).toMatchObject({ state: 'autosaved', source: 'route_undo' })
    expect(result.statuses['uav-02']).toMatchObject({ state: 'cleared', message: 'Draft cleared' })
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')?.route).toEqual(SAVED_ROUTE)
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-02')).toBeNull()
  })

  it('returns null for malformed storage instead of throwing', () => {
    const storage = makeMemoryStorage()
    storage.setItem(storageKeyForWaypointPlan('demo_sar_coastal', VARIANT), '{not-json')

    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')).toBeNull()
  })

  it('clears only the selected drone draft for the active scenario variant', () => {
    const storage = makeMemoryStorage()

    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-01',
      route: SAVED_ROUTE,
      source: 'operator_edit',
      now: 100,
    })
    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-02',
      route: BASELINE_ROUTE,
      source: 'operator_edit',
      now: 100,
    })

    clearSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')

    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-01')).toBeNull()
    expect(loadSavedDroneWaypointRoute(storage, 'demo_sar_coastal', VARIANT, 'uav-02')?.route).toEqual(BASELINE_ROUTE)
  })

  it('overlays valid saved drafts onto safe baseline routes and reports rejected drafts', () => {
    const storage = makeMemoryStorage()
    const invalidRoute: Waypoint[] = [
      { id: 'unsafe-1', position: { lat: 0, lng: 0 }, altitudeFt: 100 },
    ]

    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-01',
      route: SAVED_ROUTE,
      source: 'operator_edit',
      now: 100,
    })
    saveDroneWaypointRoute({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      droneId: 'uav-02',
      route: invalidRoute,
      source: 'operator_edit',
      now: 100,
    })

    const restored = restoreSavedWaypointRoutes({
      storage,
      scenarioId: 'demo_sar_coastal',
      scenarioVariant: VARIANT,
      baselineRoutes: {
        'uav-01': BASELINE_ROUTE,
        'uav-02': BASELINE_ROUTE,
      },
      validateRoute: (_droneId, route) => route[0]?.id !== 'unsafe-1',
    })

    expect(restored.routes['uav-01']).toEqual(SAVED_ROUTE)
    expect(restored.routes['uav-02']).toEqual(BASELINE_ROUTE)
    expect(restored.statuses['uav-01']).toMatchObject({ state: 'restored', source: 'operator_edit' })
    expect(restored.statuses['uav-02']).toMatchObject({ state: 'failed' })
  })
})

function makeMemoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear() {
      data.clear()
    },
    getItem(key: string) {
      return data.get(key) ?? null
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null
    },
    removeItem(key: string) {
      data.delete(key)
    },
    setItem(key: string, value: string) {
      data.set(key, value)
    },
  }
}
