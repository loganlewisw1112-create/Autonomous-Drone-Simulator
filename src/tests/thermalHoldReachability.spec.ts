/**
 * Reachability guard for the thermal-hold coach (demo blocker c4).
 *
 * The coach banner is only worth shipping if a cold visitor flying the default demo actually
 * reaches `missionState === 'thermal_hold'`. This drives the REAL production tick() (no mocks of
 * the loop, store or detection model) on the default quick demo until a drone enters the hold,
 * and pins the scenario id other specs (ThermalHoldCoach, vehicle avatars) reuse.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { useDroneStore } from '@/store/droneStore'
import { tick, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'

/** The default quick demo. Documented here so dependent specs import one source of truth. */
export const THERMAL_HOLD_SCENARIO_ID = 'demo_basic'

/** Hard ceiling on loop ticks (50 ms of sim time each) so a regression fails instead of hanging. */
const MAX_TICKS = 40_000

describe('thermal hold is reachable in the default demo', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    stopSimLoop()
    vi.useRealTimers()
  })

  it(`${THERMAL_HOLD_SCENARIO_ID}: some drone enters thermal_hold through the real tick path`, async () => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === THERMAL_HOLD_SCENARIO_ID)
    expect(scenario, 'default demo scenario must exist in the catalog').toBeDefined()
    if (!scenario) return

    await prepareScenarioTerrain(scenario)
    useDroneStore.setState({
      scenario,
      weatherState: getDefaultWeatherState(scenario.seed),
      launchPlan: null,
    })
    initFleet()
    const store = useDroneStore.getState()
    store.completeAuthorizationTraining('test')
    store.beginLaunchSequence()
    store.setRunning(true)

    let holdDroneId: string | null = null
    let holdTick = -1
    let holdElapsedSec = -1
    for (let i = 0; i < MAX_TICKS && holdDroneId === null; i++) {
      tick()
      const s = useDroneStore.getState()
      const holding = s.drones.find((d) => d.missionState === 'thermal_hold')
      if (holding) {
        holdDroneId = holding.id
        holdTick = s.tick
        holdElapsedSec = s.elapsedSec
      }
    }

    expect(holdDroneId, `no drone reached thermal_hold within ${MAX_TICKS} ticks`).not.toBeNull()
    const s = useDroneStore.getState()
    const holding = s.drones.find((d) => d.id === holdDroneId)
    expect(holding?.thermalHoldStartSec).toBeDefined()
    // The hold exists because a detection was confident enough to trigger the inspect dwell,
    // so at least one unresolved contact must be on the board for the coach to point at.
    expect(s.thermalContacts.some((c) => c.resolvedAt === undefined)).toBe(true)

    // Surfaced in the test log so the board fact has hard numbers behind it.
    console.info(`[thermalHoldReachability] ${THERMAL_HOLD_SCENARIO_ID} first thermal_hold: ${holdDroneId} at tick ${holdTick}, ${holdElapsedSec.toFixed(2)} sim-s`)
  }, 120_000)
})
