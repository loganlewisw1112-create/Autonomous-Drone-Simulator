import { useDroneStore } from '@/store/droneStore'
import { useAuthStore } from '@/store/authStore'
import { encryptJson, makeId } from '@/account/crypto'
import { putRunBundle } from '@/account/accountDb'
import { getClassroomRunTag } from '@/account/runContext'
import { buildAfterActionPackage } from '@/sim/demo/missionReport'
import { verifyChain } from '@/utils/chainOfCustody'
import type { EventType, FullMissionFrame, LatLng, MissionEvent, MissionReplaySession, ScenarioConfig, TelemetryPoint, Waypoint } from '@/types'
import type {
  RunRecord,
  RunRecordV2,
  StoredRunDetailEvidence,
  StoredRunDetailReplayCoverage,
  StoredRunDetailV2,
  StoredRunSummary,
} from '@/account/types'

// Auto-captures every finalized mission into the signed-in profile. Subscribes
// to the store's replaySession (set once by finalizeReplaySession on stop);
// a trimmed summary is encrypted with the session key and persisted, alongside
// an immutable v2 detail row (full drill-down snapshot) written under the same
// id. Signed-out runs are simply not recorded — nothing else in the pipeline
// changes.

// The v2 detail can be large, so its replay track is downsampled to at most this
// many frames (first + last always kept) before encryption. The live buffer is
// already bounded to 300 frames, so this only bites on a longer future window.
const MAX_DETAIL_FRAMES = 300

export function buildRunSummary(session: MissionReplaySession): StoredRunSummary {
  const lastFrame = session.frames[session.frames.length - 1]
  const tag = getClassroomRunTag()
  return {
    scenarioId: session.scenarioId,
    scenarioVariant: session.scenarioVariant,
    completedAt: session.completedAt,
    completionReason: session.completionReason,
    durationSec: lastFrame?.elapsedSec ?? 0,
    metrics: session.metrics,
    eventCount: session.events.length,
    firstHash: session.events[0]?.hash ?? null,
    lastHash: session.events[session.events.length - 1]?.hash ?? null,
    chainVerified: session.events.length > 0 && verifyChain(session.events),
    droneOutcomes: session.finalDrones.map((d) => ({
      id: d.id,
      missionState: d.missionState,
      batteryPct: Math.round(d.batteryPct),
      platformId: d.platformId,
    })),
    eventTypeCounts: countEventTypes(session.events),
    ...(tag ? { source: 'classroom' as const, classId: tag.classId, classroomId: tag.classroomId } : {}),
  }
}

/**
 * Reduces a session's events to per-type totals. Done once at record time so the
 * analytics panel can chart event mix from summaries alone, without decrypting
 * every run's detail blob.
 */
function countEventTypes(events: MissionEvent[]): Partial<Record<EventType, number>> {
  const counts: Partial<Record<EventType, number>> = {}
  for (const event of events) {
    counts[event.eventType] = (counts[event.eventType] ?? 0) + 1
  }
  return counts
}

// Live-store fields the detail needs that the session doesn't carry: the full
// scenario config, operator-edited routes, and the position / telemetry buffers.
interface RunDetailStoreSnapshot {
  droneWaypoints: Record<string, Waypoint[]>
  positionHistory: Record<string, LatLng[]>
  telemetryHistory: Record<string, TelemetryPoint[]>
}

// Evenly downsample to `cap` frames, always retaining the first and last so the
// track's endpoints (launch + recovery) survive.
function downsampleFrames(frames: FullMissionFrame[], cap: number): FullMissionFrame[] {
  if (frames.length <= cap) return frames
  const out: FullMissionFrame[] = [frames[0]]
  const step = (frames.length - 1) / (cap - 1)
  for (let i = 1; i < cap - 1; i++) out.push(frames[Math.round(i * step)])
  out.push(frames[frames.length - 1])
  return out
}

