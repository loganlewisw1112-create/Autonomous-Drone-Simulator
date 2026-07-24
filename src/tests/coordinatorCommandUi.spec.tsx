// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoordinatorConsole } from '@/components/classroom/CoordinatorConsole'
import { ClassResults } from '@/components/classroom/ClassResults'
import { useClassroomStore, type ClassRunResult, type ClassroomCommandRecord } from '@/classroom/classroomStore'
import type { MissionAssessment } from '@/classroom/missionAssessment'
import type { ClassConfig } from '@/classroom/protocol'

const { closeClassMock, focusStudentMock, sendCommandMock } = vi.hoisted(() => ({
  closeClassMock: vi.fn(),
  focusStudentMock: vi.fn(),
  sendCommandMock: vi.fn((studentId: string | null) => studentId ? [studentId] : ['stu-ada', 'stu-bo']),
}))

vi.mock('@/classroom/classroomClient', () => ({
  closeClass: closeClassMock,
  focusStudent: focusStudentMock,
  sendCommand: sendCommandMock,
}))

const CONFIG: ClassConfig = {
  kind: 'catalog',
  scenarioId: 'demo_basic',
  variant: {
    seed: 7, timeOfDay: 'day', season: 'summer', weatherSeverity: 0,
    commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  },
}

function assessment(): MissionAssessment {
  return {
    progressPercent: 72,
    objectives: [{
      id: 'recover', kind: 'fleet_recovery', label: 'Recover fleet', weight: 1,
      completion: 0.5, completed: 1, total: 2,
    }],
    lifeSafety: {
      status: 'fail', severity: 'major', cap: 59,
      findings: [{
        code: 'CONTACT_RESPONSE_SLOW', severity: 'major', sourceId: 'thermal-1',
        message: 'Response exceeded the threshold.',
      }],
    },
    authorization: {
      requiredCount: 3, completedCount: 3, missedStepIds: [], complete: true, scoreContribution: 10,
    },
    tier1: 44,
    tier2: 28,
    uncappedTotal: 72,
    total: 59,
    band: 'F',
    interventions: [{
      actorId: 'classroom:instructor:B2CD3F', droneId: 'uav-01',
      eventType: 'operator_command', tick: 120, command: 'rtb',
    }],
  }
}

function commandRecord(commandId: string, status: ClassroomCommandRecord['status']): ClassroomCommandRecord {
  return {
    commandId,
    studentId: 'stu-ada',
    command: { commandId, kind: 'pause' },
    actorId: 'classroom:instructor:B2CD3F',
    issuedAt: 1,
    status,
  }
}

