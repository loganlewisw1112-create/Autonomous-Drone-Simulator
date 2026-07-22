// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClassroomEntry } from '@/components/classroom/ClassroomEntry'
import { JoinGate } from '@/components/classroom/JoinGate'
import { useClassroomStore } from '@/classroom/classroomStore'

const { joinClassMock } = vi.hoisted(() => ({ joinClassMock: vi.fn() }))

vi.mock('@/classroom/classroomClient', () => ({ joinClass: joinClassMock }))
vi.mock('@/App', () => ({ default: () => <main>Simulator</main> }))

beforeEach(() => {
  joinClassMock.mockReset()
  useClassroomStore.getState().reset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('classroom remote-control disclosure', () => {
  it('requires explicit consent before joining and passes that consent to the client', () => {
    render(<JoinGate initialClassId="B2CD3F" />)
    fireEvent.change(screen.getByPlaceholderText('Your name'), { target: { value: 'Ada' } })

    const join = screen.getByRole('button', { name: 'Join class' })
    expect(join).toBeDisabled()
    expect(joinClassMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: /remotely control this simulator/i }))
    expect(join).toBeEnabled()
    fireEvent.click(join)

    expect(joinClassMock).toHaveBeenCalledWith('B2CD3F', 'Ada', true)
  })

  it('shows command and actor in a takeover alert for at least three seconds', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T12:00:00Z'))
    const now = Date.now()
    useClassroomStore.setState({
      status: 'live',
      role: 'student',
      classId: 'B2CD3F',
      takeoverNotice: {
        commandId: 'cmd-1',
        command: { commandId: 'cmd-1', kind: 'rtb', droneId: 'uav-03' },
        actorId: 'classroom:instructor:B2CD3F',
        label: 'UAV-03 → RETURN TO BASE',
        executedAt: now,
        expiresAt: now + 3_000,
      },
    })

    render(<ClassroomEntry mode="student" />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveClass('cls-takeover-banner')
    expect(alert).toHaveTextContent('INSTRUCTOR CONTROL')
    expect(alert).toHaveTextContent('UAV-03 → RETURN TO BASE')
    expect(alert).toHaveTextContent('classroom:instructor:B2CD3F')

    act(() => vi.advanceTimersByTime(2_999))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(useClassroomStore.getState().takeoverNotice).toBeNull()
  })
})
