// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ErrorBoundary } from '@/components/ErrorBoundary'

function Bomb(): never {
  throw new Error('render exploded')
}

describe('ErrorBoundary', () => {
  afterEach(() => cleanup())

  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>fleet nominal</div>
      </ErrorBoundary>,
    )
    expect(screen.getByText('fleet nominal')).toBeInTheDocument()
    expect(screen.queryByTestId('error-boundary-fallback')).not.toBeInTheDocument()
  })

  it('renders a fallback card instead of white-screening when a child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument()
    expect(screen.getByText('render exploded')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })

  it('RESET UI clears the error state', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const user = userEvent.setup()
    let shouldThrow = true
    function MaybeBomb() {
      if (shouldThrow) throw new Error('one-time failure')
      return <div>recovered</div>
    }
    const { rerender } = render(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByTestId('error-boundary-fallback')).toBeInTheDocument()

    shouldThrow = false
    await user.click(screen.getByRole('button', { name: 'RESET UI' }))
    rerender(
      <ErrorBoundary>
        <MaybeBomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('recovered')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})
