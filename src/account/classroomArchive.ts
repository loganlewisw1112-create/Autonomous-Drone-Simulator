import { decryptJson, encryptJson, makeId } from '@/account/crypto'
import {
  getClassroom,
  listClassrooms,
  listClassroomSessions,
  listClassroomSessionsForClassroom,
  putClassroom,
  putClassroomSession,
} from '@/account/accountDb'
import type {
  ClassroomMeta,
  ClassroomRecord,
  ClassroomSessionArchive,
  ClassroomSessionRecord,
  StudentSessionArchiveEntry,
} from '@/account/classroomTypes'
import type { ClassConfig, ClassId, RosterEntry, StudentId } from '@/classroom/protocol'
import type { ClassRunResult } from '@/classroom/classroomStore'
import type { GridFrame } from '@/classroom/gridFrame'

export function decryptClassroomMeta(key: Uint8Array, record: ClassroomRecord): ClassroomMeta | null {
  try {
    return decryptJson<ClassroomMeta>(key, record.blob)
  } catch {
    return null
  }
}

export function decryptSessionArchive(key: Uint8Array, record: ClassroomSessionRecord): ClassroomSessionArchive | null {
  try {
    return decryptJson<ClassroomSessionArchive>(key, record.blob)
  } catch {
    return null
  }
}

export async function createClassroom(
  accountId: string,
  key: Uint8Array,
  name: string,
  defaultScenarioId?: string,
): Promise<ClassroomMeta | null> {
  const now = Date.now()
  const meta: ClassroomMeta = {
    classroomId: makeId(),
    name: name.trim() || 'Untitled class',
    createdAt: now,
    lastOpenedAt: now,
    defaultScenarioId,
  }
  const record: ClassroomRecord = {
    schemaVersion: 1,
    id: meta.classroomId,
    accountId,
    updatedAt: now,
    blob: encryptJson(key, meta),
  }
  const ok = await putClassroom(record)
  return ok ? meta : null
}

export async function touchClassroomOpened(
  accountId: string,
  key: Uint8Array,
  classroomId: string,
): Promise<ClassroomMeta | null> {
  const row = await getClassroom(classroomId)
  if (!row || row.accountId !== accountId) return null
  const meta = decryptClassroomMeta(key, row)
  if (!meta) return null
  meta.lastOpenedAt = Date.now()
  const next: ClassroomRecord = {
    ...row,
    updatedAt: meta.lastOpenedAt,
    blob: encryptJson(key, meta),
  }
  const ok = await putClassroom(next)
  return ok ? meta : null
}

