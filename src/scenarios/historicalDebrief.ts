import type { MissionAssessment } from '@/classroom/missionAssessment'
import type { BacktestAnchor, HistoricalCase, ScenarioConfig } from '@/types'

export interface HistoricalDebriefData {
  scenarioId: string
  historicalCase: HistoricalCase
  backtestAnchors: BacktestAnchor[]
  operatorMetrics: {
    elapsedSec: number
    progressPercent: number
    thermalContactsFound: number
    totalScore?: number
  }
  instructorNotes?: string
  discussionPrompts: string[]
}

/** Build debrief panel payload from scenario metadata + live assessment (Phase 5b). */
export function buildHistoricalDebrief(
  scenario: ScenarioConfig,
  assessment: Pick<MissionAssessment, 'progressPercent' | 'total'> | null,
  metrics: { elapsedSec: number; thermalContactsFound: number },
): HistoricalDebriefData | null {
  if (!scenario.historicalCase) return null
  return {
    scenarioId: scenario.id,
    historicalCase: scenario.historicalCase,
    backtestAnchors: scenario.backtestAnchors ?? [],
    operatorMetrics: {
      elapsedSec: metrics.elapsedSec,
      progressPercent: assessment?.progressPercent ?? 0,
      thermalContactsFound: metrics.thermalContactsFound,
      totalScore: assessment?.total,
    },
    instructorNotes: scenario.historicalCase.instructorNotes,
    discussionPrompts: scenario.historicalCase.discussionPrompts ?? [],
  }
}
