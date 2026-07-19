// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { WindowsPlatformGate } from '@/components/PlatformGate'
import { MOBILE_APP_URL } from '@/platform/appTarget'

describe('WindowsPlatformGate', () => {
  it('shows an error and sends non-Windows visitors to the mobile deployment', () => {
    render(<WindowsPlatformGate />)
    expect(screen.getByText('ERROR')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'WINDOWS VERSION ONLY' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'OPEN MOBILE VERSION' })).toHaveAttribute('href', MOBILE_APP_URL)
  })
})
