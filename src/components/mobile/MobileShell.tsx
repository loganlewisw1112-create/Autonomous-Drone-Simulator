import { lazy, Suspense, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { TacticalMap } from '@/components/TacticalMap'
import { FleetPanel } from '@/components/FleetPanel'
import { TelemetryPanel } from '@/components/TelemetryPanel'
import { LoadingScreen } from '@/components/LoadingScreen'
import { WelcomeOverlay } from '@/components/WelcomeOverlay'
import { Drawer } from '@/components/mobile/Drawer'
import { BottomDock, ScenarioSheet, MissionSheet, ExportsSheet, type MobileSheet } from '@/components/mobile/BottomDock'
import { useWakeLock } from '@/hooks/useWakeLock'
import '@/styles/mobile.css'

const PreflightChecklist = lazy(() => import('@/components/PreflightChecklist').then((m) => ({ default: m.PreflightChecklist })))
const LaunchBayPlanner = lazy(() => import('@/components/LaunchBayPlanner').then((m) => ({ default: m.LaunchBayPlanner })))
const ReplayPanel = lazy(() => import('@/components/ReplayPanel').then((m) => ({ default: m.ReplayPanel })))

function MobileClock() {
  const { elapsedSec } = useDroneStore(useShallow((s) => ({ elapsedSec: s.elapsedSec })))
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
      T+{Math.floor(elapsedSec / 60)}:{Math.floor(elapsedSec % 60).toString().padStart(2, '0')}
    </span>
  )
}

const SHEET_TITLES: Record<Exclude<MobileSheet, null>, string> = {
  mission: 'MISSION CONTROL',
  scenario: 'SCENARIO & WEATHER',
  exports: 'EVIDENCE EXPORTS',
}

// Landscape-only mobile console: full-screen tactical map with fleet/telemetry
// edge drawers and a bottom dock of sheets. Reuses the exact desktop components
// and sim pipeline — only the chrome around them is mobile-specific.
export function MobileShell() {
  const { scenario, isRunning, mapReady } = useDroneStore(
    useShallow((s) => ({ scenario: s.scenario, isRunning: s.ui.isRunning, mapReady: s.mapReady })),
  )
  const [loadingDone, setLoadingDone] = useState(false)
  const [sideDrawer, setSideDrawer] = useState<'fleet' | 'telemetry' | null>(null)
  const [sheet, setSheet] = useState<MobileSheet>(null)

  useWakeLock(isRunning)

  return (
    <div className="mobile-shell" data-testid="mobile-shell">
      <header className="mobile-topbar">
        <span className="header-logo">⬡ DRONE OPS</span>
        <span className="header-mission-id">
          {scenario ? `${scenario.id.toUpperCase()} · SEED ${scenario.seed}` : 'NO MISSION LOADED'}
        </span>
        {isRunning && <div className="rec-dot" title="Recording" />}
        <MobileClock />
      </header>

      <div className="mobile-map">
        <TacticalMap />

        <button className="mobile-edge-tab left" onClick={() => setSideDrawer('fleet')}>
          FLEET
        </button>
        <button className="mobile-edge-tab right" onClick={() => setSideDrawer('telemetry')}>
          TELEMETRY
        </button>

        <Drawer side="left" title="FLEET" open={sideDrawer === 'fleet'} onClose={() => setSideDrawer(null)}>
          <FleetPanel />
        </Drawer>
        <Drawer side="right" title="TELEMETRY" open={sideDrawer === 'telemetry'} onClose={() => setSideDrawer(null)}>
          <TelemetryPanel />
        </Drawer>
        <Drawer side="bottom" title={sheet ? SHEET_TITLES[sheet] : ''} open={sheet !== null} onClose={() => setSheet(null)}>
          {sheet === 'scenario' && <ScenarioSheet />}
          {sheet === 'mission' && <MissionSheet />}
          {sheet === 'exports' && <ExportsSheet />}
        </Drawer>
      </div>

      <BottomDock
        openSheet={sheet}
        onToggleSheet={setSheet}
        onOpenAccount={() => {}}
        accountLabel="ACCOUNT"
      />

      <Suspense fallback={null}>
        <PreflightChecklist />
        <LaunchBayPlanner />
        <ReplayPanel />
      </Suspense>

      {loadingDone && <WelcomeOverlay />}
      {!loadingDone && (
        <LoadingScreen mapReady={mapReady} onComplete={() => setLoadingDone(true)} />
      )}
    </div>
  )
}
