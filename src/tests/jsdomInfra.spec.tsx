// @vitest-environment jsdom
// Infra sanity check: proves the jsdom environment + @testing-library/react + jest-dom matchers
// are wired correctly, so the component specs in later phases have a trustworthy foundation.
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

describe('component test infrastructure', () => {
  it('renders a React element into jsdom and matches with jest-dom', () => {
    render(<button disabled>ARMED</button>)
    const btn = screen.getByRole('button', { name: 'ARMED' })
    expect(btn).toBeInTheDocument()
    expect(btn).toBeDisabled()
  })
})
