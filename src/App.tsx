import { lazy, Suspense, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FleetPanel } from '@/components/FleetPanel'
import { TacticalMap } from '@/components/TacticalMap'
import { TelemetryPanel } from '@/components/TelemetryPanel'
import { ControlBar } from '@/components/ControlBar'
import { LoadingScreen } from '@/components/LoadingScreen'
import { WelcomeOverlay } from '@/components/WelcomeOverlay'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AccountChip } from '@/components/account/AccountChip'
import { RotateGate } from '@/components/mobile/RotateGate'
import { useDeviceMode } from '@/hooks/useDeviceMode'
import { useDroneStore } from '@/store/droneStore'
import '@/styles/tactical.css'

// Modal/conditional components (gated behind ui.showX or replaySession) are lazy-loaded —
// they're never needed on first paint, so they shouldn't cost bytes in the initial bundle.
const PreflightChecklist = lazy(() => import('@/components/PreflightChecklist').then((m) => ({ default: m.PreflightChecklist })))
const LaunchBayPlanner = lazy(() => import('@/components/LaunchBayPlanner').then((m) => ({ default: m.LaunchBayPlanner })))
const ReplayPanel = lazy(() => import('@/components/ReplayPanel').then((m) => ({ default: m.ReplayPanel })))
// Mobile shell is its own lazy chunk — desktop visitors never download it.
const MobileShell = lazy(() => import('@/components/mobile/MobileShell').then((m) => ({ default: m.MobileShell })))
// Account panels are lazy for the same reason: gated on auth-store flags, null until opened.
const SignInModal = lazy(() => import('@/components/account/SignInModal').then((m) => ({ default: m.SignInModal })))
const AccountPanels = lazy(() => import('@/components/account/AccountPanels').then((m) => ({ default: m.AccountPanels })))

const GIT_HASH = import.meta.env.VITE_GIT_HASH ?? 'dev'

// Isolated so the 20-200Hz tick clock re-renders only this tiny span, not the whole header
// or the rest of the app shell (which are independent siblings, not children of this).
function MissionClock() {
  const { tick, elapsedSec } = useDroneStore(useShallow((s) => ({ tick: s.tick, elapsedSec: s.elapsedSec })))
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)' }}>
      T+{Math.floor(elapsedSec / 60)}:{Math.floor(elapsedSec % 60).toString().padStart(2, '0')} · #{tick}
    </span>
  )
}

export default function App() {
  const { scenario, isRunning, mapReady } = useDroneStore(
    useShallow((s) => ({ scenario: s.scenario, isRunning: s.ui.isRunning, mapReady: s.mapReady })),
  )
  const [loadingDone, setLoadingDone] = useState(false)
  const deviceMode = useDeviceMode()

  // Phones get a dedicated landscape-only shell; the desktop tree below is the
  // frozen launch layout and must stay byte-identical (LAW.1).
  if (deviceMode === 'phone-portrait') {
    return (
      <ErrorBoundary>
        <RotateGate />
      </ErrorBoundary>
    )
  }
  if (deviceMode === 'phone-landscape') {
    return (
      <ErrorBoundary>
        <Suspense fallback={<div style={{ height: '100dvh', background: 'var(--bg-primary)' }} />}>
          <MobileShell />
        </Suspense>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app-shell">
        {/* Header */}
        <header className="header-bar">
          <span className="header-logo">⬡ Drone Ops Center</span>
          <span className="header-mission-id">
            {scenario ? `MISSION: ${scenario.id.toUpperCase()} · SEED: ${scenario.seed}` : 'NO MISSION LOADED'}
          </span>
          <div className="header-spacer" />
          <span className="sim-label">SIMULATION</span>
          {isRunning && <div className="rec-dot" title="Recording" />}
          <MissionClock />
          <AccountChip />
        </header>

        {/* Left: Fleet panel */}
        <FleetPanel />

        {/* Center: Map */}
        <TacticalMap />

        {/* Right: Telemetry */}
        <TelemetryPanel />

        {/* Bottom: Control bar */}
        <ControlBar />

        {/* Preflight modal, launch bay planning modal, and after-action replay panel — each
            renders null most of the time (gated on ui state), so they're lazy chunks with no
            fallback UI needed for the common "not shown yet" case. */}
        <Suspense fallback={null}>
          <PreflightChecklist />
          <LaunchBayPlanner />
          <ReplayPanel />
          <SignInModal />
          <AccountPanels />
        </Suspense>

        {/* First-visit onboarding — after the loading screen clears, before any scenario */}
        {loadingDone && <WelcomeOverlay />}

        {/* Audit footer */}
        <div className="audit-bar">
          commit: {GIT_HASH} · sim only · no real flight data
        </div>

        {/* Loading screen — rendered on top until all systems validated */}
        {!loadingDone && (
          <LoadingScreen mapReady={mapReady} onComplete={() => setLoadingDone(true)} />
        )}
      </div>
    </ErrorBoundary>
  )
}
