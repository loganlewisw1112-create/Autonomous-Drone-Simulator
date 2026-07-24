// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClassroomServerPrompt } from '@/components/classroom/ClassroomServerPrompt'
import { CLASSROOM_SERVER_PROMPT_SESSION_KEY } from '@/classroom/serverProbe'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('ClassroomServerPrompt', () => {
  it('Yes probes and reports an honest miss without claiming the server started', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))
    const onResolved = vi.fn()
    render(<ClassroomServerPrompt onResolved={onResolved} />)

    fireEvent.click(screen.getByTestId('classroom-server-yes'))
    await waitFor(() => {
      expect(screen.getByTestId('classroom-server-probe-result')).toHaveTextContent(/not found|No healthy/i)
    })
    expect(onResolved).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('classroom-server-continue'))
    expect(onResolved).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem(CLASSROOM_SERVER_PROMPT_SESSION_KEY)).toBe('1')
  })

  it('No shows setup instructions then continues', () => {
    const onResolved = vi.fn()
    render(<ClassroomServerPrompt onResolved={onResolved} />)
    fireEvent.click(screen.getByTestId('classroom-server-no'))
    expect(screen.getByTestId('classroom-server-setup')).toHaveTextContent(/npm run classroom:desktop/)
    fireEvent.click(screen.getByTestId('classroom-server-continue'))
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it('Yes reports success when /api/health is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/api/health')) {
        return {
          ok: true,
          json: async () => ({ ok: true, service: 'classroom-relay' }),
        }
      }
      throw new Error('unexpected')
    }))
    render(<ClassroomServerPrompt onResolved={() => {}} />)
    fireEvent.click(screen.getByTestId('classroom-server-yes'))
    await waitFor(() => {
      expect(screen.getByText(/Classroom Server found/i)).toBeInTheDocument()
      expect(screen.getByTestId('classroom-server-probe-result')).toHaveTextContent(/Relay responded/i)
    })
  })
})
