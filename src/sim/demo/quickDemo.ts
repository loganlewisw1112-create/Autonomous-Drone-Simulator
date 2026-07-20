import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopTicking, initFleet } from '@/sim/SimulationLoop'
import { getScenarioById } from '@/scenarios/registry'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { buildAutoLaunchBayPlan } from '@/sim/mission/launchBayPlanning'
import { PREFLIGHT_CHECKLIST } from '@/sim/mission/preflightChecklist'

export interface QuickDemoResult {
  ok: boolean
  reason?: string
}

// One-click demo: drives the exact production path a manual operator follows
// (scenario load → fleet init → preflight evidence → launch-bay plan → coordinated
// launch) without opening any modals. Lives outside droneStore because the store
// and SimulationLoop import each other's counterpart lazily — a store action
// calling startSimLoop would create a hard circular import.
export function runQuickDemo(scenarioId: string = 'demo_basic'): QuickDemoResult {
  const found = getScenarioById(scenarioId)
  if (!found) return { ok: false, reason: `unknown scenario: ${scenarioId}` }

  // Mirror ControlBar scenario swap: cancel the driver WITHOUT finalizing (no ghost record).
  useDroneStore.getState().setRunning(false)
  stopTicking()
  useDroneStore.getState().setScenario(found.config)
  if (found.config.weatherProfile) {
    const variant = useDroneStore.getState().scenarioVariant
    useDroneStore.getState().setWeatherState(buildWeatherState(found.config.weatherProfile, variant))
  }
  // Real fleet init: resets mission state (including launchPlan — plan must come after),
  // spawns drones at coordinated bays, emits mission_start.
  initFleet()

  // Same completion evidence the PreflightChecklist modal emits on Continue.
  useDroneStore.getState().emitEvent({
    eventType: 'preflight_complete',
    droneId: 'system',
    payload: {
      scenarioId: found.id,
      itemsConfirmed: PREFLIGHT_CHECKLIST.length,
      categories: Array.from(new Set(PREFLIGHT_CHECKLIST.map((item) => item.category))),
      mode: 'quick_demo',
    },
  })

  // Same plan shape the LaunchBayPlanner commits via Auto-Assign → Confirm.
  const st = useDroneStore.getState()
  if (!st.scenario) return { ok: false, reason: 'scenario failed to load' }
  const plan = buildAutoLaunchBayPlan(st.scenario, st.weatherState)
  if (!plan.readyToLaunch) {
    return { ok: false, reason: plan.blockers[0] ?? 'launch plan not ready' }
  }
  useDroneStore.getState().setLaunchPlan(plan)

  // Surface the guided tour strip so first-time visitors get narration.
  useDroneStore.getState().setInvestorDemoEnabled(true)

  // Mirror ControlBar.handleStart
  useDroneStore.getState().beginLaunchSequence()
  useDroneStore.getState().setRunning(true)
  startSimLoop()
  return { ok: true }
}
