// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoadingScreen } from '@/components/LoadingScreen'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('LoadingScreen', () => {
  it('shows "waiting for first event" for the event chain, never the all-zero genesis hash', () => {
    const { container } = render(<LoadingScreen mapReady={false} onComplete={vi.fn()} />)
    act(() => {
      vi.advanceTimersByTime(800)
    })
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/0{8}/)
    expect(text).toContain('waiting for first event')
    const rows = container.querySelectorAll('.ls-check-row')
    expect(rows.length).toBe(5)
    expect(rows[3].textContent).toContain('EVENT INTEGRITY CHAIN')
    expect(rows[3].textContent).toContain('waiting for first event')
  })
})
