import type { MissionAssessment } from '@/classroom/missionAssessment'
import type { BacktestAnchor, HistoricalCase, ScenarioConfig } from '@/types'

interface HistoricalTeachingMetadata {
  instructorNotes?: string
  discussionPrompts?: string[]
}

const HISTORICAL_TEACHING_METADATA: Readonly<Record<string, HistoricalTeachingMetadata>> = {
  hist_kilauea_leilani_2018: {
    instructorNotes: 'Emphasize moving geofence (lava front) and night precision guidance — not pursuit.',
    discussionPrompts: [
      'How would you score time-to-first-contact vs the documented extraction?',
      'What altitude band keeps LOS to EOC while staying clear of gas plumes?',
    ],
  },
  hist_katrina_lower_ninth_2005: {
    instructorNotes: 'Handle with care — capability gap framing only, never blame assignment.',
  },
  hist_marshall_fire_2021: {
    instructorNotes: 'Marshall keeps peak-wind conditions — launch refusal IS the realism.',
  },
}

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

/** Build the classroom debrief payload from shared scenario facts plus teaching metadata. */
export function buildHistoricalDebrief(
  scenario: ScenarioConfig,
  assessment: Pick<MissionAssessment, 'progressPercent' | 'total'> | null,
  metrics: { elapsedSec: number; thermalContactsFound: number },
): HistoricalDebriefData | null {
  if (!scenario.historicalCase) return null
  const teachingMetadata = HISTORICAL_TEACHING_METADATA[scenario.id]
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
    instructorNotes: teachingMetadata?.instructorNotes,
    discussionPrompts: teachingMetadata?.discussionPrompts ?? [],
  }
}
