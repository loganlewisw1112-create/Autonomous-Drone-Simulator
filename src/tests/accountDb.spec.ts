import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  accountStorageAvailable, putAccount, getAccountByUsername, listAccounts, deleteAccount,
  putRun, listRuns, clearRuns, exportBackup, importBackup,
} from '@/account/accountDb'
import type { AccountRecord, RunRecord } from '@/account/types'

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 'acct-1',
    username: overrides.username ?? 'Logan',
    usernameLower: (overrides.username ?? 'Logan').toLowerCase(),
    displayName: overrides.displayName ?? 'Logan',
    createdAt: overrides.createdAt ?? Date.now(),
    kdfParams: { kdf: 'pbkdf2-sha256', iterations: 1000, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' },
    checkBlob: { iv: 'aXZpdml2aXZpdml2', ct: 'Y3RjdGN0Y3RjdGN0Y3RjdA==' },
    ...overrides,
  }
}

function makeRun(id: string, accountId: string, completedAt: number): RunRecord {
  return {
    schemaVersion: 1, id, accountId, completedAt,
    blob: { iv: 'aXZpdml2aXZpdml2', ct: 'Y3RjdGN0Y3RjdGN0Y3RjdA==' },
  }
}

beforeEach(() => {
  // Fresh in-memory IDB per test
  globalThis.indexedDB = new IDBFactory()
})

describe('accountDb', () => {
  it('reports storage availability', () => {
    expect(accountStorageAvailable()).toBe(true)
  })

  it('creates and fetches accounts case-insensitively', async () => {
    expect(await putAccount(makeAccount())).toBe(true)
    const fetched = await getAccountByUsername('  LOGAN ')
    expect(fetched?.id).toBe('acct-1')
    expect(await getAccountByUsername('nobody')).toBeNull()
  })

  it('lists accounts sorted by creation time', async () => {
    await putAccount(makeAccount({ id: 'b', username: 'Beta', createdAt: 200 }))
    await putAccount(makeAccount({ id: 'a', username: 'Alpha', createdAt: 100 }))
    const all = await listAccounts()
    expect(all.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('stores runs per account, ordered by completedAt', async () => {
    await putRun(makeRun('r2', 'acct-1', 2000))
    await putRun(makeRun('r1', 'acct-1', 1000))
    await putRun(makeRun('rx', 'acct-other', 1500))
    const runs = await listRuns('acct-1')
    expect(runs.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('clearRuns removes only that account’s runs', async () => {
    await putRun(makeRun('r1', 'acct-1', 1000))
    await putRun(makeRun('rx', 'acct-other', 1500))
    await clearRuns('acct-1')
    expect(await listRuns('acct-1')).toHaveLength(0)
    expect(await listRuns('acct-other')).toHaveLength(1)
  })

  it('deleteAccount cascades to its runs', async () => {
    await putAccount(makeAccount())
    await putRun(makeRun('r1', 'acct-1', 1000))
    await deleteAccount('acct-1')
    expect(await getAccountByUsername('logan')).toBeNull()
    expect(await listRuns('acct-1')).toHaveLength(0)
  })

  it('backup export/import round-trips account + runs', async () => {
    await putAccount(makeAccount())
    await putRun(makeRun('r1', 'acct-1', 1000))
    const envelope = await exportBackup('acct-1')
    expect(envelope?.kind).toBe('drone-sim-backup')
    expect(envelope?.runs).toHaveLength(1)

    globalThis.indexedDB = new IDBFactory() // simulate a wiped device
    const result = await importBackup(envelope)
    expect(result.ok).toBe(true)
    expect((await getAccountByUsername('logan'))?.id).toBe('acct-1')
    expect(await listRuns('acct-1')).toHaveLength(1)
  })

  it('rejects malformed backup envelopes', async () => {
    expect((await importBackup(null)).ok).toBe(false)
    expect((await importBackup({ kind: 'other' })).ok).toBe(false)
    expect((await importBackup({ kind: 'drone-sim-backup', schemaVersion: 1, account: { bogus: true } })).ok).toBe(false)
  })
})
