import { decryptJson, encryptJson } from '@/account/crypto'
import { MAX_CUSTOM_MISSIONS } from '@/account/types'
import type {
  AccountRecord,
  AnyBackupEnvelope,
  BackupEnvelope,
  BackupEnvelopeV2,
  CipherBlob,
  CustomMissionRecord,
  RunRecord,
  RunRecordV2,
} from '@/account/types'

// Guarded IndexedDB access, mirroring the resolveStorage() pattern in
// sim/mission/waypointPersistence.ts: in private mode / jsdom without a shim
// every call degrades to a null/empty result and the app stays fully usable
// signed-out. All records are schema-versioned and normalized on read.
//
// v2 (additive migration): adds `runDetails` (immutable per-run drill-down
// snapshots) and `missions` (custom mission definitions, capped at 5). The
// existing `accounts`/`runs` stores are untouched, so a v1 device upgrades in
// place — legacy runs with no matching runDetails row stay valid and render as
// "Legacy summary only".

const DB_NAME = 'drone-sim-accounts'
const DB_VERSION = 2

type StoreName = 'accounts' | 'runs' | 'runDetails' | 'missions'

function resolveIndexedDb(): IDBFactory | null {
  try {
    if (typeof indexedDB === 'undefined' || indexedDB === null) return null
    return indexedDB
  } catch {
    return null
  }
}

export function accountStorageAvailable(): boolean {
  return resolveIndexedDb() !== null
}

function openDb(): Promise<IDBDatabase | null> {
  const idb = resolveIndexedDb()
  if (!idb) return Promise.resolve(null)
  return new Promise((resolve) => {
    const req = idb.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Each store is guarded so a v1→v2 upgrade only ADDS the new stores and
      // leaves existing `accounts`/`runs` data (and their indexes) intact.
      if (!db.objectStoreNames.contains('accounts')) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id' })
        accounts.createIndex('usernameLower', 'usernameLower', { unique: true })
      }
      if (!db.objectStoreNames.contains('runs')) {
        const runs = db.createObjectStore('runs', { keyPath: 'id' })
        runs.createIndex('byAccount', ['accountId', 'completedAt'])
      }
      if (!db.objectStoreNames.contains('runDetails')) {
        const runDetails = db.createObjectStore('runDetails', { keyPath: 'id' })
        runDetails.createIndex('byAccount', ['accountId', 'completedAt'])
      }
      if (!db.objectStoreNames.contains('missions')) {
        const missions = db.createObjectStore('missions', { keyPath: 'id' })
        missions.createIndex('byAccount', ['accountId', 'updatedAt'])
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
}

async function withStore<T>(
  storeName: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T | null>,
): Promise<T | null> {
  const db = await openDb()
  if (!db) return null
  try {
    const tx = db.transaction(storeName, mode)
    const result = await fn(tx.objectStore(storeName))
    return await new Promise((resolve) => {
      tx.oncomplete = () => { db.close(); resolve(result) }
      tx.onerror = () => { db.close(); resolve(null) }
      tx.onabort = () => { db.close(); resolve(null) }
    })
  } catch {
    db.close()
    return null
  }
}

function isQuotaError(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && 'name' in err && err.name === 'QuotaExceededError'
}

// Per-account key range over a `byAccount` index whose second component is a
// numeric timestamp (completedAt / updatedAt). Covers every row for the account.
function accountRange(accountId: string): IDBKeyRange {
  return IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER])
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER
}

function isCipherBlob(value: unknown): value is CipherBlob {
  if (typeof value !== 'object' || value === null) return false
  const blob = value as Partial<CipherBlob>
  return isNonEmptyString(blob.iv) && isNonEmptyString(blob.ct)
}

function isAccountRecord(v: unknown): v is AccountRecord {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Partial<AccountRecord>
  return a.schemaVersion === 1
    && isNonEmptyString(a.id)
    && isNonEmptyString(a.username)
    && a.usernameLower === a.username.trim().toLowerCase()
    && isNonEmptyString(a.displayName)
    && isTimestamp(a.createdAt)
    && typeof a.kdfParams === 'object' && a.kdfParams !== null
    && a.kdfParams.kdf === 'pbkdf2-sha256'
    && Number.isInteger(a.kdfParams.iterations) && a.kdfParams.iterations > 0
    && isNonEmptyString(a.kdfParams.salt)
    && isCipherBlob(a.checkBlob)
    && (a.prefsBlob === undefined || isCipherBlob(a.prefsBlob))
}

function isRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<RunRecord>
  return r.schemaVersion === 1
    && isNonEmptyString(r.id)
    && isNonEmptyString(r.accountId)
    && isTimestamp(r.completedAt)
    && isCipherBlob(r.blob)
}

function isRunRecordV2(v: unknown): v is RunRecordV2 {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<RunRecordV2>
  return r.schemaVersion === 2
    && isNonEmptyString(r.id)
    && isNonEmptyString(r.accountId)
    && isTimestamp(r.completedAt)
    && isCipherBlob(r.blob)
}

function isCustomMissionRecord(v: unknown): v is CustomMissionRecord {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Partial<CustomMissionRecord>
  return m.schemaVersion === 2
    && isNonEmptyString(m.id)
    && isNonEmptyString(m.accountId)
    && isTimestamp(m.updatedAt)
    && isCipherBlob(m.blob)
}

function hasUniqueIds(records: Array<{ id: string }>): boolean {
  return new Set(records.map((record) => record.id)).size === records.length
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export async function putAccount(record: AccountRecord): Promise<boolean> {
  const ok = await withStore('accounts', 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
    return true
  })
  return ok === true
}

export async function getAccountByUsername(username: string): Promise<AccountRecord | null> {
  const result = await withStore('accounts', 'readonly', async (store) => {
    const idx = store.index('usernameLower')
    return await requestToPromise(idx.get(username.trim().toLowerCase()))
  })
  return isAccountRecord(result) ? result : null
}

export async function listAccounts(): Promise<AccountRecord[]> {
  const result = await withStore('accounts', 'readonly', async (store) =>
    await requestToPromise(store.getAll()))
  if (!Array.isArray(result)) return []
  return result.filter(isAccountRecord).sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteAccount(accountId: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['accounts', 'runs', 'runDetails', 'missions'], 'readwrite')
      tx.objectStore('accounts').delete(accountId)
      for (const name of ['runs', 'runDetails', 'missions'] as const) {
        const cursorReq = tx.objectStore(name).index('byAccount').openCursor(accountRange(accountId))
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
      }
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

// ── Runs (schemaVersion 1 summaries) ────────────────────────────────────────────

export async function putRun(record: RunRecord): Promise<boolean> {
  const ok = await withStore('runs', 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
    return true
  })
  return ok === true
}

export type PutRunBundleResult =
  | { ok: true }
  | { ok: false; quota: true }
  | { ok: false }

/**
 * Persist a compact summary and its optional immutable detail as one artifact.
 * If either write fails the transaction aborts, preventing orphan detail rows or
 * summaries that claim a missing detail is saved. Callers may retry summary-only
 * after a quota result.
 */
export async function putRunBundle(
  summary: RunRecord,
  detail: RunRecordV2 | null,
): Promise<PutRunBundleResult> {
  if (!isRunRecord(summary)) return { ok: false }
  if (detail && (!isRunRecordV2(detail)
    || detail.id !== summary.id
    || detail.accountId !== summary.accountId
    || detail.completedAt !== summary.completedAt)) return { ok: false }

  const db = await openDb()
  if (!db) return { ok: false }
  return new Promise((resolve) => {
    let quota = false
    let settled = false
    let tx: IDBTransaction | null = null
    const settle = (result: PutRunBundleResult) => {
      if (settled) return
      settled = true
      db.close()
      resolve(result)
    }

    try {
      tx = db.transaction(['runs', 'runDetails'], 'readwrite')
      if (detail) {
        const detailReq = tx.objectStore('runDetails').put(detail)
        detailReq.onerror = () => { if (isQuotaError(detailReq.error)) quota = true }
      }
      const summaryReq = tx.objectStore('runs').put(summary)
      summaryReq.onerror = () => { if (isQuotaError(summaryReq.error)) quota = true }
      tx.oncomplete = () => settle({ ok: true })
      tx.onerror = () => settle(quota ? { ok: false, quota: true } : { ok: false })
      tx.onabort = () => settle(quota ? { ok: false, quota: true } : { ok: false })
    } catch (err) {
      try { tx?.abort() } catch { /* transaction already finished */ }
      settle(isQuotaError(err) ? { ok: false, quota: true } : { ok: false })
    }
  })
}

export async function getRun(id: string): Promise<RunRecord | null> {
  const result = await withStore('runs', 'readonly', async (store) =>
    await requestToPromise(store.get(id)))
  return isRunRecord(result) ? result : null
}

export async function listRuns(accountId: string): Promise<RunRecord[]> {
  const result = await withStore('runs', 'readonly', async (store) => {
    const idx = store.index('byAccount')
    return await requestToPromise(idx.getAll(accountRange(accountId)))
  })
  if (!Array.isArray(result)) return []
  return result.filter(isRunRecord).sort((a, b) => a.completedAt - b.completedAt)
}

