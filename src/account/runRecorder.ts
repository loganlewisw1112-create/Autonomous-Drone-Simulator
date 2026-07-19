import { useDroneStore } from '@/store/droneStore'
import { useAuthStore } from '@/store/authStore'
import { encryptJson, makeId } from '@/account/crypto'
import { putRun } from '@/account/accountDb'
import { verifyChain } from '@/utils/chainOfCustody'
import type { MissionReplaySession } from '@/types'
import type { RunRecord, StoredRunSummary } from '@/account/types'

// Auto-captures every finalized mission into the signed-in profile. Subscribes
// to the store's replaySession (set once by finalizeReplaySession on stop);
// a trimmed summary is encrypted with the session key and persisted. Signed-out
// runs are simply not recorded — nothing else in the pipeline changes.

export function buildRunSummary(session: MissionReplaySession): StoredRunSummary {
  const lastFrame = session.frames[session.frames.length - 1]
  return {
    scenarioId: session.scenarioId,
    scenarioVariant: session.scenarioVariant,
    completedAt: session.completedAt,
    durationSec: lastFrame?.elapsedSec ?? 0,
    metrics: session.metrics,
    eventCount: session.events.length,
    firstHash: session.events[0]?.hash ?? null,
    lastHash: session.events[session.events.length - 1]?.hash ?? null,
    chainVerified: verifyChain(session.events),
    droneOutcomes: session.finalDrones.map((d) => ({
      id: d.id,
      missionState: d.missionState,
      batteryPct: Math.round(d.batteryPct),
    })),
  }
}

export async function recordRun(session: MissionReplaySession): Promise<boolean> {
  const { activeAccount, sessionKey } = useAuthStore.getState()
  if (!activeAccount || !sessionKey) return false
  const summary = buildRunSummary(session)
  const record: RunRecord = {
    schemaVersion: 1,
    id: makeId(),
    accountId: activeAccount.id,
    completedAt: summary.completedAt,
    blob: encryptJson(sessionKey, summary),
  }
  return putRun(record)
}

let initialized = false

export function initRunRecorder(): void {
  if (initialized) return
  initialized = true
  useDroneStore.subscribe(
    (s) => s.replaySession,
    (session, prev) => {
      if (session && session !== prev) void recordRun(session)
    },
  )
}
