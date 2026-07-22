import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopTicking, initFleet } from '@/sim/SimulationLoop'
import { getScenarioById } from '@/scenarios/registry'
import { compileCustomMission } from '@/components/designer/designerValidation'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { buildAutoLaunchBayPlan } from '@/sim/mission/launchBayPlanning'
import { buildLaunchSlotsForPlan } from '@/sim/mission/launchPlanGeometry'
import { PREFLIGHT_CHECKLIST } from '@/sim/mission/preflightChecklist'
import type { ClassConfig } from '@/classroom/protocol'

// Loads the instructor's assignment into the live simulator and starts it, so a
// student tile begins reporting telemetry the moment they join. Mirrors the
// production load path (quickDemo / CustomMissionHub.enterPreflight) and lives
// OUTSIDE droneStore for the same reason quickDemo does — a store action calling
// startSimLoop would create a hard store ↔ SimulationLoop circular import.

export interface LoadResult { ok: boolean; reason?: string }

export function loadClassMission(config: ClassConfig): LoadResult {
  const scenario = config.kind === 'catalog'
    ? getScenarioById(config.scenarioId)?.config
    : compileCustomMission(config.definition)
  if (!scenario) return { ok: false, reason: `unknown scenario: ${config.kind === 'catalog' ? config.scenarioId : 'custom'}` }

  const store = useDroneStore.getState()
  // Cancel any prior run WITHOUT finalizing (no ghost record), same as a scenario swap.
  store.setRunning(false)
  stopTicking()
  store.setScenario(scenario)
  // Variant AFTER the scenario so the deterministic dials survive the load and every
  // student in the class flies byte-identical conditions from the shared seed.
  store.setScenarioVariant(config.variant)
  if (scenario.weatherProfile) {
    store.setWeatherState(buildWeatherState(scenario.weatherProfile, config.variant, observedWeatherFor(scenario.id)))
  }
  initFleet()

  store.emitEvent({
    eventType: 'preflight_complete',
    droneId: 'system',
    payload: { scenarioId: scenario.id, itemsConfirmed: PREFLIGHT_CHECKLIST.length, mode: 'classroom' },
  })

  const ready = useDroneStore.getState()
  if (!ready.scenario) return { ok: false, reason: 'scenario failed to load' }
  const plan = buildAutoLaunchBayPlan(ready.scenario, ready.weatherState)
  if (!plan.readyToLaunch) return { ok: false, reason: plan.blockers[0] ?? 'launch plan not ready' }
  const placements = buildLaunchSlotsForPlan(ready.scenario, plan, ready.droneWaypoints)
  if (!store.applyParkedLaunchPlan(plan, placements)) {
    return { ok: false, reason: 'fleet is not parked for launch-plan application' }
  }

  store.beginLaunchSequence()
  store.setRunning(true)
  startSimLoop()
  return { ok: true }
}
