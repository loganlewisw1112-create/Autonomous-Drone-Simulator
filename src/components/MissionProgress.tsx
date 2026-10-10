import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { buildMissionProgress } from '@/sim/mission/missionObjectives'
import { useDroneStore } from '@/store/droneStore'

// `compact` is kept for callers (the phone dock passes it) but no longer changes the size: the floor is one token.
export function MissionProgress(_props: { compact?: boolean }) {
  const { scenario, drones, thermalContacts, events, positionHistory, elapsedSec } = useDroneStore(
    useShallow((state) => ({
      scenario: state.scenario,
      drones: state.drones,
      thermalContacts: state.thermalContacts,
      events: state.events,
      positionHistory: state.positionHistory,
      elapsedSec: state.elapsedSec,
    })),
  )
  const progress = useMemo(() => scenario ? buildMissionProgress({
    scenario,
    drones,
    thermalContacts,
    events,
    positionHistory,
    elapsedSec,
  }) : null, [scenario, drones, thermalContacts, events, positionHistory, elapsedSec])

  if (!progress) return null
  return (
    <span
      data-testid="mission-progress"
      aria-label={`Mission ${progress.percent}% complete`}
      title={progress.objectives.map((objective) => `${objective.label}: ${Math.round(objective.completion * 100)}%`).join(' · ')}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-min)',
        color: progress.percent >= 100 ? 'var(--accent-green)' : 'var(--accent-blue)',
        whiteSpace: 'nowrap',
      }}
    >
      TASK {progress.percent}%
    </span>
  )
}
