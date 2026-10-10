// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ClassroomWindowsGate, DesktopPlatformGate } from '@/components/PlatformGate'
import { MOBILE_APP_URL } from '@/platform/appTarget'

describe('DesktopPlatformGate', () => {
  it('shows an error and sends non-desktop visitors to the mobile deployment', () => {
    render(<DesktopPlatformGate />)
    expect(screen.getByText('ERROR')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'DESKTOP VERSION ONLY' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OPEN MOBILE VERSION' })).toHaveAttribute('href', MOBILE_APP_URL)
  })
})

describe('ClassroomWindowsGate', () => {
  it('blocks phones/tablets and offers the solo mobile simulator', () => {
    render(<ClassroomWindowsGate />)
    expect(screen.getByTestId('classroom-windows-gate')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'WINDOWS CLASSROOM ONLY' })).toBeInTheDocument()
    expect(screen.getByText(/Phones and tablets are not supported/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OPEN SOLO MOBILE SIMULATOR' })).toHaveAttribute('href', MOBILE_APP_URL)
  })
})
