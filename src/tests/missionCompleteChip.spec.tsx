// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useDeviceMode', () => ({ useDeviceMode: () => 'phone-portrait', useIsTablet: () => false }))
vi.mock('@/components/TacticalMap', () => ({ TacticalMap: () => <div data-testid="map-stub" /> }))
vi.mock('@/components/LoadingScreen', () => ({ LoadingScreen: () => null }))
vi.mock('@/components/FleetPanel', () => ({ FleetPanel: () => null }))
vi.mock('@/components/TelemetryPanel', () => ({ TelemetryPanel: () => null }))
vi.mock('@/components/OperatorCommandPanel', () => ({ OperatorCommandPanel: () => null }))
vi.mock('@/components/MissionStatusFeed', () => ({ MissionStatusFeed: () => null }))
vi.mock('@/components/mobile/DroneQuickCommands', () => ({ DroneQuickCommands: () => null }))
vi.mock('@/components/PreflightChecklist', () => ({ PreflightChecklist: () => null }))
vi.mock('@/components/LaunchBayPlanner', () => ({ LaunchBayPlanner: () => null }))
vi.mock('@/components/ReplayPanel', () => ({ ReplayPanel: () => null }))
vi.mock('@/components/account/SignInModal', () => ({ SignInModal: () => null }))
vi.mock('@/components/account/AccountPanels', () => ({ AccountPanels: () => null }))
vi.mock('@/components/designer/CustomMissionHub', () => ({ CustomMissionHub: () => null }))

import { MobileShell } from '@/components/mobile/MobileShell'
import { useMobileStore } from '@/store/mobileStore'
import { useDroneStore } from '@/store/droneStore'

beforeEach(() => {
  window.localStorage?.setItem('drone-sim:welcome-seen:v1', '1')
  useMobileStore.setState({ activeSurface: null, rightTab: 'telemetry', loadingDone: true, orientation: 'portrait' })
  useDroneStore.setState({ lifecycle: 'idle', scenario: null, replaySession: null })
})

afterEach(() => cleanup())

describe('phone end-of-mission chip', () => {
  it('appears (lazily) only when the mission is completed, with a label that is not "after action"', async () => {
    useDroneStore.setState({ lifecycle: 'completed' })
    render(<MobileShell />)
    const chip = await screen.findByTestId('mission-complete-chip')
    expect(chip).toHaveTextContent('Mission complete · View report')
    expect(chip.textContent).not.toMatch(/AFTER ACTION/i)
    expect(chip.className).toContain('mobile-complete-chip')
  })

  it.each(['idle', 'preflight', 'running', 'paused'] as const)('is absent while the lifecycle is %s', async (lifecycle) => {
    useDroneStore.setState({ lifecycle })
    render(<MobileShell />)
    // Let any lazy chunk settle before asserting absence.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId('mission-complete-chip')).toBeNull()
  })

  it('does not match the Exports sheet query that mobileShell.spec relies on', async () => {
    useDroneStore.setState({ lifecycle: 'completed' })
    render(<MobileShell />)
    await screen.findByTestId('mission-complete-chip')
    expect(screen.queryByRole('button', { name: /AFTER ACTION/ })).toBeNull()
  })
})
