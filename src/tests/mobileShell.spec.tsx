// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const device = vi.hoisted(() => ({ mode: 'phone-landscape' as 'phone-landscape' | 'phone-portrait', tablet: false }))

vi.mock('@/hooks/useDeviceMode', () => ({ useDeviceMode: () => device.mode, useIsTablet: () => device.tablet }))
vi.mock('@/components/TacticalMap', () => ({
  TacticalMap: ({ chromeSlots }: { chromeSlots?: string }) => <div data-testid="map-stub" data-chrome={chromeSlots} />,
}))
vi.mock('@/components/LoadingScreen', () => ({
  LoadingScreen: ({ onComplete }: { onComplete: () => void }) => <button onClick={onComplete}>FINISH LOADING</button>,
}))
vi.mock('@/components/FleetPanel', () => ({ FleetPanel: () => <div data-testid="fleet-panel">FLEET PANEL</div> }))
vi.mock('@/components/TelemetryPanel', () => ({ TelemetryPanel: () => <div data-testid="telemetry-panel">TELEMETRY PANEL</div> }))
vi.mock('@/components/OperatorCommandPanel', () => ({ OperatorCommandPanel: () => <div data-testid="ops-panel">OPS PANEL</div> }))
vi.mock('@/components/MissionStatusFeed', () => ({ MissionStatusFeed: () => <div data-testid="dispatch-panel">DISPATCH PANEL</div> }))
vi.mock('@/components/mobile/DroneQuickCommands', () => ({ DroneQuickCommands: () => <div data-testid="drone-quick-commands" /> }))
vi.mock('@/components/PreflightChecklist', () => ({ PreflightChecklist: () => null }))
vi.mock('@/components/LaunchBayPlanner', () => ({ LaunchBayPlanner: () => null }))
vi.mock('@/components/ReplayPanel', () => ({ ReplayPanel: () => <div data-testid="replay-panel">REPLAY</div> }))
vi.mock('@/components/account/SignInModal', () => ({ SignInModal: () => null }))
vi.mock('@/components/account/AccountPanels', () => ({ AccountPanels: () => null }))
vi.mock('@/components/designer/CustomMissionHub', () => ({ CustomMissionHub: () => <div data-testid="custom-mission-hub" /> }))

import { MobileShell } from '@/components/mobile/MobileShell'
import { useMobileStore } from '@/store/mobileStore'
import { useDroneStore } from '@/store/droneStore'

beforeEach(() => {
  device.mode = 'phone-landscape'
  device.tablet = false
  window.localStorage?.setItem('drone-sim:welcome-seen:v1', '1')
  useMobileStore.setState({
    activeSurface: null,
    rightTab: 'telemetry',
    loadingDone: true,
    orientation: 'landscape',
  })
  useDroneStore.setState({
    lifecycle: 'idle',
    scenario: null,
    replaySession: null,
    ui: { ...useDroneStore.getState().ui, isRunning: false, showPreflight: false, showLaunchBay: false },
  })
})
describe('MobileShell', () => {
  it('renders external map chrome, edge access, and a fixed four-action dock', () => {
    render(<MobileShell />)
    expect(screen.getByTestId('map-stub')).toHaveAttribute('data-chrome', 'external')
    expect(screen.getByRole('button', { name: 'FLEET' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'DATA' })).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Primary mission controls' }).querySelectorAll('button')).toHaveLength(4)
  })

  it('keeps exactly one surface open and closes it without intercepting the dock', () => {
    render(<MobileShell />)
    const drawer = screen.getByTestId('mobile-surface-drawer')
    expect(drawer).toHaveStyle({ pointerEvents: 'none' })

    fireEvent.click(screen.getByRole('button', { name: 'FLEET' }))
    expect(drawer).toHaveClass('left', 'open')
    expect(screen.getByTestId('fleet-panel').closest('.mobile-surface-pane')).toHaveClass('active')

    fireEvent.click(screen.getByRole('button', { name: 'DATA' }))
    expect(drawer).toHaveClass('right', 'open')
    expect(drawer).not.toHaveClass('left')
    expect(screen.getByTestId('telemetry-panel').closest('.mobile-surface-pane')).toHaveClass('active')

    fireEvent.click(screen.getByLabelText('Close MISSION DATA'))
    expect(drawer).not.toHaveClass('open')
    expect(drawer).toHaveStyle({ pointerEvents: 'none' })
  })

  it('provides OPS, telemetry, and evidence from the same data surface', () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: 'DATA' }))
    fireEvent.click(screen.getByRole('tab', { name: 'OPS' }))
    expect(screen.getByTestId('ops-panel').closest('.mobile-surface-pane')).toHaveClass('active')
    fireEvent.click(screen.getByRole('tab', { name: 'EVIDENCE' }))
    expect(screen.getByText('EVIDENCE CHAIN')).toBeInTheDocument()
    expect(useMobileStore.getState().activeSurface).toBe('evidence')
  })

  it('opens scenario controls and the custom mission entry', async () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: 'SCENARIO' }))
    expect(screen.getByText('LOAD SCENARIO')).toBeInTheDocument()
    expect(screen.getByText('WEATHER SEVERITY')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '+ CUSTOM MISSIONS' }))
    expect(await screen.findByTestId('custom-mission-hub')).toBeInTheDocument()
    expect(useMobileStore.getState().activeSurface).toBeNull()
  })

  it('makes all evidence exports reachable through More', () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: 'MORE' }))
    fireEvent.click(screen.getByRole('button', { name: 'EXPORTS' }))
    expect(screen.getByRole('button', { name: /AFTER ACTION/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /CUSTODY LOG/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /KML/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /GeoJSON/ })).toBeInTheDocument()
  })

  it('switches the primary action between Pause and Resume without ending the mission', () => {
    const view = render(<MobileShell />)
    act(() => useDroneStore.setState({ lifecycle: 'running', ui: { ...useDroneStore.getState().ui, isRunning: true } }))
    expect(screen.getByRole('button', { name: 'PAUSE' })).toBeInTheDocument()
    act(() => useDroneStore.setState({ lifecycle: 'paused', ui: { ...useDroneStore.getState().ui, isRunning: false } }))
    view.rerender(<MobileShell />)
    expect(screen.getByRole('button', { name: 'RESUME' })).toBeInTheDocument()
  })

  it('preserves loading and active-surface state across orientation changes', () => {
    useMobileStore.setState({ activeSurface: 'mission', loadingDone: true })
    const view = render(<MobileShell />)
    expect(screen.getByTestId('mobile-shell')).toHaveAttribute('data-orientation', 'landscape')
    expect(screen.queryByRole('button', { name: 'FINISH LOADING' })).not.toBeInTheDocument()

    device.mode = 'phone-portrait'
    view.rerender(<MobileShell />)
    expect(screen.getByTestId('mobile-shell')).toHaveAttribute('data-orientation', 'portrait')
    expect(screen.getByTestId('mobile-surface-drawer')).toHaveClass('bottom', 'open')
    expect(useMobileStore.getState().activeSurface).toBe('mission')
    expect(useMobileStore.getState().loadingDone).toBe(true)
  })
})
