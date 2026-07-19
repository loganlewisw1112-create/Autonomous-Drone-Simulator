// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// The shell hosts the real MapLibre map + boot gate; neither runs in jsdom.
// Everything else (drawers, dock, sheets, reused panels) renders for real.
vi.mock('@/components/TacticalMap', () => ({ TacticalMap: () => <div data-testid="map-stub" /> }))
vi.mock('@/components/LoadingScreen', () => ({ LoadingScreen: () => null }))

import { MobileShell } from '@/components/mobile/MobileShell'
import { RotateGate } from '@/components/mobile/RotateGate'

beforeEach(() => {
  window.localStorage?.setItem('drone-sim:welcome-seen:v1', '1')
})

describe('RotateGate', () => {
  it('renders the landscape instruction', () => {
    render(<RotateGate />)
    expect(screen.getByText(/ROTATE DEVICE TO LANDSCAPE/i)).toBeInTheDocument()
  })
})

describe('MobileShell', () => {
  it('renders map, edge tabs, and the bottom dock', () => {
    render(<MobileShell />)
    expect(screen.getByTestId('map-stub')).toBeInTheDocument()
    expect(screen.getByTestId('mobile-dock')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'FLEET' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'TELEMETRY' })).toBeInTheDocument()
  })

  it('opens and closes the fleet drawer', () => {
    render(<MobileShell />)
    const drawer = screen.getByTestId('drawer-left')
    expect(drawer.className).not.toContain('open')
    fireEvent.click(screen.getByRole('button', { name: 'FLEET' }))
    expect(drawer.className).toContain('open')
    fireEvent.click(screen.getByLabelText('Close FLEET'))
    expect(drawer.className).not.toContain('open')
  })

  it('opens the scenario sheet from the dock with all variant controls', () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: /SCENARIO/ }))
    expect(screen.getByText('LOAD SCENARIO')).toBeInTheDocument()
    expect(screen.getByText('WEATHER SEVERITY')).toBeInTheDocument()
    expect(screen.getByText('COMMS DEGRADATION')).toBeInTheDocument()
  })

  it('opens the mission sheet with role, speed, and mission controls', () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: /MISSION/ }))
    expect(screen.getByText('SIM SPEED')).toBeInTheDocument()
    expect(screen.getByText('OPERATOR ROLE')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '⬆ RTB ALL' })).toBeInTheDocument()
  })

  it('exposes every desktop export in the exports sheet', () => {
    render(<MobileShell />)
    fireEvent.click(screen.getByRole('button', { name: /EXPORTS/ }))
    expect(screen.getByRole('button', { name: /AFTER ACTION/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /CUSTODY LOG/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /KML/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /GeoJSON/ })).toBeInTheDocument()
  })
})
