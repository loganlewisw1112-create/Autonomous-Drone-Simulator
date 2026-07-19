import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { startSimLoop, stopSimLoop, initFleet } from '@/sim/SimulationLoop'
import { SCENARIO_OPTIONS } from '@/scenarios/catalog'
import { buildWeatherState } from '@/sim/weather/weatherEngine'
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
      ui: s.ui, scenario: s.scenario, events: s.events, drones: s.drones,
      positionHistory: s.positionHistory, thermalContacts: s.thermalContacts, operatorRole: s.operatorRole,
      launchPlan: s.launchPlan, weatherState: s.weatherState, scenarioVariant: s.scenarioVariant,
      metrics: s.metrics, elapsedSec: s.elapsedSec, replaySession: s.replaySession, investorDemo: s.investorDemo,
      setRunning: s.setRunning, setSimSpeed: s.setSimSpeed, setScenario: s.setScenario,
      setShowPreflight: s.setShowPreflight, setOperatorRole: s.setOperatorRole,
      setWeatherState: s.setWeatherState, setScenarioVariant: s.setScenarioVariant,
      resetInvestorDemo: s.resetInvestorDemo, setInvestorDemoEnabled: s.setInvestorDemoEnabled,
    })),
  )

  const {
    scenario, events, drones, positionHistory, thermalContacts, operatorRole,
    launchPlan, scenarioVariant, metrics, elapsedSec, replaySession,
    setRunning, setScenario, setShowPreflight, setWeatherState, setScenarioVariant, resetInvestorDemo,
  } = store

  const [exportStatus, setExportStatus] = useState<string | null>(null)

  const canStart = operatorRole === 'pic'
  const canAbort = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const canStop  = operatorRole === 'pic' || operatorRole === 'mission_commander'
  const launchReady = launchPlan?.readyToLaunch === true
  const allLanded = drones.length > 0 && drones.every((d) => ['idle', 'landed'].includes(d.missionState))

  function handleStart() {
    if (!scenario || !launchReady) return
    // Issue the coordinated launch command: parked drones enter the 'preflight'
    // hold and lift off on their staggered schedule (see beginLaunchSequence +
    // MissionManager). No more all-at-once takeoff from stacked spawn points.
    useDroneStore.getState().beginLaunchSequence()
    setRunning(true)
    startSimLoop()
  }

  function handleAbort() {
    setRunning(false)
    stopSimLoop()
    const { updateDrone, drones: currentDrones } = useDroneStore.getState()
    currentDrones.forEach((d) => {
      if (!['landed', 'idle'].includes(d.missionState)) {
        updateDrone(d.id, { missionState: 'return_to_base', currentWaypointIndex: 0 })
      }
    })
    setRunning(true)
    startSimLoop()
  }

  function handleStop() {
    setRunning(false)
    stopSimLoop()
  }

  function handleScenarioChange(id: string) {
    const found = SCENARIO_OPTIONS.find((s) => s.id === id)
    if (!found) return
    handleStop()
    setScenario(found.config)
    // Apply current variant to this scenario's profile
    if (found.config.weatherProfile) {
      const ws = buildWeatherState(found.config.weatherProfile, scenarioVariant)
      setWeatherState(ws)
    }
    // Zustand writes are synchronous — initFleet reads the scenario set above directly.
    initFleet()
    setShowPreflight(true)
  }

  function handleVariantChange(patch: Partial<ScenarioVariantConfig>) {
    const next = { ...scenarioVariant, ...patch }
    setScenarioVariant(next)
    if (scenario?.weatherProfile) {
      setWeatherState(buildWeatherState(scenario.weatherProfile, next))
    }
  }

  function handleRandomizeSeed() {
    handleVariantChange({ seed: Math.floor(Math.random() * 0xffffff) })
  }

  function handleDemoReset() {
    stopSimLoop()
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
    handleStart, handleAbort, handleStop,
    handleScenarioChange, handleVariantChange, handleRandomizeSeed, handleDemoReset,
    handleExportLog, handleExportKML, handleExportGeoJSON, handleExportAfterAction,
  }
}
