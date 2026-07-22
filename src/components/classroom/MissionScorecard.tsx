import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CLASSROOM_INTERVENTION_ACTOR_PREFIX } from '@/classroom/commandAttribution'
import { buildMissionAssessment, type MissionAssessment } from '@/classroom/missionAssessment'
import { useDroneStore } from '@/store/droneStore'

export interface MissionScorecardProps {
  /** Test/debrief injection; live students read the current simulator snapshot. */
  assessment?: MissionAssessment | null
}

export function MissionScorecard({ assessment: suppliedAssessment }: MissionScorecardProps) {
  const snapshot = useDroneStore(useShallow((state) => ({
    scenario: state.scenario,
    drones: state.drones,
    thermalContacts: state.thermalContacts,
    groundUnits: state.groundUnits,
    events: state.events,
    metrics: state.metrics,
    positionHistory: state.positionHistory,
    elapsedSec: state.elapsedSec,
    lifecycle: state.lifecycle,
  })))

  const liveAssessment = useMemo(() => {
    if (!snapshot.scenario) return null
    return buildMissionAssessment({
      scenario: snapshot.scenario,
      drones: snapshot.drones,
      thermalContacts: snapshot.thermalContacts,
      groundUnits: snapshot.groundUnits,
      events: snapshot.events,
      metrics: snapshot.metrics,
      positionHistory: snapshot.positionHistory,
      elapsedSec: snapshot.elapsedSec,
      isFinal: snapshot.lifecycle === 'completed',
      interventionActorPrefix: CLASSROOM_INTERVENTION_ACTOR_PREFIX,
    })
  }, [snapshot])

  const assessment = suppliedAssessment === undefined ? liveAssessment : suppliedAssessment
  if (!assessment) return null

  const lifeSafetyClass = assessment.lifeSafety.status === 'pass' ? 'pass' : assessment.lifeSafety.severity

  return (
    <aside className="cls-scorecard" aria-label="Mission assessment">
      <header className="cls-scorecard-header">
        <span>MISSION ASSESSMENT</span>
        <strong aria-label={`Band ${assessment.band}, score ${assessment.total}`}>{assessment.band} · {assessment.total}</strong>
      </header>

      <div className="cls-scorecard-progress-row">
        <label htmlFor="cls-mission-progress">TASK PROGRESS</label>
        <strong>{assessment.progressPercent}%</strong>
      </div>
      <progress id="cls-mission-progress" max={100} value={assessment.progressPercent} />

      <div className={`cls-scorecard-safety ${lifeSafetyClass}`}>
        <span>LIFE SAFETY</span>
        <strong>{assessment.lifeSafety.status.toUpperCase()}</strong>
        {assessment.lifeSafety.cap < 100 && <span>score capped at {assessment.lifeSafety.cap}</span>}
      </div>

      <div className="cls-scorecard-tiers" aria-label="Assessment tiers">
        <span>STABILIZATION <strong>{assessment.tier1}/60</strong></span>
        <span>STEWARDSHIP <strong>{assessment.tier2}/40</strong></span>
      </div>

      <details className="cls-scorecard-details">
        <summary>Objectives and findings</summary>
        <ul className="cls-scorecard-objectives">
          {assessment.objectives.map((objective) => (
            <li key={objective.id}>
              <span>{objective.label}</span>
              <strong>{Math.round(objective.completion * 100)}%</strong>
            </li>
          ))}
        </ul>
        {assessment.lifeSafety.findings.length > 0 && (
          <div className="cls-scorecard-findings">
            {assessment.lifeSafety.findings.map((finding, index) => (
              <p key={`${finding.code}:${finding.sourceId ?? finding.droneId ?? index}`} className={finding.severity}>
                <strong>{finding.code.replaceAll('_', ' ')}</strong>
                <span>{finding.message}</span>
              </p>
            ))}
          </div>
        )}
        {assessment.interventions.length > 0 && (
          <p className="cls-scorecard-interventions">
            {assessment.interventions.length} instructor intervention{assessment.interventions.length === 1 ? '' : 's'} recorded
          </p>
        )}
      </details>
    </aside>
  )
}
