// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClassroomEntry } from '@/components/classroom/ClassroomEntry'
import { MissionScorecard } from '@/components/classroom/MissionScorecard'
import { useClassroomStore } from '@/classroom/classroomStore'
import { getScenarioById } from '@/scenarios/registry'
import { useDroneStore } from '@/store/droneStore'
import type { MissionAssessment } from '@/classroom/missionAssessment'

vi.mock('@/App', () => ({ default: () => <main data-testid="student-app">Simulator</main> }))

function assessment(patch: Partial<MissionAssessment> = {}): MissionAssessment {
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
    tier1: 44,
    tier2: 28,
    uncappedTotal: 72,
    total: 59,
    band: 'F',
    interventions: [{
      actorId: 'classroom:instructor:lead', droneId: 'uav-01',
      eventType: 'operator_command', tick: 120, command: 'rtb',
    }],
    ...patch,
  }
}

afterEach(() => {
  cleanup()
  useClassroomStore.getState().reset()
  useDroneStore.setState({ scenario: null })
})

describe('<MissionScorecard />', () => {
  it('surfaces progress, capped score, rubric tiers, and life-safety status', () => {
    render(<MissionScorecard assessment={assessment()} />)

    expect(screen.getByRole('complementary', { name: 'Mission assessment' })).toBeInTheDocument()
    expect(screen.getByLabelText('Band F, score 59')).toHaveTextContent('F · 59')
    expect(screen.getByText('72%')).toBeInTheDocument()
    expect(screen.getByText('FAIL')).toBeInTheDocument()
    expect(screen.getByText('score capped at 59')).toBeInTheDocument()
    expect(screen.getByText('44/60')).toBeInTheDocument()
    expect(screen.getByText('28/40')).toBeInTheDocument()
  })

  it('keeps objective, finding, and intervention detail available on demand', () => {
    render(<MissionScorecard assessment={assessment()} />)
    fireEvent.click(screen.getByText('Objectives and findings'))

    expect(screen.getByText('Recover fleet')).toBeInTheDocument()
    expect(screen.getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('CONTACT RESPONSE SLOW')).toBeInTheDocument()
    expect(screen.getByText('Response exceeded the threshold.')).toBeInTheDocument()
    expect(screen.getByText('1 instructor intervention recorded')).toBeInTheDocument()
  })

  it('mounts the scorecard as a sibling of App only in the live student shell', () => {
    const scenario = getScenarioById('demo_basic')
    expect(scenario).toBeDefined()
    useDroneStore.setState({ scenario: scenario!.config })
    useClassroomStore.setState({ status: 'live', role: 'student', classId: '7KX3M2' })

    render(<ClassroomEntry mode="student" />)

    const app = screen.getByTestId('student-app')
    const scorecard = screen.getByRole('complementary', { name: 'Mission assessment' })
    expect(app.parentElement).toBe(scorecard.parentElement)
    expect(screen.getByText(/CLASS 7KX3M2 · streaming/)).toBeInTheDocument()
  })
})