export async function deleteRun(id: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['runs', 'runDetails'], 'readwrite')
      tx.objectStore('runs').delete(id)
      tx.objectStore('runDetails').delete(id)
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

export async function clearRuns(accountId: string): Promise<boolean> {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['runs', 'runDetails'], 'readwrite')
      for (const name of ['runs', 'runDetails'] as const) {
        const cursorReq = tx.objectStore(name).index('byAccount').openCursor(accountRange(accountId))
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) return
          cursor.delete()
          cursor.continue()
        }
      }
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

// ── Run details (schemaVersion 2 immutable drill-down) ───────────────────────────

// Quota-aware: a full detail can be large. If the device rejects the write with
// QuotaExceededError we resolve `{ ok:false, quota:true }` (never throw) so the
// caller can keep the compact summary and drop only the heavy detail.
export async function putRunDetail(
  rec: RunRecordV2,
): Promise<{ ok: true } | { ok: false; quota: true } | { ok: false }> {
  const db = await openDb()
  if (!db) return { ok: false }
  return new Promise((resolve) => {
    let quota = false
    try {
      const tx = db.transaction('runDetails', 'readwrite')
      const store = tx.objectStore('runDetails')
      const req = store.put(rec)
      // Do NOT preventDefault here: letting the request error propagate aborts the
      // tx (no partial write); we just record whether the cause was a quota error.
      req.onerror = () => { if (isQuotaError(req.error)) quota = true }
      tx.oncomplete = () => { db.close(); resolve({ ok: true }) }
      tx.onerror = () => { db.close(); resolve(quota ? { ok: false, quota: true } : { ok: false }) }
      tx.onabort = () => { db.close(); resolve(quota ? { ok: false, quota: true } : { ok: false }) }
    } catch (err) {
      // Some engines throw synchronously from store.put when the payload exceeds quota.
      db.close()
      resolve(isQuotaError(err) ? { ok: false, quota: true } : { ok: false })
    }
  })
}

export async function getRunDetail(id: string): Promise<RunRecordV2 | null> {
  const result = await withStore('runDetails', 'readonly', async (store) =>
    await requestToPromise(store.get(id)))
  return isRunRecordV2(result) ? result : null
}

export async function listRunDetails(accountId: string): Promise<RunRecordV2[]> {
  const result = await withStore('runDetails', 'readonly', async (store) => {
    const idx = store.index('byAccount')
    return await requestToPromise(idx.getAll(accountRange(accountId)))
  })
  if (!Array.isArray(result)) return []
  return result.filter(isRunRecordV2).sort((a, b) => a.completedAt - b.completedAt)
}

export async function deleteRunDetail(id: string): Promise<boolean> {
  const ok = await withStore('runDetails', 'readwrite', async (store) => {
    await requestToPromise(store.delete(id))
    return true
  })
  return ok === true
}

export async function clearRunDetails(accountId: string): Promise<boolean> {
  const details = await listRunDetails(accountId)
  const ok = await withStore('runDetails', 'readwrite', async (store) => {
    for (const d of details) await requestToPromise(store.delete(d.id))
    return true
  })
  return ok === true
}

// ── Custom missions (schemaVersion 2, max 5 per account) ─────────────────────────

// The 5-mission cap is enforced INSIDE the readwrite transaction so a burst of
// concurrent creates can't slip past a read-then-write race. Updating an id that
// already exists is always allowed, even at the limit.
export async function putMission(
  rec: CustomMissionRecord,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'limit' }
  | { ok: false; reason: 'quota' }
  | { ok: false }