export function buildRunDetail(
  session: MissionReplaySession,
  scenario: ScenarioConfig,
  store: RunDetailStoreSnapshot,
): StoredRunDetailV2 {
  const frames = session.frames
  const lastFrame = frames[frames.length - 1]
  const durationSec = lastFrame?.elapsedSec ?? 0

  const evidence: StoredRunDetailEvidence = {
    eventCount: session.events.length,
    firstHash: session.events[0]?.hash ?? null,
    lastHash: session.events[session.events.length - 1]?.hash ?? null,
    verified: session.events.length > 0 && verifyChain(session.events),
  }
  const replayCoverage: StoredRunDetailReplayCoverage = {
    startSec: frames[0]?.elapsedSec ?? 0,
    endSec: durationSec,
    // The rolling buffer keeps only the last N frames; a non-zero first tick
    // means earlier frames were dropped by that bounded window.
    truncated: frames.length > 0 && frames[0].tick > 0,
  }
  const report = buildAfterActionPackage({
    scenario,
    scenarioVariant: session.scenarioVariant,
    drones: session.finalDrones,
    metrics: session.metrics,
    thermalContacts: session.finalThermalContacts,
    events: session.events,
    elapsedSec: durationSec,
    replayFrameCount: frames.length,
    positionHistory: store.positionHistory,
    replaySession: session,
  })

  return {
    scenario,
    scenarioVariant: session.scenarioVariant,
    launchPlan: session.launchPlan,
    routes: store.droneWaypoints,
    finalDrones: session.finalDrones,
    events: session.events,
    evidence,
    report,
    replayFrames: downsampleFrames(frames, MAX_DETAIL_FRAMES),
    replayCoverage,
    positionHistory: store.positionHistory,
    telemetryHistory: store.telemetryHistory,
  }
}

export async function recordRun(session: MissionReplaySession): Promise<boolean> {
  const { activeAccount, sessionKey } = useAuthStore.getState()
  if (!activeAccount || !sessionKey) return false

  // Snapshot the live store SYNCHRONOUSLY (before the first await): the scenario,
  // routes, and history buffers the detail needs live here, not on the session,
  // and a later reset/browse must not race in under us.
  const store = useDroneStore.getState()

  const summary = buildRunSummary(session)
  const id = makeId()

  // The immutable detail is best-effort. Summary + detail use one transaction so
  // a failed summary cannot leave an orphan detail. A quota rejection retries with
  // the compact summary only; any other detail failure is marked unavailable.
  let detailRecord: RunRecordV2 | null = null
  let detailState: StoredRunSummary['detailState'] = 'unavailable'
  if (store.scenario) {
    try {
      const detail = buildRunDetail(session, store.scenario, store)
      detailRecord = {
        schemaVersion: 2,
        id,
        accountId: activeAccount.id,
        completedAt: summary.completedAt,
        blob: encryptJson(sessionKey, detail),
      }
      // Optional, guarded headroom pre-check: skip the heavy write when the
      // Storage Manager reports there isn't room (absent in jsdom / private mode,
      // where it simply proceeds and relies on the transaction's quota handling).
      const roomOk = await hasRoomFor(detailRecord.blob.ct.length)
      if (!roomOk) {
        detailRecord = null
        detailState = 'quota-limited'
      }
    } catch {
      detailRecord = null
      detailState = 'unavailable'
    }
  }

  summary.detailState = detailRecord ? 'saved' : detailState
  let record: RunRecord = {
    schemaVersion: 1,
    id,
    accountId: activeAccount.id,
    completedAt: summary.completedAt,
    blob: encryptJson(sessionKey, summary),
  }

  if (detailRecord) {
    const result = await putRunBundle(record, detailRecord)
    if (result.ok) return true

    // Retry only the compact row. A quota error is explicitly distinguished for
    // the UI; another detail-store failure remains a generic unavailable detail.
    summary.detailState = 'quota' in result && result.quota ? 'quota-limited' : 'unavailable'
    record = { ...record, blob: encryptJson(sessionKey, summary) }
  }

  return (await putRunBundle(record, null)).ok
}

// True unless the Storage Manager can prove there's no headroom for `bytes` more.
// Any absence/error resolves optimistically — the authoritative guard is the
// QuotaExceededError path inside putRunDetail.
async function hasRoomFor(bytes: number): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage || typeof storage.estimate !== 'function') return true
    const { quota, usage } = await storage.estimate()
    if (typeof quota !== 'number' || typeof usage !== 'number') return true
    return quota - usage > bytes
  } catch {
    return true
  }
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
