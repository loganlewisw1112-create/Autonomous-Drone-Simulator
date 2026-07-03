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
}

export function buildAfterActionPackage(input: BuildAfterActionPackageInput): AfterActionPackage {
  const outcome = buildMissionOutcomeSummary({
    scenario: input.scenario,
    drones: input.drones,
    metrics: input.metrics,
    thermalContacts: input.thermalContacts,
    eventsCount: input.events.length,
    elapsedSec: input.elapsedSec,
  })
  const compliance = buildComplianceState({
    scenario: input.scenario,
    drones: input.drones,
    scenarioVariant: input.scenarioVariant,
    elapsedSec: input.elapsedSec,
  })
  const utm = buildUtmAirspaceState({
    scenario: input.scenario,
    drones: input.drones,
    elapsedSec: input.elapsedSec,
  })
  const scenarioId = input.scenario?.id ?? 'no-scenario'
  const scenarioName = input.scenario?.name ?? 'No scenario loaded'
  const chainHash = input.events.at(-1)?.hash ?? '0'.repeat(64)
  const positionSampleCount = Object.values(input.positionHistory).reduce((sum, samples) => sum + samples.length, 0)

  return {
    kind: 'investor_after_action_package',
    generatedAt: new Date().toISOString(),
    scenarioId,
    scenarioName,
    scenarioVariant: { ...input.scenarioVariant },
    missionReport: {
      title: `${scenarioName} - Investor Demo After Action`,
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
      droneCount: input.drones.length,
      positionSampleCount,
    },
  }
}

export function serializeAfterActionPackage(packageData: AfterActionPackage): string {
  return JSON.stringify(packageData, null, 2)
}
