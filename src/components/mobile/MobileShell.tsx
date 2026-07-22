import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useDroneStore } from '@/store/droneStore'
import { useAuthStore } from '@/store/authStore'
import { isRightSurface, useMobileStore } from '@/store/mobileStore'
import { TacticalMap } from '@/components/TacticalMap'
import { FleetPanel } from '@/components/FleetPanel'
import { TelemetryPanel } from '@/components/TelemetryPanel'
import { MissionStatusFeed } from '@/components/MissionStatusFeed'
import { OperatorCommandPanel } from '@/components/OperatorCommandPanel'
import { MAX_WAYPOINTS_PER_DRONE } from '@/components/designer/designerValidation'
import { LoadingScreen } from '@/components/LoadingScreen'
import { WelcomeOverlay } from '@/components/WelcomeOverlay'
import { Drawer } from '@/components/mobile/Drawer'
import {
  BottomDock,
  EvidenceSheet,
  ExportsSheet,
  MapToolsSheet,
  MissionSheet,
  ScenarioSheet,
} from '@/components/mobile/BottomDock'
import { useWakeLock } from '@/hooks/useWakeLock'
import { useDeviceMode, useIsTablet } from '@/hooks/useDeviceMode'
import type { ActiveMobileSurface } from '@/types'
import '@/styles/mobile.css'

const PreflightChecklist = lazy(() => import('@/components/PreflightChecklist').then((m) => ({ default: m.PreflightChecklist })))
const LaunchBayPlanner = lazy(() => import('@/components/LaunchBayPlanner').then((m) => ({ default: m.LaunchBayPlanner })))
const ReplayPanel = lazy(() => import('@/components/ReplayPanel').then((m) => ({ default: m.ReplayPanel })))
const SignInModal = lazy(() => import('@/components/account/SignInModal').then((m) => ({ default: m.SignInModal })))
const AccountPanels = lazy(() => import('@/components/account/AccountPanels').then((m) => ({ default: m.AccountPanels })))
const CustomMissionHub = lazy(() => import('@/components/designer/CustomMissionHub').then((m) => ({ default: m.CustomMissionHub })))

function MobileClock() {
  const { elapsedSec } = useDroneStore(useShallow((s) => ({ elapsedSec: s.elapsedSec })))
  return (
    <span className="mobile-clock">
      T+{Math.floor(elapsedSec / 60)}:{Math.floor(elapsedSec % 60).toString().padStart(2, '0')}
    </span>
  )
}

const SURFACE_TITLES: Record<ActiveMobileSurface, string> = {
  fleet: 'FLEET',
  ops: 'MISSION DATA',
  telemetry: 'MISSION DATA',
  evidence: 'MISSION DATA',
  scenario: 'SCENARIO & WEATHER',
  mission: 'MISSION CONTROL',
  more: 'MORE TOOLS',
  dispatch: 'DISPATCH',
  replay: 'MISSION REPLAY',
  exports: 'EVIDENCE EXPORTS',
  account: 'ACCOUNT',
  analytics: 'ACCOUNT ANALYTICS',
  settings: 'SETTINGS',
}

function SurfacePane({ active, className = '', children }: { active: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={`mobile-surface-pane${active ? ' active' : ''}${className ? ` ${className}` : ''}`} aria-hidden={!active}>
      {children}
    </div>
  )
}

