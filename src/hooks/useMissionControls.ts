import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopTicking, endMission, initFleet } from '@/sim/SimulationLoop'
import { getScenarioById } from '@/scenarios/registry'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
import { observedWeatherFor } from '@/scenarios/observedWeather'
import { exportChainAsJsonl } from '@/utils/chainOfCustody'
import { buildFullKML } from '@/utils/kmlExport'
import { buildGeoJSON } from '@/utils/geojsonExport'
import { buildAfterActionPackage, serializeAfterActionPackage } from '@/sim/demo/missionReport'
import type { ScenarioVariantConfig } from '@/types'

// Mission control logic shared by the desktop ControlBar and the mobile bottom-dock
// sheets. Handlers were moved verbatim out of ControlBar so both shells drive the
// exact same start/stop/export pipeline — the desktop bar keeps its markup, mobile
// renders touch-sized controls over the same behavior.
export function useMissionControls() {
  const store = useDroneStore(
    useShallow((s) => ({
      ui: s.ui, scenario: s.scenario, events: s.events, drones: s.drones, lifecycle: s.lifecycle,
      positionHistory: s.positionHistory, thermalContacts: s.thermalContacts, operatorRole: s.operatorRole,
      launchPlan: s.launchPlan, weatherState: s.weatherState, scenarioVariant: s.scenarioVariant,
      metrics: s.metrics, elapsedSec: s.elapsedSec, replaySession: s.replaySession, investorDemo: s.investorDemo,
      lastRouteChange: s.lastRouteChange,
      setRunning: s.setRunning, setSimSpeed: s.setSimSpeed, setScenario: s.setScenario,
      setShowPreflight: s.setShowPreflight, setOperatorRole: s.setOperatorRole,
      setWeatherState: s.setWeatherState, setScenarioVariant: s.setScenarioVariant,
      setLifecycle: s.setLifecycle,
      resetInvestorDemo: s.resetInvestorDemo, setInvestorDemoEnabled: s.setInvestorDemoEnabled,
      undoLastRouteChange: s.undoLastRouteChange,
    })),
  )

  const {
    scenario, events, drones, positionHistory, thermalContacts, operatorRole,
    launchPlan, scenarioVariant, metrics, elapsedSec, replaySession,
    setRunning, setScenario, setShowPreflight, setWeatherState, setScenarioVariant, setLifecycle, resetInvestorDemo,
  } = store

  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const canStart = operatorRole === 'pic'
  const canAbort = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const canStop  = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const launchReady = launchPlan?.readyToLaunch === true
  const allLanded = drones.length > 0 && drones.every((d) => ['idle', 'landed'].includes(d.missionState))

  function handleStart() {
    if (!scenario || !launchReady) return
    const currentLifecycle = useDroneStore.getState().lifecycle
    if (currentLifecycle !== 'idle' && currentLifecycle !== 'preflight') return
    // Issue the coordinated launch command: parked drones enter the 'preflight'
    // hold and lift off on their staggered schedule (see beginLaunchSequence +
    // MissionManager). No more all-at-once takeoff from stacked spawn points.
    useDroneStore.getState().beginLaunchSequence()
    setRunning(true)
    startSimLoop()
  }

  // RTB-ALL: stop pumping ticks, reroute the fleet home, then resume the SAME mission.
  // The loop is only paused across the mutation — lifecycle stays 'running' and NOTHING
  // is finalized, so no run record is written (the mission is still in progress).
  function handleAbort() {
    if (useDroneStore.getState().lifecycle !== 'running') return
    stopTicking()
    const { updateDrone, drones: currentDrones } = useDroneStore.getState()
    currentDrones.forEach((d) => {
      if (!['landed', 'idle'].includes(d.missionState)) {
        updateDrone(d.id, { missionState: 'return_to_base', currentWaypointIndex: 0 })
      }
    })
    startSimLoop()
  }

  // Pause halts the driver without ending the mission — no finalize, no record.
  function handlePause() {
    if (useDroneStore.getState().lifecycle !== 'running') return
    setRunning(false)
    stopTicking()
    useDroneStore.getState().setLifecycle('paused')
  }

  // Resume restarts the driver on the same in-flight mission.
  function handleResume() {
    if (useDroneStore.getState().lifecycle !== 'paused') return
    setRunning(true)
    useDroneStore.getState().setLifecycle('running')
    startSimLoop()
  }

  // The ONLY operator-driven finalize path: ends the mission and persists exactly one run record.
  function handleEndMission() {
    endMission()
  }

  function handleScenarioChange(id: string) {
    const currentLifecycle = useDroneStore.getState().lifecycle
    // Never discard an in-progress mission. The operator must explicitly end it
    // before browsing/replacing the active scenario.
    if (currentLifecycle === 'running' || currentLifecycle === 'paused') return
    const found = getScenarioById(id)
    if (!found) return
    // Swap scenarios without finalizing the prior one (browsing scenarios must not
    // write a ghost run record). initFleet() resets lifecycle back to 'idle'.
    stopTicking()
    setRunning(false)
    setScenario(found.config)
    // Apply current variant to this scenario's profile
    if (found.config.weatherProfile) {
      const ws = buildWeatherState(found.config.weatherProfile, scenarioVariant, observedWeatherFor(found.config.id))
      setWeatherState(ws)
    }
    // Zustand writes are synchronous — initFleet reads the scenario set above directly.
    initFleet()
    setLifecycle('preflight')
    setShowPreflight(true)
  }

  function handleVariantChange(patch: Partial<ScenarioVariantConfig>) {
    const next = { ...scenarioVariant, ...patch }
    setScenarioVariant(next)
    if (scenario?.weatherProfile) {
      setWeatherState(buildWeatherState(scenario.weatherProfile, next, observedWeatherFor(scenario.id)))
    }
  }

  function handleRandomizeSeed() {
    handleVariantChange({ seed: Math.floor(Math.random() * 0xffffff) })
  }

  function handleDemoReset() {
    // Reset transient state for a clean run — cancel the driver WITHOUT finalizing.
    stopTicking()
    resetInvestorDemo()
    if (scenario) initFleet()
  }

  function handleExportLog() {
    triggerDownload(
      exportChainAsJsonl(events),
      `custody-log-${scenario?.id ?? 'mission'}-${Date.now()}.jsonl`,
      'application/jsonl',
    )
  }

  function handleExportKML() {
    if (!drones.length || !scenario) return
    const kml = buildFullKML(drones, positionHistory, scenario, thermalContacts)
    triggerDownload(kml, `mission-${scenario.id}-${Date.now()}.kml`, 'application/vnd.google-earth.kml+xml')
  }

  function handleExportGeoJSON() {
    if (!drones.length || !scenario) return
    const geojson = buildGeoJSON(drones, positionHistory, scenario, thermalContacts)
    triggerDownload(geojson, `mission-${scenario.id}-${Date.now()}.geojson`, 'application/geo+json')
  }

  function handleExportAfterAction() {
    const packageData = buildAfterActionPackage({
      scenario,
      scenarioVariant,
      drones,
      metrics,
      thermalContacts,
      events,
      elapsedSec,
      replayFrameCount: replaySession?.frames.length ?? 0,
      positionHistory,
      replaySession,
    })
    triggerDownload(
      serializeAfterActionPackage(packageData),
      `after-action-${scenario?.id ?? 'mission'}-${Date.now()}.json`,
      'application/json',
    )
  }

  function triggerDownload(content: string, filename: string, mimeType: string) {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    setExportStatus(filename.startsWith('after-action') ? 'AFTER ACTION READY' : 'EXPORT READY')
    window.setTimeout(() => setExportStatus(null), 4500)
    window.setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
  }

  return {
    ...store,
    exportStatus,
    canStart, canAbort, canStop, launchReady, allLanded,
    handleStart, handleAbort, handlePause, handleResume, handleEndMission,
    handleScenarioChange, handleVariantChange, handleRandomizeSeed, handleDemoReset,
    handleUndoRouteChange: store.undoLastRouteChange,
    handleExportLog, handleExportKML, handleExportGeoJSON, handleExportAfterAction,
  }
}
