import type { CipherBlob, StoredRunSummary } from '@/account/types'

/**
 * Classroom persistence types live under `src/account/` so IndexedDB can store them
 * without importing `src/classroom/` (bundle isolation for Mobile/Windows).
 * Structurally mirrors classroom protocol / assessment shapes.
 */

/** Durable classroom owned by an instructor account (not the live 6-char class code). */
export interface ClassroomMeta {
  classroomId: string
  name: string
  createdAt: number
  lastOpenedAt: number
  defaultScenarioId?: string
}

/** IndexedDB row: encrypted ClassroomMeta under the instructor account key. */
export interface ClassroomRecord {
  schemaVersion: 1
  id: string
  accountId: string
  updatedAt: number
  blob: CipherBlob
}

/** Slim assessment snapshot for archives (compatible with MissionAssessment fields we persist). */
export interface ArchivedAssessment {
  total: number
  band: string
  progressPercent: number
  lifeSafety: { status: string }
  nistLane?: { score: number; featuresRejectedLate?: number } | null
  [key: string]: unknown
}

/** Opaque mission assignment — same JSON shape as classroom ClassConfig. */
export type ClassroomConfigSnapshot = Record<string, unknown>

export interface StudentSessionArchiveEntry {
  studentId: string
  accountId?: string
  displayName: string
  joinedAt: number
  leftAt?: number
  incomplete: boolean
  summary?: StoredRunSummary
  assessment?: ArchivedAssessment
  /** Last known progress from grid when no full run arrived. */
  progressPercent?: number
  interventionCount: number
}

/** Plaintext session archive (encrypted before IndexedDB write). */
export interface ClassroomSessionArchive {
  sessionId: string
  classroomId: string
  classId: string
  instructorAccountId: string
  startedAt: number
  endedAt: number
  config: ClassroomConfigSnapshot
  students: StudentSessionArchiveEntry[]
}

/** IndexedDB row: encrypted ClassroomSessionArchive. */
export interface ClassroomSessionRecord {
  schemaVersion: 1
  id: string
  accountId: string
  classroomId: string
  classId: string
  endedAt: number
  blob: CipherBlob
}

/**
 * Cloud-sync seam: export ciphertext as-is. A future adapter uploads/downloads
 * these envelopes without changing classroom UX or decrypting server-side.
 */
export interface ClassroomSyncEnvelope {
  kind: 'drone-sim-classroom-sync'
  schemaVersion: 1
  exportedAt: number
  accountId: string
  classrooms: ClassroomRecord[]
  sessions: ClassroomSessionRecord[]
}

export type AnyClassroomSyncEnvelope = ClassroomSyncEnvelope
