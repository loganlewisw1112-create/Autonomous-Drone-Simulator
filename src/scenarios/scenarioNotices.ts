import type { ScenarioConfig } from '@/types'

// Pitch review k5. Scenario briefs name real agencies, and ten scenarios are built on real
// disasters. The no-endorsement notice used to live only in THIRD_PARTY_NOTICES.md; it now
// travels with the brief wherever agency names are on screen, and a historical scenario says
// plainly that it is a training exercise built on a real event in which people were harmed.

export const AGENCY_NAMES_NOTICE =
  'Agency and organization names are used for training realism only. They do not imply endorsement, certification, or operational approval.'

/** One respectful line for a scenario built on a real event, or null for every other scenario. */
export function historicalScenarioNote(scenario: Pick<ScenarioConfig, 'historicalCase'> | null | undefined): string | null {
  const event = scenario?.historicalCase
  if (!event) return null
  return `Built from public records of a real event: ${event.eventName}, ${event.eventDate}. People were harmed. This is a simulated training exercise, offered with respect for those affected and the responders who served.`
}
