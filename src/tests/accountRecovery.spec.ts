// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { resetRecoveryThrottle, useAuthStore } from '@/store/authStore'
import {
  exportBackup,
  getAccountByUsername,
  getRun,
  importBackup,
  putAccount,
  putRun,
} from '@/account/accountDb'
import {
  accountCipherAad,
  decryptJson,
  deriveKey,
  encryptJson,
  makeCheckBlob,
  makeId,
  makeKdfParams,
} from '@/account/crypto'
import { generateRecoveryCode, normalizeRecoveryCode } from '@/account/recovery'
import { base32Decode, totpCode } from '@/account/totp'
import type { AccountRecord } from '@/account/types'

// Cap PBKDF2 work like coverageFastKdf.ts does: the flows below derive many keys, and
// these tests are about the key-wrap logic, not the iteration policy (accountCrypto.spec
// asserts the real 310,000-iteration policy).
vi.mock('@/account/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/account/crypto')>()
  return {
    ...actual,
    deriveKey: (password: string, params: Parameters<typeof actual.deriveKey>[1]) =>
      actual.deriveKey(password, { ...params, iterations: Math.min(params.iterations, 1_000) }),
  }
})

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  resetRecoveryThrottle()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
    pendingRecoveryCode: null, pendingRecoveryNewAccount: false,
  })
})

function store() {
  return useAuthStore.getState()
}

/** Save one encrypted run under the signed-in profile's data key. */
async function saveRun(payload: Record<string, unknown>): Promise<string> {
  const { activeAccount, sessionKey } = store()
  const id = makeId()
  const ok = await putRun({
    schemaVersion: 1,
    id,
    accountId: activeAccount!.id,
    completedAt: Date.now(),
    blob: encryptJson(sessionKey!, payload, accountCipherAad('run-summary', activeAccount!.id, id)),
  })
  expect(ok).toBe(true)
  return id
}

async function readRun(id: string): Promise<Record<string, unknown>> {
  const { activeAccount, sessionKey } = store()
  const run = await getRun(id)
  return decryptJson(sessionKey!, run!.blob, accountCipherAad('run-summary', activeAccount!.id, id))
}

/** A profile written the way the app wrote them before recovery existed: K = password key. */
async function putLegacyAccount(username: string, password: string): Promise<AccountRecord> {
  const kdfParams = makeKdfParams()
  const key = deriveKey(password, kdfParams)
  const id = makeId()
  const record: AccountRecord = {
    schemaVersion: 1,
    id,
    username,
    usernameLower: username.toLowerCase(),
    displayName: username,
    createdAt: Date.now(),
    kdfParams,
    checkBlob: makeCheckBlob(key, id),
    prefsBlob: encryptJson(key, { defaultSimSpeed: 10 }, accountCipherAad('prefs', id)),
  }
  expect(await putAccount(record)).toBe(true)
  return record
}

describe('recovery code format', () => {
  it('generates 24 Crockford characters in groups of four', () => {
    const code = generateRecoveryCode()
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){5}[0-9A-HJKMNP-TV-Z]{4}$/)
    expect(generateRecoveryCode()).not.toBe(code)
  })

  it('normalizes case, spacing, dashes and look-alike letters', () => {
    const code = generateRecoveryCode()
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(normalizeRecoveryCode(sloppy)).toBe(normalizeRecoveryCode(code))
    expect(normalizeRecoveryCode('too-short')).toBeNull()
  })
})

