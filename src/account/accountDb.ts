import type { AccountRecord, BackupEnvelope, RunRecord } from '@/account/types'

// Guarded IndexedDB access, mirroring the resolveStorage() pattern in
// sim/mission/waypointPersistence.ts: in private mode / jsdom without a shim
// every call degrades to a null/empty result and the app stays fully usable
// signed-out. All records are schema-versioned and normalized on read.

const DB_NAME = 'drone-sim-accounts'
const DB_VERSION = 1

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
      if (!db.objectStoreNames.contains('accounts')) {
        const accounts = db.createObjectStore('accounts', { keyPath: 'id' })
        accounts.createIndex('usernameLower', 'usernameLower', { unique: true })
      }
      if (!db.objectStoreNames.contains('runs')) {
        const runs = db.createObjectStore('runs', { keyPath: 'id' })
        runs.createIndex('byAccount', ['accountId', 'completedAt'])
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
  storeName: 'accounts' | 'runs',
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

function isAccountRecord(v: unknown): v is AccountRecord {
  if (typeof v !== 'object' || v === null) return false
  const a = v as Partial<AccountRecord>
  return a.schemaVersion === 1
    && typeof a.id === 'string'
    && typeof a.username === 'string'
    && typeof a.usernameLower === 'string'
    && typeof a.createdAt === 'number'
    && typeof a.kdfParams === 'object' && a.kdfParams !== null
    && typeof a.checkBlob === 'object' && a.checkBlob !== null
}

function isRunRecord(v: unknown): v is RunRecord {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Partial<RunRecord>
  return r.schemaVersion === 1
    && typeof r.id === 'string'
    && typeof r.accountId === 'string'
    && typeof r.completedAt === 'number'
    && typeof r.blob === 'object' && r.blob !== null
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
  await clearRuns(accountId)
  const ok = await withStore('accounts', 'readwrite', async (store) => {
    await requestToPromise(store.delete(accountId))
    return true
  })
  return ok === true
}

// ── Runs ──────────────────────────────────────────────────────────────────────

export async function putRun(record: RunRecord): Promise<boolean> {
  const ok = await withStore('runs', 'readwrite', async (store) => {
    await requestToPromise(store.put(record))
    return true
  })
  return ok === true
}

export async function listRuns(accountId: string): Promise<RunRecord[]> {
  const result = await withStore('runs', 'readonly', async (store) => {
    const idx = store.index('byAccount')
    const range = IDBKeyRange.bound([accountId, 0], [accountId, Number.MAX_SAFE_INTEGER])
    return await requestToPromise(idx.getAll(range))
  })
  if (!Array.isArray(result)) return []
  return result.filter(isRunRecord).sort((a, b) => a.completedAt - b.completedAt)
}

export async function clearRuns(accountId: string): Promise<boolean> {
  const runs = await listRuns(accountId)
  const ok = await withStore('runs', 'readwrite', async (store) => {
    for (const run of runs) await requestToPromise(store.delete(run.id))
    return true
  })
  return ok === true
}

// ── Backup / restore ─────────────────────────────────────────────────────────

export async function exportBackup(accountId: string): Promise<BackupEnvelope | null> {
  const accounts = await listAccounts()
  const account = accounts.find((a) => a.id === accountId)
  if (!account) return null
  const runs = await listRuns(accountId)
  return { kind: 'drone-sim-backup', schemaVersion: 1, exportedAt: Date.now(), account, runs }
}

export async function importBackup(envelope: unknown): Promise<{ ok: boolean; reason?: string }> {
  if (typeof envelope !== 'object' || envelope === null) return { ok: false, reason: 'Not a backup file' }
  const env = envelope as Partial<BackupEnvelope>
  if (env.kind !== 'drone-sim-backup' || env.schemaVersion !== 1) return { ok: false, reason: 'Unrecognized backup format' }
  if (!isAccountRecord(env.account)) return { ok: false, reason: 'Backup account record is invalid' }
  const runs = Array.isArray(env.runs) ? env.runs.filter(isRunRecord) : []
  const putOk = await putAccount(env.account)
  if (!putOk) return { ok: false, reason: 'Device storage unavailable' }
  for (const run of runs) await putRun(run)
  return { ok: true }
}