// One responsive shell is kept mounted through orientation changes. All console
// functions use the same stores/components as desktop; only their placement changes.
export function MobileShell() {
  const {
    scenario, isRunning, lifecycle, mapReady, replaySession,
    selectedDroneId, routeEditMode, setRouteEditMode, droneWaypoints, routeCommandError,
  } = useDroneStore(
    useShallow((s) => ({
      scenario: s.scenario,
      isRunning: s.ui.isRunning,
      lifecycle: s.lifecycle,
      mapReady: s.mapReady,
      replaySession: s.replaySession,
      selectedDroneId: s.ui.selectedDroneId,
      routeEditMode: s.ui.routeEditMode,
      setRouteEditMode: s.setRouteEditMode,
      droneWaypoints: s.droneWaypoints,
      routeCommandError: s.routeCommandError,
    })),
  )
  const { activeAccount, setShowSignIn, setShowSettings, setShowAnalytics } = useAuthStore(
    useShallow((s) => ({
      activeAccount: s.activeAccount,
      setShowSignIn: s.setShowSignIn,
      setShowSettings: s.setShowSettings,
      setShowAnalytics: s.setShowAnalytics,
    })),
  )
  const {
    activeSurface,
    rightTab,
    loadingDone,
    orientation,
    openSurface,
    toggleSurface,
    closeSurface,
    setRightTab,
    setLoadingDone,
    setOrientation,
  } = useMobileStore()
  const deviceMode = useDeviceMode()
  const isTablet = useIsTablet()
  const [recenterRequest, setRecenterRequest] = useState(0)
  const [showDesigner, setShowDesigner] = useState(false)

  useEffect(() => {
    setOrientation(deviceMode === 'phone-portrait' ? 'portrait' : 'landscape')
  }, [deviceMode, setOrientation])

  // Opening any surface covers the map, so route editing exits with it — otherwise
  // the operator returns to a map that is still silently in tap-to-place mode.
  useEffect(() => {
    if (activeSurface) setRouteEditMode(false)
  }, [activeSurface, setRouteEditMode])

  useWakeLock(isRunning)

  const rightSurfaceOpen = isRightSurface(activeSurface)
  const drawerSide = orientation === 'portrait'
    ? 'bottom'
    : activeSurface === 'fleet'
      ? 'left'
      : rightSurfaceOpen
        ? 'right'
        : 'bottom'
  // Surfaces that render their own chrome outside the drawer must NOT also open it.
  // account/analytics/settings hand off to modals via openAccount(); 'replay' renders the
  // real ReplayPanel in .mobile-replay-host below. ReplayPanel is position:fixed z-index:200
  // and .mobile-replay-host sets no z-index, so an open drawer (z-index 401, inside the
  // position:fixed .mobile-shell stacking context) painted straight over the replay transport
  // — the operator got a one-line stub and no controls.
  const drawerOpen = activeSurface !== null
    && !['account', 'analytics', 'settings', 'replay'].includes(activeSurface)

  function openAccount(kind: 'account' | 'analytics' | 'settings') {
    closeSurface()
    if (!activeAccount) {
      setShowSignIn(true)
      return
    }
    if (kind === 'analytics') setShowAnalytics(true)
    else setShowSettings(true)
  }

  function requestRecenter() {
    setRecenterRequest((request) => request + 1)
    closeSurface()
  }

  return (
    <div
      className={`mobile-shell mobile-shell--${orientation}${isTablet ? ' mobile-shell--tablet' : ''}`}
      data-testid="mobile-shell"
      data-orientation={orientation}
      data-tablet={isTablet}
    >
      <header className="mobile-topbar">
        <span className="header-logo">⬡ DRONE OPS</span>
        <span className="header-mission-id">
          {scenario ? `${scenario.name} · ${scenario.seed}` : 'NO MISSION LOADED'}
        </span>
        {isRunning && <div className="rec-dot" title="Recording" />}
        {lifecycle === 'paused' && <span className="mobile-paused">PAUSED</span>}
        <MobileClock />
      </header>

      <div className="mobile-map">
        <TacticalMap chromeSlots="external" recenterRequest={recenterRequest} />

        {scenario?.missionBrief && (
          <button className="mobile-priority-chip" onClick={() => openSurface('dispatch')}>
            <span>{scenario.missionBrief.agencies.join(' / ')}</span>
            <strong>{scenario.missionBrief.primaryObjective}</strong>
          </button>
        )}

        {/* Tap-to-place route editing (mobile only). The pill only appears once a
            drone is selected; entering edit mode swaps it for a status banner. */}
        {selectedDroneId && !routeEditMode && (
          <button className="route-edit-pill" onClick={() => setRouteEditMode(true)}>
            ✎ ROUTE
          </button>
        )}

        {routeEditMode && selectedDroneId && (
          <div className="route-edit-banner" data-testid="route-edit-banner">
            <span>
              EDITING {selectedDroneId.toUpperCase()} · {(droneWaypoints[selectedDroneId] ?? []).length}/{MAX_WAYPOINTS_PER_DRONE} WPs
            </span>
            <button onClick={() => setRouteEditMode(false)}>DONE</button>
          </div>
        )}

        {/* A rejected edit (e.g. a waypoint across a no-fly boundary) surfaces the
            store's existing validation message rather than silently doing nothing. */}
        {routeEditMode && routeCommandError && (
          <div className="route-edit-toast" role="status">{routeCommandError}</div>
        )}

        <button className="mobile-edge-tab left" onClick={() => toggleSurface('fleet')} aria-pressed={activeSurface === 'fleet'}>
          FLEET
        </button>
        <button className="mobile-edge-tab right" onClick={() => openSurface(rightTab)} aria-pressed={rightSurfaceOpen}>
          DATA
        </button>

        <Drawer
          side={drawerSide}
          title={activeSurface ? SURFACE_TITLES[activeSurface] : ''}
          open={drawerOpen}
          onClose={closeSurface}
          dataSurface={activeSurface}
          testId="mobile-surface-drawer"
        >
          <SurfacePane active={activeSurface === 'fleet'} className="mobile-fleet-pane"><FleetPanel /></SurfacePane>

          <SurfacePane active={rightSurfaceOpen} className="mobile-data-pane">
            <div className="mobile-data-tabs" role="tablist" aria-label="Mission data">
              {(['ops', 'telemetry', 'evidence'] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={rightTab === tab}
                  className={rightTab === tab ? 'active' : ''}
                  onClick={() => setRightTab(tab)}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="mobile-data-content">
              <SurfacePane active={rightTab === 'ops'}><OperatorCommandPanel /></SurfacePane>
              <SurfacePane active={rightTab === 'telemetry'}><TelemetryPanel /></SurfacePane>
              <SurfacePane active={rightTab === 'evidence'}><EvidenceSheet /></SurfacePane>
            </div>
          </SurfacePane>

          <SurfacePane active={activeSurface === 'scenario'}>
            <ScenarioSheet
              onScenarioSelected={closeSurface}
              onOpenCustomMissions={() => { closeSurface(); setShowDesigner(true) }}
            />
          </SurfacePane>
          <SurfacePane active={activeSurface === 'mission'}><MissionSheet /></SurfacePane>
          <SurfacePane active={activeSurface === 'dispatch'}><MissionStatusFeed /></SurfacePane>
          <SurfacePane active={activeSurface === 'exports'}><ExportsSheet /></SurfacePane>
          {/* No 'replay' pane: the drawer stays shut for that surface (see drawerOpen above)
              and ReplayPanel owns the screen instead. The MORE button that opens it is already
              disabled without a replaySession, so the old "no replay available" stub was dead. */}
          <SurfacePane active={activeSurface === 'more'}>
            <div className="mobile-more-grid">
              <button onClick={() => { closeSurface(); setShowDesigner(true) }}>CUSTOM MISSIONS</button>
              <button onClick={() => openSurface('dispatch')} disabled={!scenario?.missionBrief}>DISPATCH</button>
              <button onClick={() => openSurface('replay')} disabled={!replaySession}>REPLAY</button>
              <button onClick={() => openSurface('exports')}>EXPORTS</button>
              <button onClick={() => openAccount('analytics')}>ANALYTICS</button>
              <button onClick={() => openAccount('account')}>{activeAccount ? 'ACCOUNT' : 'SIGN IN'}</button>
              <button onClick={() => openAccount('settings')} disabled={!activeAccount}>SETTINGS</button>
            </div>
            <MapToolsSheet onRecenter={requestRecenter} />
          </SurfacePane>
        </Drawer>
      </div>

      <BottomDock />

      <Suspense fallback={null}>
        <PreflightChecklist />
        <LaunchBayPlanner />
        {activeSurface === 'replay' && <div className="mobile-replay-host"><ReplayPanel /></div>}
        <SignInModal />
        <AccountPanels />
        {showDesigner && <CustomMissionHub mobile onClose={() => setShowDesigner(false)} />}
      </Suspense>

      {loadingDone && <WelcomeOverlay />}
      {!loadingDone && <LoadingScreen mapReady={mapReady} onComplete={() => setLoadingDone(true)} />}
    </div>
  )
}
