// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { deriveKey, makeCheckBlob, makeKdfParams, makeId } from '@/account/crypto'
import { putAccount } from '@/account/accountDb'
import {
  buildSessionArchive,
  createClassroom,
  listDecryptedClassrooms,
  listDecryptedSessionsForClassroom,
  persistSessionArchive,
} from '@/account/classroomArchive'
import { exportClassroomSync, importClassroomSync } from '@/account/syncPort'
import type { AccountRecord } from '@/account/types'
import type { ClassConfig } from '@/classroom/protocol'

const PASSWORD = 'password123'

async function makeInstructor(username = 'teach'): Promise<{ accountId: string; key: Uint8Array }> {
  const kdfParams = makeKdfParams()
  const key = deriveKey(PASSWORD, kdfParams)
  const accountId = makeId()
  const record: AccountRecord = {
    schemaVersion: 1,
    id: accountId,
    username,
    usernameLower: username.toLowerCase(),
    displayName: 'Teacher',
    createdAt: Date.now(),
    kdfParams,
    checkBlob: makeCheckBlob(key),
    role: 'instructor',
  }
  await putAccount(record)
  return { accountId, key }
}

const config: ClassConfig = {
  kind: 'catalog',
  scenarioId: 'demo_sar_coastal',
  variant: {
    seed: 1, timeOfDay: 'day', season: 'summer',
    weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  },
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('classroom archive + sync seam', () => {
  it('creates classrooms and persists an encrypted session archive', async () => {
    const { accountId, key } = await makeInstructor()
    const meta = await createClassroom(accountId, key, 'SAR Cohort')
    expect(meta?.name).toBe('SAR Cohort')

    const list = await listDecryptedClassrooms(accountId, key)
    expect(list).toHaveLength(1)

    const archive = buildSessionArchive({
      classroomId: meta!.classroomId,
      classId: 'B1WN5C',
      instructorAccountId: accountId,
      startedAt: Date.now() - 60_000,
      config,
      roster: [{
        studentId: 'abc12345',
        displayName: 'Alex',
        joinedAt: Date.now() - 50_000,
        studentPubKey: 'dGVzdA==',
        accountId: 'stu-1',
      }],
      runs: [],
      frames: {},
      commandCountsByStudent: {},
    })
    expect(archive.students).toHaveLength(1)
    expect(archive.students[0].incomplete).toBe(true)

    const sessionId = await persistSessionArchive(accountId, key, archive)
    expect(sessionId).toBeTruthy()

    const sessions = await listDecryptedSessionsForClassroom(accountId, key, meta!.classroomId)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].classId).toBe('B1WN5C')
    expect(sessions[0].students[0].displayName).toBe('Alex')
  }, 30000)

  it('exports and re-imports ciphertext sync envelopes for the same account', async () => {
    const { accountId, key } = await makeInstructor()
    await createClassroom(accountId, key, 'Export Me')
    const envelope = await exportClassroomSync(accountId)
    expect(envelope?.kind).toBe('drone-sim-classroom-sync')
    expect(envelope?.classrooms).toHaveLength(1)

    const other = await makeInstructor('other')
    const rejected = await importClassroomSync(envelope!, other.accountId)
    expect(rejected.ok).toBe(false)

    // Wipe stores by new IDB factory, recreate same account id, import blobs
    globalThis.indexedDB = new IDBFactory()
    const kdfParams = makeKdfParams()
    const key2 = deriveKey(PASSWORD, kdfParams)
    await putAccount({
      schemaVersion: 1,
      id: accountId,
      username: 'teach',
      usernameLower: 'teach',
      displayName: 'Teacher',
      createdAt: Date.now(),
      kdfParams,
      checkBlob: makeCheckBlob(key2),
      role: 'instructor',
    })
    const imported = await importClassroomSync(envelope!, accountId)
    expect(imported).toEqual({ ok: true, classrooms: 1, sessions: 0 })
    // Original export key still opens the ciphertext (password-derived keys differ by salt,
    // but the blob was encrypted with `key` — so decrypt with key2 fails; with original key works).
    expect(await listDecryptedClassrooms(accountId, key2)).toHaveLength(0)
    expect(await listDecryptedClassrooms(accountId, key)).toHaveLength(1)
  }, 30000)
})
