import {
  listClassrooms,
  listClassroomSessions,
  putClassroom,
  putClassroomSession,
} from '@/account/accountDb'
import type { ClassroomSyncEnvelope } from '@/account/classroomTypes'

/**
 * Local-only sync port. Round-trips ciphertext envelopes so a future cloud
 * adapter can swap transport without changing classroom UX or decrypting off-device.
 */
export async function exportClassroomSync(accountId: string): Promise<ClassroomSyncEnvelope | null> {
  const classrooms = await listClassrooms(accountId)
  const sessions = await listClassroomSessions(accountId)
  if (classrooms.length === 0 && sessions.length === 0) {
    return {
      kind: 'drone-sim-classroom-sync',
      schemaVersion: 1,
      exportedAt: Date.now(),
      accountId,
      classrooms: [],
      sessions: [],
    }
  }
  return {
    kind: 'drone-sim-classroom-sync',
    schemaVersion: 1,
    exportedAt: Date.now(),
    accountId,
    classrooms: classrooms.filter((c) => c.accountId === accountId),
    sessions: sessions.filter((s) => s.accountId === accountId),
  }
}

export async function importClassroomSync(
  envelope: ClassroomSyncEnvelope,
  expectedAccountId: string,
): Promise<{ ok: true; classrooms: number; sessions: number } | { ok: false; reason: string }> {
  if (envelope.kind !== 'drone-sim-classroom-sync' || envelope.schemaVersion !== 1) {
    return { ok: false, reason: 'Unsupported classroom sync envelope' }
  }
  if (envelope.accountId !== expectedAccountId) {
    return { ok: false, reason: 'Sync envelope belongs to a different account' }
  }
  let classrooms = 0
  let sessions = 0
  for (const row of envelope.classrooms) {
    if (row.accountId !== expectedAccountId) continue
    if (await putClassroom(row)) classrooms += 1
  }
  for (const row of envelope.sessions) {
    if (row.accountId !== expectedAccountId) continue
    if (await putClassroomSession(row)) sessions += 1
  }
  return { ok: true, classrooms, sessions }
}

export function isClassroomSyncEnvelope(value: unknown): value is ClassroomSyncEnvelope {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<ClassroomSyncEnvelope>
  return e.kind === 'drone-sim-classroom-sync'
    && e.schemaVersion === 1
    && typeof e.accountId === 'string'
    && Array.isArray(e.classrooms)
    && Array.isArray(e.sessions)
}
