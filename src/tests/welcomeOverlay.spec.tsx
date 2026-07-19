// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WelcomeOverlay } from '@/components/WelcomeOverlay'
import { useDroneStore } from '@/store/droneStore'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { stopSimLoop } from '@/sim/SimulationLoop'

const WELCOME_KEY = 'drone-sim:welcome-seen:v1'

describe('<WelcomeOverlay />', () => {
  beforeEach(() => {
    localStorage.clear()
    useDroneStore.setState({
      scenario: null,
      drones: [],
      launchPlan: null,
      ui: { ...useDroneStore.getState().ui, isRunning: false },
    })
  })

  afterEach(() => {
    stopSimLoop()
    useDroneStore.setState({ ui: { ...useDroneStore.getState().ui, isRunning: false } })
    cleanup()
  })

  it('shows on a cold first visit', () => {
    render(<WelcomeOverlay />)
    expect(screen.getByRole('dialog', { name: 'Welcome' })).toBeInTheDocument()
    expect(screen.getByTestId('welcome-launch-demo')).toBeInTheDocument()
  })

  it('stays hidden once the seen flag is set', () => {
    localStorage.setItem(WELCOME_KEY, '1')
    render(<WelcomeOverlay />)
    expect(screen.queryByRole('dialog', { name: 'Welcome' })).not.toBeInTheDocument()
  })

  it('stays hidden when a scenario is already loaded', () => {
    useDroneStore.setState({ scenario: ALL_SCENARIOS[0] })
    render(<WelcomeOverlay />)
    expect(screen.queryByRole('dialog', { name: 'Welcome' })).not.toBeInTheDocument()
  })

  it('"Explore manually" dismisses and persists the flag', async () => {
    const user = userEvent.setup()
    render(<WelcomeOverlay />)
    await user.click(screen.getByRole('button', { name: 'Explore manually' }))
    expect(screen.queryByRole('dialog', { name: 'Welcome' })).not.toBeInTheDocument()
    expect(localStorage.getItem(WELCOME_KEY)).toBe('1')
  })

  it('"LAUNCH DEMO" starts a running demo mission', async () => {
    const user = userEvent.setup()
    render(<WelcomeOverlay />)
    await user.click(screen.getByTestId('welcome-launch-demo'))

    const s = useDroneStore.getState()
    expect(s.scenario?.id).toBe('demo_basic')
    expect(s.ui.isRunning).toBe(true)
    expect(s.launchPlan?.readyToLaunch).toBe(true)
    expect(localStorage.getItem(WELCOME_KEY)).toBe('1')
    expect(screen.queryByRole('dialog', { name: 'Welcome' })).not.toBeInTheDocument()
  })
})