beforeEach(() => {
  closeClassMock.mockReset()
  focusStudentMock.mockReset()
  sendCommandMock.mockClear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  useClassroomStore.getState().reset()
  useClassroomStore.setState({
    role: 'instructor',
    status: 'live',
    classId: 'B2CD3F',
    config: CONFIG,
    roster: [
      { studentId: 'stu-ada', displayName: 'Ada', joinedAt: 1, studentPubKey: 'PUB-A' },
      { studentId: 'stu-bo', displayName: 'Bo', joinedAt: 2, studentPubKey: 'PUB-B' },
    ],
    focusedStudentId: 'stu-ada',
    frames: {
      'stu-ada': { t: 90, st: 1, d: [['uav-01', 3777000, -12241000, 45, 72, 3]], a: 0, th: 1, ev: 3, p: 72, b: 'F', sc: 59 },
      'stu-bo': { t: 80, st: 1, d: [['uav-01', 3777100, -12241100, 60, 88, 3]], a: 0, th: 0, ev: 1, p: 86, b: 'B', sc: 84 },
    },
    focusAssessment: assessment(),
    commands: [commandRecord('cmd-pending', 'pending'), commandRecord('cmd-acked', 'acknowledged'), commandRecord('cmd-failed', 'failed')],
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useClassroomStore.getState().reset()
})

describe('<CoordinatorConsole /> command authority', () => {
  it('issues focused and whole-class commands through the real client boundary', () => {
    render(<CoordinatorConsole />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(sendCommandMock).toHaveBeenLastCalledWith('stu-ada', expect.objectContaining({ kind: 'pause' }))

    fireEvent.change(screen.getByLabelText('Command target'), { target: { value: 'all' } })
    fireEvent.click(screen.getByRole('button', { name: 'RTB all' }))
    expect(sendCommandMock).toHaveBeenLastCalledWith(null, expect.objectContaining({ kind: 'rtb_all' }))

    fireEvent.change(screen.getByLabelText('Selected drone'), { target: { value: 'uav-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Hover' }))
    expect(sendCommandMock).toHaveBeenLastCalledWith(null, expect.objectContaining({ kind: 'hover', droneId: 'uav-01' }))

    fireEvent.change(screen.getByLabelText('Instructor directive'), { target: { value: 'Hold sector three' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send directive' }))
    expect(sendCommandMock).toHaveBeenLastCalledWith(null, expect.objectContaining({ kind: 'directive', text: 'Hold sector three' }))
  })

  it('expands a policy preset into role and speed commands for the selected target', () => {
    render(<CoordinatorConsole />)
    fireEvent.change(screen.getByLabelText('Command target'), { target: { value: 'all' } })
    fireEvent.change(screen.getByLabelText('Control policy preset'), { target: { value: 'observe_only' } })
    sendCommandMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Apply policy' }))

    expect(sendCommandMock).toHaveBeenCalledTimes(2)
    expect(sendCommandMock).toHaveBeenNthCalledWith(1, null, expect.objectContaining({ kind: 'set_operator_role', role: 'observer' }))
    expect(sendCommandMock).toHaveBeenNthCalledWith(2, null, expect.objectContaining({ kind: 'set_sim_speed', speed: 1 }))
  })

  it('renders the rubric wall, full focused assessment, and command status history', () => {
    render(<CoordinatorConsole />)

    const adaRubric = screen.getByLabelText('Ada rubric status')
    expect(adaRubric).toHaveTextContent('72%')
    expect(adaRubric).toHaveTextContent('Band F')
    expect(adaRubric).toHaveTextContent('59/100')

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    const detail = screen.getByLabelText('Focused student assessment')
    expect(detail).toHaveTextContent('72%')
    expect(detail).toHaveTextContent('F · 59')
    expect(detail).toHaveTextContent('44/60')
    expect(detail).toHaveTextContent('28/40')
    expect(detail).toHaveTextContent('Response exceeded the threshold.')

    const history = screen.getByLabelText('Command and intervention history')
    expect(history).toHaveTextContent('pending')
    expect(history).toHaveTextContent('acknowledged')
    expect(history).toHaveTextContent('failed')
    expect(history).toHaveTextContent('classroom:instructor:B2CD3F')
  })
})

describe('<ClassResults /> assessment columns', () => {
  it('shows score and band beside the submitted run', () => {
    const run = {
      studentId: 'stu-ada',
      displayName: 'Ada',
      assessment: assessment(),
      receivedAt: 1,
      summary: {
        durationSec: 420,
        completionReason: 'operator_ended',
        chainVerified: true,
        metrics: {
          waypointsReached: 4, conflictsDetected: 0, geofenceBreaches: 0, rtbTriggers: 1,
          thermalContacts: 2, recoveryDispatches: 0,
        },
        droneOutcomes: [{ batteryPct: 42 }],
      },
    } as unknown as ClassRunResult
    useClassroomStore.setState({ runs: [run] })

    render(<ClassResults classId="B2CD3F" />)

    const table = screen.getByRole('table')
    expect(within(table).getByText('Score')).toBeInTheDocument()
    expect(within(table).getByText('Band')).toBeInTheDocument()
    expect(within(table).getByText('59')).toBeInTheDocument()
    expect(within(table).getByText('F')).toBeInTheDocument()
  })
})