describe('password reset with a recovery code', () => {
  it('new account: reset keeps every encrypted record, rotates the code, and retires the old password', async () => {
    expect(await store().signUp('pilot', 'Pilot', 'original-pass')).toBe(true)
    const firstCode = store().pendingRecoveryCode
    expect(firstCode).toMatch(/^[0-9A-Z]{4}-/)
    expect(store().pendingRecoveryNewAccount).toBe(true)
    expect(store().activeAccount?.recoveryConfigured).toBe(true)
    store().acknowledgeRecoveryCode()
    expect(store().pendingRecoveryCode).toBeNull()

    await store().savePrefs({ defaultSimSpeed: 5 })
    const runId = await saveRun({ scenario: 'nist_open_lane', score: 91 })
    const dataKeyBefore = [...store().sessionKey!]
    store().signOut()

    const reset = await store().resetPasswordWithRecovery('pilot', firstCode!, null, 'brand-new-pass')
    expect(reset.ok).toBe(true)
    if (!reset.ok) return
    expect([...store().sessionKey!]).toEqual(dataKeyBefore)
    expect(store().prefs.defaultSimSpeed).toBe(5)
    expect(await readRun(runId)).toEqual({ scenario: 'nist_open_lane', score: 91 })
    expect(store().pendingRecoveryCode).toBe(reset.newRecoveryCode)
    expect(reset.newRecoveryCode).not.toBe(firstCode)

    store().signOut()
    expect(await store().signIn('pilot', 'original-pass')).toBe(false)
    expect(await store().signIn('pilot', 'brand-new-pass')).toBe(true)
    store().signOut()

    // The used code is dead; the rotated one works.
    expect((await store().resetPasswordWithRecovery('pilot', firstCode!, null, 'third-pass-1')).ok).toBe(false)
    expect(store().authError).toBe('That recovery code is not correct')
    expect((await store().resetPasswordWithRecovery('pilot', reset.newRecoveryCode, null, 'third-pass-1')).ok).toBe(true)
  }, 30000)

  it('legacy account: signs in unchanged, then recovery set up later resets it without re-encrypting', async () => {
    const legacy = await putLegacyAccount('veteran', 'legacy-pass')
    expect(await store().signIn('veteran', 'legacy-pass')).toBe(true)
    expect(store().prefs.defaultSimSpeed).toBe(10)
    expect(store().activeAccount?.recoveryConfigured).toBeFalsy()
    const runId = await saveRun({ legacy: true })

    // Without a recovery code there is nothing to reset with.
    store().signOut()
    expect((await store().resetPasswordWithRecovery('veteran', generateRecoveryCode(), null, 'whatever-1')).ok).toBe(false)
    expect(store().authError).toMatch(/No recovery code was set up/)

    expect(await store().signIn('veteran', 'legacy-pass')).toBe(true)
    const code = await store().setupRecovery()
    expect(code).not.toBeNull()
    const after = await getAccountByUsername('veteran')
    expect(after?.checkBlob).toEqual(legacy.checkBlob)   // nothing re-encrypted
    expect(after?.prefsBlob).toEqual(legacy.prefsBlob)
    store().signOut()

    // Still signs in with the old password after the upgrade...
    expect(await store().signIn('veteran', 'legacy-pass')).toBe(true)
    store().signOut()
    // ...and the code resets it with history intact.
    expect((await store().resetPasswordWithRecovery('veteran', code!, null, 'fresh-pass-1')).ok).toBe(true)
    expect(store().prefs.defaultSimSpeed).toBe(10)
    expect(await readRun(runId)).toEqual({ legacy: true })
  }, 30000)

  it('backs off after five wrong recovery codes', async () => {
    await store().signUp('kid', '', 'student-pass')
    store().acknowledgeRecoveryCode()
    store().signOut()
    for (let i = 0; i < 5; i++) {
      expect((await store().resetPasswordWithRecovery('kid', generateRecoveryCode(), null, 'new-pass-12')).ok).toBe(false)
    }
    expect((await store().resetPasswordWithRecovery('kid', generateRecoveryCode(), null, 'new-pass-12')).ok).toBe(false)
    expect(store().authError).toMatch(/Too many recovery attempts/)
  }, 30000)

  it('requires the authenticator code once one is paired', async () => {
    await store().signUp('pairer', '', 'pair-pass-1')
    const code = store().pendingRecoveryCode!
    store().acknowledgeRecoveryCode()

    const offer = store().beginTotpPairing()
    expect(offer?.uri).toContain('otpauth://totp/')
    const seed = base32Decode(offer!.secret)
    expect(await store().confirmTotpPairing('000000' === totpCode(seed, Date.now()) ? '111111' : '000000')).toBe(false)
    expect(await store().confirmTotpPairing(totpCode(seed, Date.now()))).toBe(true)
    expect(store().activeAccount?.totpPaired).toBe(true)
    // The seed is stored sealed, never as plain text.
    const record = await getAccountByUsername('pairer')
    expect(JSON.stringify(record)).not.toContain(offer!.secret)
    store().signOut()

    expect((await store().resetPasswordWithRecovery('pairer', code, null, 'new-pass-12')).ok).toBe(false)
    expect(store().authError).toBe('That authenticator code is not correct')
    const wrong = totpCode(seed, Date.now() + 10 * 60_000)
    expect((await store().resetPasswordWithRecovery('pairer', code, wrong, 'new-pass-12')).ok).toBe(false)
    expect((await store().resetPasswordWithRecovery('pairer', code, totpCode(seed, Date.now()), 'new-pass-12')).ok).toBe(true)
    // Still paired after the reset (the seed lives under the unchanged data key).
    expect(store().activeAccount?.totpPaired).toBe(true)
  }, 30000)

  it('changing the password on a wrapped account re-wraps only and rewrites no run', async () => {
    await store().signUp('rewrap', '', 'first-pass-1')
    store().acknowledgeRecoveryCode()
    const runId = await saveRun({ n: 1 })
    const before = await getRun(runId)
    expect(await store().changePasswordWrapped('second-pass-2')).toBe(true)
    expect(await getRun(runId)).toEqual(before)
    store().signOut()
    expect(await store().signIn('rewrap', 'first-pass-1')).toBe(false)
    expect(await store().signIn('rewrap', 'second-pass-2')).toBe(true)
    expect(await readRun(runId)).toEqual({ n: 1 })
  }, 30000)

  it('a wrapped account survives backup export and import, recovery included', async () => {
    await store().signUp('backup', '', 'backup-pass-1')
    const code = store().pendingRecoveryCode!
    store().acknowledgeRecoveryCode()
    const runId = await saveRun({ kept: 'yes' })
    const envelope = await exportBackup(store().activeAccount!.id)
    expect(envelope?.account.keyWraps).toBeDefined()
    store().signOut()

    globalThis.indexedDB = new IDBFactory()
    expect((await importBackup(JSON.parse(JSON.stringify(envelope)))).ok).toBe(true)
    expect(await store().signIn('backup', 'backup-pass-1')).toBe(true)
    expect(await readRun(runId)).toEqual({ kept: 'yes' })
    store().signOut()
    expect((await store().resetPasswordWithRecovery('backup', code, null, 'after-import-1')).ok).toBe(true)
  }, 30000)
})
