import { useState } from 'react'
import { FleetPanel } from '@/components/FleetPanel'
import { TacticalMap } from '@/components/TacticalMap'
import { TelemetryPanel } from '@/components/TelemetryPanel'
import { ControlBar } from '@/components/ControlBar'
import { PreflightChecklist } from '@/components/PreflightChecklist'
import { LaunchBayPlanner } from '@/components/LaunchBayPlanner'
import { ReplayPanel } from '@/components/ReplayPanel'
import { LoadingScreen } from '@/components/LoadingScreen'
import { useDroneStore } from '@/store/droneStore'
import '@/styles/tactical.css'

const GIT_HASH = import.meta.env.VITE_GIT_HASH ?? 'dev'

export default function App() {
  const { scenario, tick, elapsedSec, ui, mapReady } = useDroneStore()
  const [loadingDone, setLoadingDone] = useState(false)

  return (
    <div className="app-shell">
      {/* Header */}
      <header className="header-bar">
        <span className="header-logo">⬡ Drone Ops Center</span>
        <span className="header-mission-id">
          {scenario ? `MISSION: ${scenario.id.toUpperCase()} · SEED: ${scenario.seed}` : 'NO MISSION LOADED'}
        </span>
        <div className="header-spacer" />
        <span className="sim-label">SIMULATION</span>
        {ui.isRunning && <div className="rec-dot" title="Recording" />}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          T+{Math.floor(elapsedSec / 60)}:{Math.floor(elapsedSec % 60).toString().padStart(2, '0')} · #{tick}
        </span>
      </header>

      {/* Left: Fleet panel */}
      <FleetPanel />

      {/* Center: Map */}
      <TacticalMap />

      {/* Right: Telemetry */}
      <TelemetryPanel />

      {/* Bottom: Control bar */}
      <ControlBar />

      {/* Preflight modal */}
      <PreflightChecklist />

      {/* Launch bay planning modal (opens after preflight) */}
      <LaunchBayPlanner />

      {/* After-action replay panel */}
      <ReplayPanel />

      {/* Audit footer */}
      <div className="audit-bar">
        commit: {GIT_HASH} · sim only · no real flight data
      </div>

      {/* Loading screen — rendered on top until all systems validated */}
      {!loadingDone && (
        <LoadingScreen mapReady={mapReady} onComplete={() => setLoadingDone(true)} />
      )}
    </div>
  )
}
