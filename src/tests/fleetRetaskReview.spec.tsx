// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FleetRetaskReview } from '@/components/FleetRetaskReview'
import type { FleetRetaskApplyResult } from '@/store/droneStore'

function result(patch: Partial<FleetRetaskApplyResult> = {}): FleetRetaskApplyResult {
  return {
    status: 'applied',
    situationHash: 'situation-1',
    requestedAt: 10_000,
    fromCache: false,
    changedDroneIds: ['uav-01'],
    entries: [
      { droneId: 'uav-01', status: 'applied', reason: 'route_applied' },
      { droneId: 'uav-02', status: 'held', reason: 'advisor_hold' },
      { droneId: 'uav-03', status: 'skipped', reason: 'battery_reserve' },
      { droneId: 'uav-04', status: 'failed', reason: 'persistence_failed' },
      { droneId: 'uav-05', status: 'warning', reason: 'route_capped' },
    ],
    ...patch,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('<FleetRetaskReview />', () => {
  it('summarizes applied, held, skipped, failed, and warning results', () => {
    render(<FleetRetaskReview result={result()} onUndo={() => true} />)

    expect(screen.getByText('FLEET RETASKED')).toBeInTheDocument()
    expect(screen.getByText('1 APPLIED · 1 HELD · 1 SKIPPED · 1 FAILED · 1 WARNING')).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'LI' && element.textContent === 'UAV-02 · HELD · hold position')).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'LI' && element.textContent === 'UAV-03 · SKIPPED · below battery reserve')).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'LI' && element.textContent === 'UAV-04 · FAILED · route save failed')).toBeInTheDocument()
  })

  it('keeps a prior undo available through its inclusive deadline even when the latest result is cooldown', () => {
    vi.useFakeTimers()
    vi.setSystemTime(18_000)
    render(
      <FleetRetaskReview
        result={result({ status: 'cooldown', changedDroneIds: [], entries: [], undoUntil: undefined })}
        undoUntil={18_000}
        onUndo={() => true}
      />,
    )

    expect(screen.getByText('FLEET RETASK · COOLDOWN ACTIVE')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '↶ UNDO FLEET RETASK (0s)' })).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(250))
    expect(screen.queryByRole('button', { name: /UNDO FLEET RETASK/ })).not.toBeInTheDocument()
  })

  it('surfaces a synchronous undo failure and supports the compact variant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const view = render(
      <FleetRetaskReview
        result={result({ status: 'failed', message: 'Fleet route persistence failed' })}
        undoUntil={18_000}
        onUndo={() => false}
        compact
      />,
    )

    expect(view.container.firstChild).toHaveClass('fleet-retask-review--compact')
    expect(screen.getByText('FLEET RETASK FAILED')).toBeInTheDocument()
    expect(screen.getByText('Fleet route persistence failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '↶ UNDO FLEET RETASK (8s)' }))
    expect(screen.getByText('UNDO FAILED · TRY AGAIN')).toBeInTheDocument()
  })
})
