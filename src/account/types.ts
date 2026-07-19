import type { MissionMetrics, ScenarioVariantConfig } from '@/types'

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

export const CHECK_MARKER = 'drone-sim-check-v1'
export const PBKDF2_ITERATIONS = 310_000
