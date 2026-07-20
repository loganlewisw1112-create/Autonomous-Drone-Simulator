import type {
  AfterActionPackage,
  CustomMissionDefinition,
  DroneState,
  FullMissionFrame,
  LatLng,
  LaunchBayPlan,
  MissionCompletionReason,
  MissionEvent,
  MissionMetrics,
  ScenarioConfig,
  ScenarioVariantConfig,
  TelemetryPoint,
  Waypoint,
} from '@/types'

// ─── On-device account records (IndexedDB `drone-sim-accounts`) ───────────────
// Nothing password-derived is ever stored in plaintext. The check blob is a
// fixed marker encrypted with the account key: a successful AES-GCM decrypt
// proves the password; an auth-tag failure means wrong password.

export interface KdfParams {
  kdf: 'pbkdf2-sha256'
  iterations: number
  salt: string          // base64
}

export interface CipherBlob {
  iv: string            // base64, 12-byte AES-GCM nonce, unique per record
  ct: string            // base64 ciphertext (includes GCM auth tag)
}

export interface AccountRecord {
  schemaVersion: 1
  id: string
  username: string
  usernameLower: string
  displayName: string
  createdAt: number
  kdfParams: KdfParams
  checkBlob: CipherBlob
  prefsBlob?: CipherBlob   // encrypted AccountPrefs
}

export interface AccountPrefs {
  defaultScenarioId?: string
  defaultSimSpeed?: 1 | 5 | 10
}

// Trimmed, encrypted per-run summary (~2-4 KB). Full 300-frame sessions stay
// in memory and export via the ControlBar downloads; profiles keep the compact
// evidence-grade digest for analytics.
export interface StoredRunSummary {
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  completedAt: number
  // Absent on runs recorded before this field existed — treat as unknown, not an error.
  completionReason?: MissionCompletionReason
  durationSec: number
  metrics: MissionMetrics
  eventCount: number
  firstHash: string | null
  lastHash: string | null
  chainVerified: boolean
  droneOutcomes: Array<{
    id: string
    missionState: string
    batteryPct: number
  }>
  // Additive: whether the immutable drill-down detail (runDetails row) persisted
  // alongside this summary. 'quota-limited' means the device rejected the heavier
  // detail write — the summary is intact and the UI can badge the missing detail.
  detailState?: 'saved' | 'quota-limited' | 'unavailable'
}

export interface RunRecord {
  schemaVersion: 1
  id: string
  accountId: string
  completedAt: number
  blob: CipherBlob      // encrypted StoredRunSummary
}

// Backup envelope: account record + encrypted runs, exported as-is. Import
// requires the same password — the blobs are never re-keyed on export.
export interface BackupEnvelope {
  kind: 'drone-sim-backup'
  schemaVersion: 1
  exportedAt: number
  account: AccountRecord
  runs: RunRecord[]
}

// ─── v2: immutable run detail (drill-down), custom missions, backup ─────────────
// The full, immutable snapshot behind a saved run — everything the drill-down
// detail tabs and rebuilt exports need, isolated from the live simulator. Stored
// in the `runDetails` object store, encrypted per-account, keyed by the same id
// as its `runs` summary. A run with no detail row renders as "Legacy summary only".
export interface StoredRunDetailEvidence {
  eventCount: number
  firstHash: string | null
  lastHash: string | null
  verified: boolean          // recomputed at record time; the detail view re-verifies live
}

export interface StoredRunDetailReplayCoverage {
  startSec: number
  endSec: number
  truncated: boolean         // true when early frames were dropped by the bounded window
}

export interface StoredRunDetailV2 {
  scenario: ScenarioConfig
  scenarioVariant: ScenarioVariantConfig
  launchPlan: LaunchBayPlan | null
  routes: Record<string, Waypoint[]>
  finalDrones: DroneState[]
  events: MissionEvent[]
  evidence: StoredRunDetailEvidence
  report: AfterActionPackage
  replayFrames: FullMissionFrame[]
  replayCoverage: StoredRunDetailReplayCoverage
  positionHistory: Record<string, LatLng[]>
  telemetryHistory: Record<string, TelemetryPoint[]>
  quotaLimited?: boolean     // true when the detail was dropped/trimmed to fit storage quota
}

export interface RunRecordV2 {
  schemaVersion: 2
  id: string                 // matches the RunRecord (summary) id
  accountId: string
  completedAt: number
  blob: CipherBlob           // encrypted StoredRunDetailV2
}

export interface CustomMissionRecord {
  schemaVersion: 2
  id: string
  accountId: string
  updatedAt: number
  blob: CipherBlob           // encrypted CustomMissionDefinition
}

export type { CustomMissionDefinition }

// Backup v2: everything account-owned. v1 envelopes still import (runs only).
export interface BackupEnvelopeV2 {
  kind: 'drone-sim-backup'
  schemaVersion: 2
  exportedAt: number
  account: AccountRecord
  runs: RunRecord[]
  runDetails: RunRecordV2[]
  missions: CustomMissionRecord[]
}

export type AnyBackupEnvelope = BackupEnvelope | BackupEnvelopeV2

export const MAX_CUSTOM_MISSIONS = 5

export const CHECK_MARKER = 'drone-sim-check-v1'
export const PBKDF2_ITERATIONS = 310_000
