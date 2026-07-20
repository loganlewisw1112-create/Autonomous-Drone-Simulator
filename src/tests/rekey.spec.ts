// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  putAccount, putRun, putRunDetail, putMission, rekeyAllRecords,
  getAccountByUsername, listRuns, listRunDetails, listMissions,
} from '@/account/accountDb'
import {
  deriveKey, encryptJson, decryptJson, makeKdfParams, makeCheckBlob, verifyCheckBlob,
} from '@/account/crypto'
import type { AccountRecord, KdfParams } from '@/account/types'

// rekeyAllRecords must re-encrypt the account row plus every run / run-detail /
// mission blob under the new key inside ONE transaction. Any mid-transaction
// failure aborts the whole thing, leaving the old key able to decrypt everything.

const ACCOUNT_ID = 'acct-1'

function makeAccountRecord(key: Uint8Array, kdfParams: KdfParams): AccountRecord {
  return {
    schemaVersion: 1,
    id: ACCOUNT_ID,
    username: 'Logan',
    usernameLower: 'logan',
    displayName: 'Logan',
    createdAt: 1000,
    kdfParams,
    checkBlob: makeCheckBlob(key),
    prefsBlob: encryptJson(key, { defaultSimSpeed: 5 }),
  }
}

async function seedAccount(key: Uint8Array, kdfParams: KdfParams) {
  await putAccount(makeAccountRecord(key, kdfParams))
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

// Every test below runs 2-3 real PBKDF2-310k derivations synchronously — genuinely
// CPU-bound crypto work, not a hang. A shared/slow CI runner can exceed vitest's 5s
// default; a wider ceiling gives headroom without changing how fast the crypto runs.
describe('rekeyAllRecords', () => {
  it('re-encrypts the account and all three record stores under the new key', async () => {
    const oldKdf = makeKdfParams()
    const oldKey = deriveKey('oldpassword', oldKdf)
    await seedAccount(oldKey, oldKdf)
    await putRun({ schemaVersion: 1, id: 'r1', accountId: ACCOUNT_ID, completedAt: 1000, blob: encryptJson(oldKey, { scenarioId: 'wildfire' }) })
    await putRunDetail({ schemaVersion: 2, id: 'r1', accountId: ACCOUNT_ID, completedAt: 1000, blob: encryptJson(oldKey, { detail: 'full-snapshot' }) })
    await putMission({ schemaVersion: 2, id: 'm1', accountId: ACCOUNT_ID, updatedAt: 1000, blob: encryptJson(oldKey, { name: 'custom-mission' }) })

    const newKdf = makeKdfParams()
    const newKey = deriveKey('newpassword', newKdf)
    const ok = await rekeyAllRecords(ACCOUNT_ID, oldKey, newKey, makeAccountRecord(newKey, newKdf))
    expect(ok).toBe(true)

    // Account row: new key verifies, old key no longer does.
    const account = await getAccountByUsername('logan')
    expect(verifyCheckBlob(newKey, account!.checkBlob)).toBe(true)
    expect(verifyCheckBlob(oldKey, account!.checkBlob)).toBe(false)

    // Every record store now decrypts with the new key and rejects the old one.
    const run = (await listRuns(ACCOUNT_ID))[0]
    expect(decryptJson(newKey, run.blob)).toEqual({ scenarioId: 'wildfire' })
    expect(() => decryptJson(oldKey, run.blob)).toThrow()

    const detail = (await listRunDetails(ACCOUNT_ID))[0]
    expect(decryptJson(newKey, detail.blob)).toEqual({ detail: 'full-snapshot' })
    expect(() => decryptJson(oldKey, detail.blob)).toThrow()

    const mission = (await listMissions(ACCOUNT_ID))[0]
    expect(decryptJson(newKey, mission.blob)).toEqual({ name: 'custom-mission' })
    expect(() => decryptJson(oldKey, mission.blob)).toThrow()
  }, 20000)

  it('aborts atomically when a row cannot be decrypted — nothing changes', async () => {
    const oldKdf = makeKdfParams()
    const oldKey = deriveKey('oldpassword', oldKdf)
    const foreignKey = deriveKey('someone-else', makeKdfParams())
    await seedAccount(oldKey, oldKdf)
    await putRun({ schemaVersion: 1, id: 'r1', accountId: ACCOUNT_ID, completedAt: 1000, blob: encryptJson(oldKey, { scenarioId: 'wildfire' }) })
    await putRunDetail({ schemaVersion: 2, id: 'r1', accountId: ACCOUNT_ID, completedAt: 1000, blob: encryptJson(oldKey, { detail: 'full-snapshot' }) })
    // This mission blob is encrypted under a DIFFERENT key: the rekey cursor will
    // fail to decrypt it with oldKey and must abort the whole transaction.
    await putMission({ schemaVersion: 2, id: 'm1', accountId: ACCOUNT_ID, updatedAt: 1000, blob: encryptJson(foreignKey, { name: 'corrupt' }) })

    const newKdf = makeKdfParams()
    const newKey = deriveKey('newpassword', newKdf)
    const ok = await rekeyAllRecords(ACCOUNT_ID, oldKey, newKey, makeAccountRecord(newKey, newKdf))
    expect(ok).toBe(false)

    // The account row is untouched — old key still verifies, new key does not.
    const account = await getAccountByUsername('logan')
    expect(verifyCheckBlob(oldKey, account!.checkBlob)).toBe(true)
    expect(verifyCheckBlob(newKey, account!.checkBlob)).toBe(false)

    // Runs and run-details were rolled back — old key still decrypts them.
    const run = (await listRuns(ACCOUNT_ID))[0]
    expect(decryptJson(oldKey, run.blob)).toEqual({ scenarioId: 'wildfire' })
    const detail = (await listRunDetails(ACCOUNT_ID))[0]
    expect(decryptJson(oldKey, detail.blob)).toEqual({ detail: 'full-snapshot' })
  }, 20000)
})
