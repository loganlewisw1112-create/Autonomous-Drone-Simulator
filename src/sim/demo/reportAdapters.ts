/**
 * Adapters from the two places a finished mission lives (the live Zustand store, a stored account run)
 * to the pure `ReportSource` consumed by buildReportViewModel. They contain no clock reads: the
 * report timestamp is the package's own generatedAt.
 */
import { buildAfterActionPackage } from '@/sim/demo/missionReport'
import { buildVehicleTracks } from '@/sim/demo/reportVehicleTracks'
import type { ReportSource } from '@/sim/demo/reportViewModel'
import { verifyChain, getGenesisHash } from '@/utils/chainOfCustody'
import { firstChainBreak } from '@/utils/chainInspect'
import { inspectEvidence } from '@/components/rundetail/evidenceStatus'
import type { StoredRunDetailV2, StoredRunSummary } from '@/account/types'
import type {
  DroneState,
  GroundUnitState,
  LatLng,
  MissionEvent,
  MissionMetrics,
  MissionReplaySession,
  RecoveryTeamState,
  ScenarioConfig,
  ScenarioVariantConfig,
  ThermalContactState,
} from '@/types'

/** The slice of the drone store the live adapter reads (the whole store state satisfies it). */
export interface LiveReportState {
  scenario: ScenarioConfig | null
  scenarioVariant: ScenarioVariantConfig
  drones: DroneState[]
  metrics: MissionMetrics
  thermalContacts: ThermalContactState[]
  groundUnits: GroundUnitState[]
  recoveryTeams: RecoveryTeamState[]
  events: MissionEvent[]
  elapsedSec: number
  positionHistory: Record<string, LatLng[]>
  replaySession: MissionReplaySession | null
}

/**
 * Live run -> ReportSource. When a replay session exists its end-of-mission snapshot wins over the live
 * fields, because scrubbing overwrites live drones / contacts / units with an old frame.
 * Returns null when no scenario is loaded.
 */
export function reportSourceFromLive(store: LiveReportState): ReportSource | null {
  const { scenario, replaySession } = store
  if (!scenario) return null
  const finalDrones = replaySession?.finalDrones ?? store.drones
  const thermalContacts = replaySession?.finalThermalContacts ?? store.thermalContacts
  const events = replaySession?.events ?? store.events
  const metrics = replaySession?.metrics ?? store.metrics
  const groundUnits = replaySession?.finalGroundUnits ?? store.groundUnits
  const recoveryTeams = replaySession?.finalRecoveryTeams ?? store.recoveryTeams
  const scenarioVariant = replaySession?.scenarioVariant ?? store.scenarioVariant

  const pkg = buildAfterActionPackage({
    scenario,
    scenarioVariant,
    drones: store.drones,
    metrics,
    thermalContacts: store.thermalContacts,
    events,
    elapsedSec: store.elapsedSec,
    replayFrameCount: replaySession?.frames.length ?? 0,
    positionHistory: store.positionHistory,
    replaySession,
  })
  const verified = events.length > 0 && verifyChain(events)
  const breakIndex = verified ? null : firstChainBreak(events)
  return {
    scenario,
    scenarioVariant,
    events,
    finalDrones,
    positionHistory: store.positionHistory,
    thermalContacts,
    package: pkg,
    generatedAtIso: pkg.generatedAt,
    chain: {
      verified,
      eventCount: events.length,
      headHash: events.at(-1)?.hash ?? getGenesisHash(),
      ...(breakIndex !== null ? { failureIndex: breakIndex } : {}),
    },
    vehicleTracks: buildVehicleTracks(groundUnits, recoveryTeams, scenario),
  }
}

/** Stored (signed-in) run -> ReportSource. Returns null when the run has no full detail. */
export function reportSourceFromStoredRun(summary: StoredRunSummary, detail: StoredRunDetailV2 | null): ReportSource | null {
  if (!detail) return null
  const status = inspectEvidence(summary, detail)
  const lastFrame = detail.replayFrames.at(-1)
  const thermalContacts = lastFrame?.thermalContacts ?? []
  return {
    scenario: detail.scenario,
    scenarioVariant: detail.scenarioVariant,
    events: detail.events,
    finalDrones: detail.finalDrones,
    positionHistory: detail.positionHistory,
    thermalContacts,
    package: detail.report,
    generatedAtIso: detail.report.generatedAt,
    chain: {
      verified: status.state === 'verified',
      eventCount: detail.events.length,
      headHash: detail.events.at(-1)?.hash ?? getGenesisHash(),
      ...(status.state === 'failed' ? { failureIndex: status.failureIndex } : {}),
    },
    vehicleTracks: lastFrame ? buildVehicleTracks(lastFrame.groundUnits, lastFrame.recoveryTeams, detail.scenario) : undefined,
  }
}