> {
  const db = await openDb()
  if (!db) return { ok: false }
  return new Promise((resolve) => {
    let outcome: { ok: true } | { ok: false; reason: 'limit' } | { ok: false } = { ok: false }
    let quota = false
    try {
      const tx = db.transaction('missions', 'readwrite')
      const store = tx.objectStore('missions')
      const existingReq = store.index('byAccount').getAll(accountRange(rec.accountId))
      existingReq.onsuccess = () => {
        const rows = (Array.isArray(existingReq.result) ? existingReq.result : []) as CustomMissionRecord[]
        const alreadyExists = rows.some((r) => r.id === rec.id)
        if (!alreadyExists && rows.length >= MAX_CUSTOM_MISSIONS) {
          outcome = { ok: false, reason: 'limit' }
          tx.abort()
          return
        }
        // Mission ids are global keys. Refuse to overwrite another account's row
        // if an imported or crafted id collides.
        const idReq = store.get(rec.id)
        idReq.onsuccess = () => {
          const existing = idReq.result
          if (existing && (!isCustomMissionRecord(existing) || existing.accountId !== rec.accountId)) {
            tx.abort()
            return
          }
          const putReq = store.put(rec)
          putReq.onsuccess = () => { outcome = { ok: true } }
          putReq.onerror = () => { if (isQuotaError(putReq.error)) quota = true }
        }
      }
      tx.oncomplete = () => { db.close(); resolve(outcome) }
      const settleFailure = () => {
        db.close()
        if (quota) { resolve({ ok: false, reason: 'quota' }); return }
        resolve(outcome.ok === false ? outcome : { ok: false })
      }
      tx.onerror = settleFailure
      tx.onabort = settleFailure
    } catch (err) {
      db.close()
      resolve(isQuotaError(err) ? { ok: false, reason: 'quota' } : { ok: false })
    }
  })
}

export async function getMission(id: string): Promise<CustomMissionRecord | null> {
  const result = await withStore('missions', 'readonly', async (store) =>
    await requestToPromise(store.get(id)))
  return isCustomMissionRecord(result) ? result : null
}

export async function listMissions(accountId: string): Promise<CustomMissionRecord[]> {
  const result = await withStore('missions', 'readonly', async (store) => {
    const idx = store.index('byAccount')
    return await requestToPromise(idx.getAll(accountRange(accountId)))
  })
  if (!Array.isArray(result)) return []
  return result.filter(isCustomMissionRecord).sort((a, b) => a.updatedAt - b.updatedAt)
}

export async function deleteMission(id: string): Promise<boolean> {
  const ok = await withStore('missions', 'readwrite', async (store) => {
    await requestToPromise(store.delete(id))
    return true
  })
  return ok === true
}

export async function clearMissions(accountId: string): Promise<boolean> {
  const missions = await listMissions(accountId)
  const ok = await withStore('missions', 'readwrite', async (store) => {
    for (const m of missions) await requestToPromise(store.delete(m.id))
    return true
  })
  return ok === true
}

// ── Atomic re-key (change password) ─────────────────────────────────────────────

// Re-encrypts every account-owned blob under `newKey` in a SINGLE transaction
// spanning all four stores. The caller passes a fully-rebuilt AccountRecord
// (new kdfParams / checkBlob / prefsBlob already re-encrypted under newKey);
// this function re-keys the runs / runDetails / missions blobs. Any failure —
// a decrypt error, a store error — aborts the whole transaction, so the old
// key's data is left completely intact (all-or-nothing).
export async function rekeyAllRecords(
  accountId: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  newAccountRecord: AccountRecord,
): Promise<boolean> {
  if (!isNonEmptyString(accountId)
    || !isAccountRecord(newAccountRecord)
    || newAccountRecord.id !== accountId) return false
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(['accounts', 'runs', 'runDetails', 'missions'], 'readwrite')
      let failed = false
      const fail = () => {
        if (failed) return
        failed = true
        try { tx.abort() } catch { /* tx already finishing/aborting */ }
      }

      tx.objectStore('accounts').put(newAccountRecord)

      const rekeyStore = (name: 'runs' | 'runDetails' | 'missions') => {
        const cursorReq = tx.objectStore(name).index('byAccount').openCursor(accountRange(accountId))
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) return
          try {
            const rec = cursor.value as { blob: CipherBlob }
            const obj = decryptJson(oldKey, rec.blob)
            cursor.update({ ...rec, blob: encryptJson(newKey, obj) })
          } catch {
            fail()
            return
          }
          cursor.continue()
        }
        cursorReq.onerror = () => fail()
      }

      rekeyStore('runs')
      rekeyStore('runDetails')
      rekeyStore('missions')

      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
}

// ── Backup / restore ─────────────────────────────────────────────────────────

// v2 envelope: every account-owned record, exported as-is (blobs are never
// re-keyed on export — restoring requires the same password). Matches the v1
// convention; v1 envelopes still import (runs only).
export async function exportBackup(accountId: string): Promise<BackupEnvelopeV2 | null> {
  const accounts = await listAccounts()
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return null
  const runs = await listRuns(accountId)
  const runDetails = await listRunDetails(accountId)
  const missions = await listMissions(accountId)
  return {
    kind: 'drone-sim-backup',
    schemaVersion: 2,
    exportedAt: Date.now(),
    account,
    runs,
    runDetails,
    missions,
  }
}