export async function listDecryptedClassrooms(
  accountId: string,
  key: Uint8Array,
): Promise<ClassroomMeta[]> {
  const rows = await listClassrooms(accountId)
  const out: ClassroomMeta[] = []
  for (const row of rows) {
    if (row.accountId !== accountId) continue
    const meta = decryptClassroomMeta(key, row)
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
}

export interface ArchiveBuildInput {
  classroomId: string
  classId: ClassId
  instructorAccountId: string
  startedAt: number
  config: ClassConfig
  roster: RosterEntry[]
  runs: ClassRunResult[]
  frames: Record<StudentId, GridFrame>
  commandCountsByStudent: Record<StudentId, number>
  /** Students who already left — last known snapshot retained here. */
  departed?: StudentSessionArchiveEntry[]
}

export function buildSessionArchive(input: ArchiveBuildInput): ClassroomSessionArchive {
  const endedAt = Date.now()
  const runByStudent = new Map(input.runs.map((r) => [r.studentId, r]))
  const departedByStudent = new Map((input.departed ?? []).map((d) => [d.studentId, d]))
  const seen = new Set<string>()
  const students: StudentSessionArchiveEntry[] = []

  for (const entry of input.roster) {
    seen.add(entry.studentId)
    students.push(studentEntryFromLive(entry, runByStudent.get(entry.studentId), input.frames[entry.studentId], input.commandCountsByStudent[entry.studentId] ?? 0))
  }
  for (const [studentId, departed] of departedByStudent) {
    if (seen.has(studentId)) continue
    students.push(departed)
  }
  for (const run of input.runs) {
    if (seen.has(run.studentId) || departedByStudent.has(run.studentId)) continue
    students.push({
      studentId: run.studentId,
      accountId: run.accountId,
      displayName: run.displayName,
      joinedAt: run.receivedAt,
      leftAt: run.receivedAt,
      incomplete: Boolean(run.incomplete),
      summary: run.summary,
      assessment: run.assessment as unknown as StudentSessionArchiveEntry['assessment'],
      progressPercent: run.assessment.progressPercent,
      interventionCount: input.commandCountsByStudent[run.studentId] ?? 0,
    })
  }

  return {
    sessionId: makeId(),
    classroomId: input.classroomId,
    classId: input.classId,
    instructorAccountId: input.instructorAccountId,
    startedAt: input.startedAt,
    endedAt,
    config: input.config as ClassroomSessionArchive['config'],
    students,
  }
}

function studentEntryFromLive(
  entry: RosterEntry,
  run: ClassRunResult | undefined,
  frame: GridFrame | undefined,
  interventionCount: number,
): StudentSessionArchiveEntry {
  if (run) {
    return {
      studentId: entry.studentId,
      accountId: run.accountId ?? entry.accountId,
      displayName: run.displayName || entry.displayName,
      joinedAt: entry.joinedAt,
      incomplete: Boolean(run.incomplete),
      summary: run.summary,
      assessment: run.assessment as unknown as StudentSessionArchiveEntry['assessment'],
      progressPercent: run.assessment.progressPercent,
      interventionCount,
    }
  }
  const progressPercent = frame?.p
  return {
    studentId: entry.studentId,
    accountId: entry.accountId,
    displayName: entry.displayName,
    joinedAt: entry.joinedAt,
    leftAt: Date.now(),
    incomplete: true,
    progressPercent,
    interventionCount,
  }
}

export async function persistSessionArchive(
  accountId: string,
  key: Uint8Array,
  archive: ClassroomSessionArchive,
): Promise<string | null> {
  if (archive.instructorAccountId !== accountId) return null
  const record: ClassroomSessionRecord = {
    schemaVersion: 1,
    id: archive.sessionId,
    accountId,
    classroomId: archive.classroomId,
    classId: archive.classId,
    endedAt: archive.endedAt,
    blob: encryptJson(key, archive),
  }
  const ok = await putClassroomSession(record)
  return ok ? archive.sessionId : null
}

export async function listDecryptedSessionsForClassroom(
  accountId: string,
  key: Uint8Array,
  classroomId: string,
): Promise<ClassroomSessionArchive[]> {
  const rows = await listClassroomSessionsForClassroom(classroomId)
  const out: ClassroomSessionArchive[] = []
  for (const row of rows) {
    if (row.accountId !== accountId) continue
    const archive = decryptSessionArchive(key, row)
    if (archive) out.push(archive)
  }
  return out
}

export async function listDecryptedSessions(
  accountId: string,
  key: Uint8Array,
): Promise<ClassroomSessionArchive[]> {
  const rows = await listClassroomSessions(accountId)
  const out: ClassroomSessionArchive[] = []
  for (const row of rows) {
    if (row.accountId !== accountId) continue
    const archive = decryptSessionArchive(key, row)
    if (archive) out.push(archive)
  }
  return out
}

/** Snapshot a departing student for later flush (incomplete unless a finalized run exists). */
export function snapshotDepartedStudent(
  entry: RosterEntry,
  run: ClassRunResult | undefined,
  frame: GridFrame | undefined,
  interventionCount: number,
): StudentSessionArchiveEntry {
  const live = studentEntryFromLive(entry, run, frame, interventionCount)
  const incomplete = !run || Boolean(run.incomplete)
  return { ...live, leftAt: Date.now(), incomplete }
}
