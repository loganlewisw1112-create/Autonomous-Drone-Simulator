import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { buildInvestorDemoChapters } from '@/sim/demo/demoScript'
import { buildComplianceState } from '@/sim/demo/complianceEngine'
import { buildUtmAirspaceState, buildExternalTrafficFeatures } from '@/sim/demo/utmEngine'
import { buildMissionOutcomeSummary } from '@/sim/demo/missionOutcome'
import { buildAfterActionPackage, serializeAfterActionPackage } from '@/sim/demo/missionReport'
import type { DroneState, MissionMetrics, ScenarioVariantConfig, ThermalContactState } from '@/types'

const scenario = ALL_SCENARIOS.find((item) => item.id === 'demo_sar_coastal') ?? ALL_SCENARIOS[0]

const VARIANT: ScenarioVariantConfig = {
  seed: 2026,
  timeOfDay: 'day',
  season: 'summer',
  weatherSeverity: 1,
  commsDegradation: 0,
  thermalDensity: 1,
  batteryPressure: 0,
  terrainDifficulty: 0,
}

const METRICS: MissionMetrics = {
  totalFlightDistanceM: 2400,
  waypointsReached: 18,
  conflictsDetected: 1,
  thermalContacts: 4,
  geofenceBreaches: 0,
  rtbTriggers: 1,
  recoveryDispatches: 0,
  groundUnitDispatch: 1,
}

describe('investor demo readiness engines', () => {
  it('builds a guided demo spine from the active scenario and live progress', () => {
    const chapters = buildInvestorDemoChapters({
      scenario,
      elapsedSec: 96,
      events: [{ eventType: 'operator_command' }, { eventType: 'thermal_detection' }, { eventType: 'mission_complete' }],
      routeSuggestionCount: 2,
      replayAvailable: true,
    })

    expect(chapters.map((chapter) => chapter.id)).toEqual([
      'mission-brief',
      'launch-and-edit',
      'live-retask',
      'ai-detection',
      'safe-recovery',
      'after-action',
    ])
    expect(chapters.some((chapter) => chapter.status === 'complete')).toBe(true)
    expect(chapters.find((chapter) => chapter.id === 'after-action')?.successSignal).toContain('report')
  })

  it('derives simulation-only Remote ID, LAANC, and waiver flags from scenario state', () => {
    const compliance = buildComplianceState({
      scenario,
      drones: [makeDrone('uav-01', { altitudeFt: 420, signalDbm: -88 })],
      scenarioVariant: VARIANT,
      elapsedSec: 30,
    })

    expect(compliance.remoteId.status).toBe('broadcasting')
    expect(compliance.airspace.authorization.kind).toBe('simulated_laanc')
    expect(compliance.waiverFlags.some((flag) => flag.kind === 'altitude_limit')).toBe(true)
    expect(compliance.disclaimer).toContain('simulation')
  })

  it('creates deterministic UTM external tracks, reservations, and map features', () => {
    const state = buildUtmAirspaceState({
      scenario,
      drones: [makeDrone('uav-01', { position: scenario.startPosition, altitudeFt: 180 })],
      elapsedSec: 45,
    })
    const repeat = buildUtmAirspaceState({
      scenario,
      drones: [makeDrone('uav-01', { position: scenario.startPosition, altitudeFt: 180 })],
      elapsedSec: 45,
    })

    expect(state).toEqual(repeat)
    expect(state.externalTracks.length).toBeGreaterThan(0)
    expect(state.reservations.length).toBeGreaterThan(0)
    expect(buildExternalTrafficFeatures(state.externalTracks)[0]?.geometry.type).toBe('Point')
  })

  it('turns raw metrics into investor-readable outcome and ROI signals', () => {
    const outcome = buildMissionOutcomeSummary({
      scenario,
      drones: [makeDrone('uav-01'), makeDrone('uav-02', { batteryPct: 31 })],
      metrics: METRICS,
      thermalContacts: [makeThermal('hs-a'), makeThermal('hs-b', true)],
      eventsCount: 34,
      elapsedSec: 330,
    })

    expect(outcome.searchCoveragePct).toBeGreaterThan(0)
    expect(outcome.detectedContacts).toBe(2)
    expect(outcome.responseTimeSavedMin).toBeGreaterThan(0)
    expect(outcome.routeRiskReductionPct).toBeGreaterThanOrEqual(0)
    expect(outcome.headline).toContain('contacts')
  })

  it('bundles replay, compliance, UTM, outcome, and evidence into an after-action package', () => {
    const packageData = buildAfterActionPackage({
      scenario,
      scenarioVariant: VARIANT,
      drones: [makeDrone('uav-01')],
      metrics: METRICS,
      thermalContacts: [makeThermal('hs-a')],
      events: [],
      elapsedSec: 240,
      replayFrameCount: 12,
      positionHistory: { 'uav-01': [scenario.startPosition] },
    })

    const serialized = serializeAfterActionPackage(packageData)

    expect(packageData.kind).toBe('investor_after_action_package')
    expect(packageData.compliance.disclaimer).toContain('simulation')
    expect(packageData.utm.externalTracks.length).toBeGreaterThan(0)
    expect(serialized).toContain('"missionReport"')
  })
})

describe('investor demo store state', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeMemoryStorage())
    useDroneStore.setState({
      scenario,
      scenarioVariant: VARIANT,
      ui: {
        selectedDroneId: null,
        sensorMode: 'eo',
        simSpeed: 1,
        isRunning: true,
        isReplayMode: true,
        showPreflight: true,
        showLaunchBay: true,
        showEventLog: true,
      },
      investorDemo: {
        enabled: false,
        currentChapterId: null,
        completedChapterIds: [],
        resetCount: 0,
      },
    })
  })

  it('toggles guided demo mode and demo reset returns the shell to deterministic standby', () => {
    useDroneStore.getState().setInvestorDemoEnabled(true)
    useDroneStore.getState().resetInvestorDemo()

    const state = useDroneStore.getState()
    expect(state.investorDemo.enabled).toBe(true)
    expect(state.investorDemo.currentChapterId).toBe('mission-brief')
    expect(state.investorDemo.resetCount).toBe(1)
    expect(state.ui.isRunning).toBe(false)
    expect(state.ui.isReplayMode).toBe(false)
    expect(state.routeSuggestions).toEqual([])
  })
})

function makeDrone(id: string, patch: Partial<DroneState> = {}): DroneState {
  return {
    id,
    label: id.toUpperCase(),
    color: '#00d4ff',
    position: { lat: scenario.startPosition.lat, lng: scenario.startPosition.lng },
    altitudeFt: 120,
    headingDeg: 0,
    speedMs: 10,
    batteryPct: 82,
    signalDbm: -62,
    missionState: 'navigate',
    currentWaypointIndex: 1,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    ...patch,
  }
}

function makeThermal(sourceId: string, resolved = false): ThermalContactState {
  return {
    sourceId,
    class: 'generic-person',
    position: { lat: scenario.startPosition.lat + 0.001, lng: scenario.startPosition.lng + 0.001 },
    confidence: 0.86,
    weatherAdjustedConfidence: 0.81,
    tick: 100,
    selected: false,
    resolvedAt: resolved ? 140 : undefined,
  }
}

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
