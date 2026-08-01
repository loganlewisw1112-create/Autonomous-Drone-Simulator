// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  getAccountByUsername,
  listMissions,
  listRunDetails,
  listRuns,
  migrateAccountCipherBlobs,
  putAccount,
  putMission,
  putRun,
  putRunDetail,
  setAccountStorageReadOnly,
} from '@/account/accountDb'
import {
  accountCipherAad,
  decryptJson,
  deriveKey,
  encryptLegacyJson,
  makeKdfParams,
} from '@/account/crypto'
import { CHECK_MARKER } from '@/account/types'
import type { AccountRecord } from '@/account/types'

const ACCOUNT_ID = 'legacy-account'

function legacyAccount(key: Uint8Array): AccountRecord {
  return {
    schemaVersion: 1,
    id: ACCOUNT_ID,
    username: 'legacy',
    usernameLower: 'legacy',
    displayName: 'Legacy',
    createdAt: 1000,
    kdfParams: { ...makeKdfParams(), iterations: 1000 },
    checkBlob: encryptLegacyJson(key, { check: CHECK_MARKER }),
    prefsBlob: encryptLegacyJson(key, { defaultSimSpeed: 5 }),
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  setAccountStorageReadOnly(ACCOUNT_ID, false)
})

describe('account ciphertext v2 migration', () => {
  it('atomically binds every legacy store row to its account/type/id', async () => {
    const key = deriveKey('password123', { ...makeKdfParams(), iterations: 1000 })
    await putAccount(legacyAccount(key))
    await putRun({
      schemaVersion: 1,
      id: 'run-1',
      accountId: ACCOUNT_ID,
      completedAt: 1000,
      blob: encryptLegacyJson(key, { summary: true }),
    })
    await putRunDetail({
      schemaVersion: 2,
      id: 'run-1',
      accountId: ACCOUNT_ID,
      completedAt: 1000,
      blob: encryptLegacyJson(key, { detail: true }),
    })
    await putMission({
      schemaVersion: 2,
      id: 'mission-1',
      accountId: ACCOUNT_ID,
      updatedAt: 1000,
      blob: encryptLegacyJson(key, { mission: true }),
    })

    expect(await migrateAccountCipherBlobs(ACCOUNT_ID, key)).toBe('migrated')

    const account = await getAccountByUsername('legacy')
    expect(account?.checkBlob.version).toBe(2)
    expect(account?.prefsBlob?.version).toBe(2)
    expect(decryptJson(
      key,
      account!.prefsBlob!,
      accountCipherAad('prefs', ACCOUNT_ID),
    )).toEqual({ defaultSimSpeed: 5 })

    const run = (await listRuns(ACCOUNT_ID))[0]
    const detail = (await listRunDetails(ACCOUNT_ID))[0]
    const mission = (await listMissions(ACCOUNT_ID))[0]
    expect(decryptJson(
      key,
      run.blob,
      accountCipherAad('run-summary', ACCOUNT_ID, 'run-1'),
    )).toEqual({ summary: true })
    expect(decryptJson(
      key,
      detail.blob,
      accountCipherAad('run-detail', ACCOUNT_ID, 'run-1'),
    )).toEqual({ detail: true })
    expect(decryptJson(
      key,
      mission.blob,
      accountCipherAad('custom-mission', ACCOUNT_ID, 'mission-1'),
    )).toEqual({ mission: true })
  })

  it('rolls the whole migration back when any legacy row cannot decrypt', async () => {
    const key = deriveKey('password123', { ...makeKdfParams(), iterations: 1000 })
    const foreign = deriveKey('different-password', { ...makeKdfParams(), iterations: 1000 })
    await putAccount(legacyAccount(key))
    await putRun({
      schemaVersion: 1,
      id: 'run-1',
      accountId: ACCOUNT_ID,
      completedAt: 1000,
      blob: encryptLegacyJson(key, { summary: true }),
    })
    await putMission({
      schemaVersion: 2,
      id: 'mission-1',
      accountId: ACCOUNT_ID,
      updatedAt: 1000,
      blob: encryptLegacyJson(foreign, { corrupt: true }),
    })

    expect(await migrateAccountCipherBlobs(ACCOUNT_ID, key)).toBe('failed')

    const account = await getAccountByUsername('legacy')
    const run = (await listRuns(ACCOUNT_ID))[0]
    expect(account?.checkBlob.version).not.toBe(2)
    expect(account?.prefsBlob?.version).not.toBe(2)
    expect(run.blob.version).not.toBe(2)
    expect(decryptJson(key, run.blob)).toEqual({ summary: true })
  })
})
