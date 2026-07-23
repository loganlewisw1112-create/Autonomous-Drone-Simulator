// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { TelemetryPanel } from '@/components/TelemetryPanel'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { useDroneStore } from '@/store/droneStore'
import { NIST_OBSTRUCTED_LANE } from '@/scenarios/nistLanes'
import { LANE_FEATURE_EVENT } from '@/sim/mission/laneScoring'
import { buildMissionAssessment } from '@/classroom/missionAssessment'
import type { MissionEvent } from '@/types'

/**
 * WP-9 surfacing: the lane score has to actually reach the operator and the instructor, not just
 * exist in a module. This renders the real READY tab and asserts the panel, and separately checks
 * that the assessment carries the score into the Coordinator comparison table's data.
 */

/** The measured obstructed-lane profile: 44/100 across a ragged 1–4 features per target. */
const MEASURED_DEPTHS = [2, 4, 3, 2, 1, 3, 3, 3, 4, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1, 1]

function laneEvents(depths: number[], elapsedSec = 60): MissionEvent[] {
  const events: MissionEvent[] = []
  NIST_OBSTRUCTED_LANE.targets.forEach((target, i) => {
    for (let f = 0; f < depths[i]; f += 1) {
      events.push({
        hash: `h${events.length + 1}`,
        prevHash: `h${events.length}`,
        eventType: LANE_FEATURE_EVENT,
        droneId: 'uav-01',
        operatorId: 'student-1',
        role: 'pic',
        tick: 100 + i * 20 + f,
        timestamp: 1_700_000_000_000 + events.length,
        payload: {
          laneId: NIST_OBSTRUCTED_LANE.id,
          targetId: target.id,
          featureIndex: f,
          elapsedSec,
        },
      })
    }
  })
  return events
}

const laneScenario = ALL_SCENARIOS.find((s) => s.id === 'nist_obstructed_lane')!
const ordinaryScenario = ALL_SCENARIOS.find((s) => s.id === 'demo_wildfire')!

function openReadyTab() {
  render(<TelemetryPanel />)
  fireEvent.click(screen.getByText('READY'))
}

describe('NIST lane score on the READY tab (WP-9)', () => {
  beforeEach(() => {
    cleanup()
    useDroneStore.getState().resetMission()
  })

  it('shows the score, target progress and the standard it is scored against', () => {
    useDroneStore.setState({
      scenario: laneScenario,
      events: laneEvents(MEASURED_DEPTHS),
      elapsedSec: 600,
    })
    openReadyTab()

    expect(screen.getByText('NIST Standard Test Method')).toBeTruthy()
    expect(screen.getByText('44 / 100')).toBeTruthy()
    // 20 attempted, none complete — the finest features were never bought.
    expect(screen.getByText(/0 complete \/ 20 attempted of 20/)).toBeTruthy()
    expect(screen.getByText(/within limit/)).toBeTruthy()

    // A score without its provenance is exactly what this package exists not to ship.
    expect(screen.getByText(/NIST Standard Test Methods for sUAS/)).toBeTruthy()
    expect(screen.getByText(/NFPA 2400/)).toBeTruthy()
    expect(screen.getByText(/ASTM F38\.03/)).toBeTruthy()
  })

  it('flags an overrun and says how much work it cost', () => {
    const late = laneEvents(MEASURED_DEPTHS, NIST_OBSTRUCTED_LANE.timeLimitSec + 60)
    useDroneStore.setState({
      scenario: laneScenario,
      events: late,
      elapsedSec: NIST_OBSTRUCTED_LANE.timeLimitSec + 120,
    })
    openReadyTab()

    expect(screen.getByText('0 / 100')).toBeTruthy()
    expect(screen.getByText(/EXCEEDED/)).toBeTruthy()
    expect(screen.getByText(/44 features not counted/)).toBeTruthy()
  })

  it('renders nothing at all for a scenario that is not a lane trial', () => {
    useDroneStore.setState({ scenario: ordinaryScenario, events: [], elapsedSec: 300 })
    openReadyTab()

    // An ordinary mission must not sprout an empty or zeroed standards score.
    expect(screen.queryByText('NIST Standard Test Method')).toBeNull()
    // The rest of READY still renders.
    expect(screen.getByText('Mission Outcome (measured)')).toBeTruthy()
  })
})

describe('lane score reaches the Coordinator comparison table (WP-9)', () => {
  it('rides on the assessment for lane trials and is absent otherwise', () => {
    const base = {
      drones: [],
      thermalContacts: [],
      metrics: {
        totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0, thermalContacts: 0,
        geofenceBreaches: 0, rtbTriggers: 0, recoveryDispatches: 0, groundUnitDispatch: 0,
      },
      elapsedSec: 600,
      interventionActorPrefix: 'instructor:',
    }

    const lane = buildMissionAssessment({
      ...base, scenario: laneScenario, events: laneEvents(MEASURED_DEPTHS),
    })
    expect(lane.nistLane?.score).toBe(44)
    expect(lane.nistLane?.standardRef).toMatch(/NFPA 2400/)
    // Reported ALONGSIDE the mission score, never folded into it — the two are different kinds
    // of claim and averaging them would contaminate the standards-referenced one.
    expect(lane.total).not.toBe(lane.nistLane!.score)

    const ordinary = buildMissionAssessment({ ...base, scenario: ordinaryScenario, events: [] })
    expect(ordinary.nistLane).toBeUndefined()
  })

  it('excludes instructor interventions from a participant lane score', () => {
    const participant = laneEvents([1, ...Array(19).fill(0)])
    const instructor = laneEvents([0, 5, ...Array(18).fill(0)])
      .map((e) => ({ ...e, operatorId: 'instructor:coach-1' }))

    const assessment = buildMissionAssessment({
      scenario: laneScenario,
      drones: [],
      thermalContacts: [],
      metrics: {
        totalFlightDistanceM: 0, waypointsReached: 0, conflictsDetected: 0, thermalContacts: 0,
        geofenceBreaches: 0, rtbTriggers: 0, recoveryDispatches: 0, groundUnitDispatch: 0,
      },
      events: [...participant, ...instructor],
      elapsedSec: 600,
      interventionActorPrefix: 'instructor:',
    })

    // Only the trainee's own single feature counts; the instructor's five do not.
    expect(assessment.nistLane?.score).toBe(1)
  })
})
