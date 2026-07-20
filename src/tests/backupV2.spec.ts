import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  putAccount, putRun, putRunDetail, putMission,
  exportBackup, importBackup,
  getAccountByUsername, listRuns, listRunDetails, listMissions, deleteRun, clearRuns,
} from '@/account/accountDb'
import { MAX_CUSTOM_MISSIONS } from '@/account/types'
import type {
  AccountRecord, RunRecord, RunRecordV2, CustomMissionRecord, BackupEnvelope,
} from '@/account/types'

// Backup v2 carries account + runs + runDetails + missions. Legacy v1 envelopes
// still import (runs only); a schemaVersion the app doesn't understand is
// rejected with a clear "newer" message; and any malformed envelope is rejected
// up-front so a bad import never leaves a partial write behind.

const DUMMY_BLOB = { iv: 'aXZpdml2aXZpdml2', ct: 'Y3RjdGN0Y3RjdGN0Y3RjdA==' }

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 'acct-1',
    username: overrides.username ?? 'Logan',
    usernameLower: (overrides.username ?? 'Logan').toLowerCase(),
    displayName: overrides.displayName ?? 'Logan',
    createdAt: overrides.createdAt ?? 1000,
    kdfParams: { kdf: 'pbkdf2-sha256', iterations: 1000, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' },
    checkBlob: DUMMY_BLOB,
    ...overrides,
  }
}

function makeRun(id: string, accountId: string, completedAt: number): RunRecord {
  return { schemaVersion: 1, id, accountId, completedAt, blob: DUMMY_BLOB }
}

function makeDetail(id: string, accountId: string, completedAt: number): RunRecordV2 {
  return { schemaVersion: 2, id, accountId, completedAt, blob: DUMMY_BLOB }
}

function makeMission(id: string, accountId: string, updatedAt: number): CustomMissionRecord {
  return { schemaVersion: 2, id, accountId, updatedAt, blob: DUMMY_BLOB }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('backup v2', () => {
  it('cascades individual and account-wide run deletion to immutable details', async () => {
    await putRun(makeRun('r1', 'acct-1', 1000))
    await putRunDetail(makeDetail('r1', 'acct-1', 1000))
    await putRun(makeRun('r2', 'acct-1', 2000))
    await putRunDetail(makeDetail('r2', 'acct-1', 2000))

    expect(await deleteRun('r1')).toBe(true)
    expect((await listRuns('acct-1')).map((run) => run.id)).toEqual(['r2'])
    expect((await listRunDetails('acct-1')).map((detail) => detail.id)).toEqual(['r2'])

    expect(await clearRuns('acct-1')).toBe(true)
    expect(await listRuns('acct-1')).toHaveLength(0)
    expect(await listRunDetails('acct-1')).toHaveLength(0)
  })

  it('imports a legacy v1 envelope (runs only)', async () => {
    const v1: BackupEnvelope = {
      kind: 'drone-sim-backup',
      schemaVersion: 1,
      exportedAt: Date.now(),
      account: makeAccount(),
      runs: [makeRun('r1', 'acct-1', 1000)],
    }
    const result = await importBackup(v1)
    expect(result.ok).toBe(true)
    expect((await getAccountByUsername('logan'))?.id).toBe('acct-1')
    expect(await listRuns('acct-1')).toHaveLength(1)
    // v1 has no v2 stores; nothing lands there.
    expect(await listRunDetails('acct-1')).toHaveLength(0)
    expect(await listMissions('acct-1')).toHaveLength(0)
  })

  it('exports v2 and round-trips runs + runDetails + missions', async () => {
    await putAccount(makeAccount())
    await putRun(makeRun('r1', 'acct-1', 1000))
    await putRunDetail(makeDetail('r1', 'acct-1', 1000))
    await putMission(makeMission('m1', 'acct-1', 1000))

    const envelope = await exportBackup('acct-1')
    expect(envelope?.schemaVersion).toBe(2)
    expect(envelope?.runs).toHaveLength(1)
    expect(envelope?.runDetails).toHaveLength(1)
    expect(envelope?.missions).toHaveLength(1)

    globalThis.indexedDB = new IDBFactory() // simulate a wiped device
    const result = await importBackup(envelope)
    expect(result.ok).toBe(true)
    expect((await getAccountByUsername('logan'))?.id).toBe('acct-1')
    expect(await listRuns('acct-1')).toHaveLength(1)
    expect(await listRunDetails('acct-1')).toHaveLength(1)
    expect(await listMissions('acct-1')).toHaveLength(1)
  })

  it('rejects a newer schemaVersion with a clear message', async () => {
    const result = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 3,
      account: makeAccount(),
      runs: [],
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/newer/i)
  })

  it('rejects an invalid account record with no partial writes', async () => {
    const result = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 2,
      account: { bogus: true },
      runs: [makeRun('r1', 'acct-1', 1000)],
      runDetails: [],
      missions: [],
    })
    expect(result.ok).toBe(false)
    // Validation happens before any store is touched.
    expect(await getAccountByUsername('logan')).toBeNull()
    expect(await listRuns('acct-1')).toHaveLength(0)
  })

  it('rejects malformed or cross-account rows instead of silently filtering them', async () => {
    const malformed = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 2,
      exportedAt: Date.now(),
      account: makeAccount(),
      runs: [makeRun('r1', 'acct-1', 1000), { bogus: true }],
      runDetails: [],
      missions: [],
    })
    expect(malformed.ok).toBe(false)
    expect(await getAccountByUsername('logan')).toBeNull()

    const crossAccount = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 2,
      exportedAt: Date.now(),
      account: makeAccount(),
      runs: [makeRun('r1', 'different-account', 1000)],
      runDetails: [],
      missions: [],
    })
    expect(crossAccount.ok).toBe(false)
    expect(crossAccount.reason).toMatch(/another account/i)
    expect(await getAccountByUsername('logan')).toBeNull()
  })

  it('rejects a mission list over the cap with no partial writes', async () => {
    const tooMany = Array.from(
      { length: MAX_CUSTOM_MISSIONS + 1 },
      (_, i) => makeMission(`m${i}`, 'acct-1', 1000 + i),
    )
    const result = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 2,
      exportedAt: Date.now(),
      account: makeAccount(),
      runs: [makeRun('r1', 'acct-1', 1000)],
      runDetails: [],
      missions: tooMany,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/limit/i)
    // The over-cap check runs before the transaction opens — nothing persisted.
    expect(await getAccountByUsername('logan')).toBeNull()
    expect(await listRuns('acct-1')).toHaveLength(0)
    expect(await listMissions('acct-1')).toHaveLength(0)
  })

  it('enforces the mission cap against existing rows inside the restore transaction', async () => {
    await putAccount(makeAccount())
    for (let i = 0; i < MAX_CUSTOM_MISSIONS; i++) {
      expect((await putMission(makeMission(`existing-${i}`, 'acct-1', 1000 + i))).ok).toBe(true)
    }

    const result = await importBackup({
      kind: 'drone-sim-backup',
      schemaVersion: 2,
      exportedAt: Date.now(),
      account: makeAccount(),
      runs: [makeRun('new-run', 'acct-1', 2000)],
      runDetails: [],
      missions: [makeMission('sixth', 'acct-1', 2000)],
    })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/limit/i)
    expect(await listMissions('acct-1')).toHaveLength(MAX_CUSTOM_MISSIONS)
    expect(await listRuns('acct-1')).toHaveLength(0)
  })
})