export async function importBackup(envelope: unknown): Promise<{ ok: boolean; reason?: string }> {
  if (typeof envelope !== 'object' || envelope === null) return { ok: false, reason: 'Not a backup file' }
  const env = envelope as Partial<AnyBackupEnvelope>
  if (env.kind !== 'drone-sim-backup') return { ok: false, reason: 'Unrecognized backup format' }

  const version = env.schemaVersion
  if (version !== 1 && version !== 2) {
    if (typeof version === 'number' && version > 2) {
      return { ok: false, reason: `Backup version ${version} is newer than this app supports — update the app to restore it` }
    }
    return { ok: false, reason: 'Unrecognized backup format' }
  }

  // ── Validate the ENTIRE envelope up-front; only then touch storage. ──
  if (!isAccountRecord(env.account)) return { ok: false, reason: 'Backup account record is invalid' }
  const account = env.account
  if (!isTimestamp(env.exportedAt)) return { ok: false, reason: 'Backup export timestamp is invalid' }
  if (!Array.isArray(env.runs) || !env.runs.every(isRunRecord)) return { ok: false, reason: 'Backup runs list is invalid' }
  const runs = env.runs
  if (!hasUniqueIds(runs)) return { ok: false, reason: 'Backup contains duplicate run ids' }
  if (runs.some((record) => record.accountId !== account.id)) {
    return { ok: false, reason: 'Backup contains a run owned by another account' }
  }

  let runDetails: RunRecordV2[] = []
  let missions: CustomMissionRecord[] = []
  if (version === 2) {
    const v2 = env as Partial<BackupEnvelopeV2>
    if (!Array.isArray(v2.runDetails) || !v2.runDetails.every(isRunRecordV2)) return { ok: false, reason: 'Backup runDetails list is invalid' }
    if (!Array.isArray(v2.missions) || !v2.missions.every(isCustomMissionRecord)) return { ok: false, reason: 'Backup missions list is invalid' }
    runDetails = v2.runDetails
    missions = v2.missions
    if (!hasUniqueIds(runDetails)) return { ok: false, reason: 'Backup contains duplicate run-detail ids' }
    if (!hasUniqueIds(missions)) return { ok: false, reason: 'Backup contains duplicate mission ids' }
    if (runDetails.some((record) => record.accountId !== account.id)
      || missions.some((record) => record.accountId !== account.id)) {
      return { ok: false, reason: 'Backup contains data owned by another account' }
    }
    const summariesById = new Map(runs.map((record) => [record.id, record]))
    if (runDetails.some((detail) => {
      const summary = summariesById.get(detail.id)
      return !summary || summary.completedAt !== detail.completedAt
    })) {
      return { ok: false, reason: 'Backup contains an orphan or mismatched run detail' }
    }
    if (missions.length > MAX_CUSTOM_MISSIONS) {
      return { ok: false, reason: `Backup exceeds the ${MAX_CUSTOM_MISSIONS}-custom-mission limit` }
    }
  }

  // ── One atomic transaction across every store: all-or-nothing restore. ──
  const db = await openDb()
  if (!db) return { ok: false, reason: 'Device storage unavailable' }
  let missionLimitExceeded = false
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(['accounts', 'runs', 'runDetails', 'missions'], 'readwrite')
      const missionStore = tx.objectStore('missions')
      const existingReq = missionStore.index('byAccount').getAllKeys(accountRange(account.id))
      existingReq.onsuccess = () => {
        const existingIds = new Set(existingReq.result.map(String))
        missions.forEach((mission) => existingIds.add(mission.id))
        if (existingIds.size > MAX_CUSTOM_MISSIONS) {
          missionLimitExceeded = true
          tx.abort()
          return
        }

        tx.objectStore('accounts').put(account)
        for (const r of runs) tx.objectStore('runs').put(r)
        for (const d of runDetails) tx.objectStore('runDetails').put(d)
        for (const m of missions) missionStore.put(m)
      }
      tx.oncomplete = () => { db.close(); resolve(true) }
      tx.onerror = () => { db.close(); resolve(false) }
      tx.onabort = () => { db.close(); resolve(false) }
    } catch {
      db.close()
      resolve(false)
    }
  })
  if (ok) return { ok: true }
  if (missionLimitExceeded) {
    return { ok: false, reason: `Restore would exceed the ${MAX_CUSTOM_MISSIONS}-custom-mission limit — no changes were made` }
  }
  return { ok: false, reason: 'Device storage unavailable — no changes were made' }
}

// Retained for potential callers that still reference the v1 envelope type.
export type { BackupEnvelope }
