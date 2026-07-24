import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { getAccountByUsername, listRuns } from '@/account/accountDb'
import type { AccountRecord, RunRecord } from '@/account/types'

// The v1→v2 migration is additive: opening a legacy (version 1) database through
// the app must leave the existing `accounts`/`runs` rows and indexes untouched
// while adding the new `runDetails`/`missions` stores. This exercises that path
// by seeding a real v1-schema DB, then reading it back through the app.

const DB_NAME = 'drone-sim-accounts'

function makeAccount(overrides: Partial<AccountRecord> = {}): AccountRecord {
  return {
    schemaVersion: 1,
    id: overrides.id ?? 'acct-1',
    username: overrides.username ?? 'Logan',
    usernameLower: (overrides.username ?? 'Logan').toLowerCase(),
    displayName: overrides.displayName ?? 'Logan',
    createdAt: overrides.createdAt ?? 1000,
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

// Build the database at the historical v1 schema (only accounts + runs), seed a
// legacy account and run, then close it — exactly what an already-installed v1
// device carries before this release.
function seedV1Database(account: AccountRecord, run: RunRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      const accounts = db.createObjectStore('accounts', { keyPath: 'id' })
      accounts.createIndex('usernameLower', 'usernameLower', { unique: true })
      const runs = db.createObjectStore('runs', { keyPath: 'id' })
      runs.createIndex('byAccount', ['accountId', 'completedAt'])
    }
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['accounts', 'runs'], 'readwrite')
      tx.objectStore('accounts').put(account)
      tx.objectStore('runs').put(run)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

// Open the DB at its current version and report its shape (stores, indexes, version).
function inspectSchema(): Promise<{ version: number; stores: string[]; runDetailIndexes: string[]; missionIndexes: string[] }> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    req.onsuccess = () => {
      const db = req.result
      const stores = Array.from(db.objectStoreNames)
      const tx = db.transaction(['runDetails', 'missions'], 'readonly')
      const runDetailIndexes = Array.from(tx.objectStore('runDetails').indexNames)
      const missionIndexes = Array.from(tx.objectStore('missions').indexNames)
      const version = db.version
      tx.oncomplete = () => { db.close(); resolve({ version, stores, runDetailIndexes, missionIndexes }) }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
    req.onerror = () => reject(req.error)
  })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('accountDb v1→v2 migration', () => {
  it('preserves legacy account + run rows when opened through the app', async () => {
    await seedV1Database(makeAccount(), makeRun('r1', 'acct-1', 1000))

    // Reading through the app triggers openDb() at version 2 → the additive upgrade.
    const account = await getAccountByUsername('logan')
    expect(account?.id).toBe('acct-1')
    expect(account?.checkBlob.ct).toBe('Y3RjdGN0Y3RjdGN0Y3RjdA==')

    const runs = await listRuns('acct-1')
    expect(runs.map((r) => r.id)).toEqual(['r1'])
  })

  it('adds the runDetails + missions stores and their byAccount indexes', async () => {
    await seedV1Database(makeAccount(), makeRun('r1', 'acct-1', 1000))
    // Force the migration by touching the DB through the app.
    await getAccountByUsername('logan')

    const schema = await inspectSchema()
    expect(schema.version).toBe(3)
    expect(schema.stores).toEqual(expect.arrayContaining([
      'accounts', 'runs', 'runDetails', 'missions', 'classrooms', 'classroomSessions',
    ]))
    expect(schema.runDetailIndexes).toContain('byAccount')
    expect(schema.missionIndexes).toContain('byAccount')
  })
})
