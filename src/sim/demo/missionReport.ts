import { buildComplianceState } from '@/sim/demo/complianceEngine'
import { buildMissionOutcomeSummary } from '@/sim/demo/missionOutcome'
import { buildUtmAirspaceState } from '@/sim/demo/utmEngine'
import { verifyChain } from '@/utils/chainOfCustody'
import type {
  AfterActionPackage,
  DroneState,
  LatLng,
  MissionEvent,
  MissionMetrics,
  MissionReplaySession,
  ScenarioConfig,
  ScenarioVariantConfig,
  ThermalContactState,
} from '@/types'

interface BuildAfterActionPackageInput {
  scenario: ScenarioConfig | null
  scenarioVariant: ScenarioVariantConfig
  drones: DroneState[]
  metrics: MissionMetrics
  thermalContacts: ThermalContactState[]
  events: MissionEvent[]
  elapsedSec: number
  replayFrameCount: number
  positionHistory: Record<string, LatLng[]>
  // When a finalized replay session exists, its end-of-mission snapshot takes precedence over
  // the live store fields — scrubbing overwrites those, and an after-action must always
  // describe the mission's final state, not wherever the scrubber happens to sit.
  replaySession?: MissionReplaySession | null
}

export function buildAfterActionPackage(input: BuildAfterActionPackageInput): AfterActionPackage {
  const drones = input.replaySession?.finalDrones ?? input.drones
  const thermalContacts = input.replaySession?.finalThermalContacts ?? input.thermalContacts
  const outcome = buildMissionOutcomeSummary({
    scenario: input.scenario,
    drones,
    metrics: input.metrics,
    thermalContacts,
    eventsCount: input.events.length,
    elapsedSec: input.elapsedSec,
  })
  const compliance = buildComplianceState({
    scenario: input.scenario,
    drones,
    scenarioVariant: input.scenarioVariant,
    elapsedSec: input.elapsedSec,
  })
  const utm = buildUtmAirspaceState({
    scenario: input.scenario,
    drones,
    elapsedSec: input.elapsedSec,
  })
  const scenarioId = input.scenario?.id ?? 'no-scenario'
  const scenarioName = input.scenario?.name ?? 'No scenario loaded'
  const chainHash = input.events.at(-1)?.hash ?? '0'.repeat(64)
  const positionSampleCount = Object.values(input.positionHistory).reduce((sum, samples) => sum + samples.length, 0)

  return {
    kind: 'after_action_package',
    generatedAt: new Date().toISOString(),
    scenarioId,
    scenarioName,
    scenarioVariant: { ...input.scenarioVariant },
    missionReport: {
      title: `${scenarioName} - After Action Report`,
      summary: `${outcome.headline} ${input.events.length} chain-of-custody events captured for review.`,
      replayFrameCount: input.replayFrameCount,
      eventCount: input.events.length,
    },
    outcome,
    compliance,
    utm,
    evidence: {
      chainHash,
      chainVerified: verifyChain(input.events),
      kpiCount: 8,
      droneCount: drones.length,
      positionSampleCount,
    },
  }
}

export function serializeAfterActionPackage(packageData: AfterActionPackage): string {
  return JSON.stringify(packageData, null, 2)
}
