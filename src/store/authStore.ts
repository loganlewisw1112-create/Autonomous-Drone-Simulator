import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import {
  accountCipherAad,
  deriveKey,
  encryptJson,
  decryptJson,
  makeCheckBlob,
  makeKdfParams,
  makeId,
} from '@/account/crypto'
import {
  buildKeyWraps,
  newDataKey,
  newRecoveryMaterial,
  openTotpSeed,
  rewrapForPassword,
  sealTotpSeed,
  unlockDataKey,
  unlockWithRecoveryCode,
  withRotatedRecovery,
} from '@/account/recovery'
import { base32Encode, buildOtpauthUri, generateTotpSecret, verifyTotp } from '@/account/totp'
import {
  accountStorageAvailable,
  deleteAccount,
  getAccountByUsername,
  listAccounts,
  migrateAccountCipherBlobs,
  purgeExpiredOperationalRecords,
  putAccount,
  setAccountStorageReadOnly,
} from '@/account/accountDb'
import { unlockWithInstructorAccessCode } from '@/account/instructorAccessRemote'
import type { AdminClaim } from '@/account/adminPass'
import type { AccountPrefs, AccountRecord, AccountRole } from '@/account/types'

// Local-only auth. The derived AES key lives in memory for the current page
// session only. It is never persisted in browser storage.

const SESSION_KEY = 'drone-sim:session:v1'

function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export interface ActiveAccount {
  id: string
  username: string
  displayName: string
  /** Present for classroom instructor/student profiles; absent on solo operators. */
  role?: AccountRole
  /** True after one-time supervised unlock on the Start a training class page. */
  instructorUnlocked?: boolean
  /** True only when the stored admin pass verifies against the build's admin key. */
  isAdmin?: boolean
  /** Email on the verified admin pass. */
  adminEmail?: string
  /** True when a recovery code can reset this profile's password. */
  recoveryConfigured?: boolean
  /** True when an authenticator app is paired to the reset flow. */
  totpPaired?: boolean
}

/** Pairing material for the Settings / signup "Add an authenticator app" step. */
export interface TotpPairingOffer {
  /** Base32 secret for manual entry. */
  secret: string
  /** otpauth:// URI the QR code encodes. */
  uri: string
}

export type RecoveryCheck =
  | { ok: true; totpRequired: boolean }
  | { ok: false }
export type RecoveryReset =
  | { ok: true; newRecoveryCode: string }
  | { ok: false }

// Recovery-attempt throttle. In memory only (a reload resets it), keyed by
// lower-cased username: after 5 failures the username backs off for 30 s.
const RECOVERY_MAX_FAILS = 5
const RECOVERY_BACKOFF_MS = 30_000
const recoveryFails = new Map<string, { fails: number; lockedUntil: number }>()

function recoveryLockSeconds(usernameLower: string): number {
  const entry = recoveryFails.get(usernameLower)
  if (!entry || entry.lockedUntil <= Date.now()) return 0
  return Math.ceil((entry.lockedUntil - Date.now()) / 1000)
}

function recordRecoveryFailure(usernameLower: string) {
  const entry = recoveryFails.get(usernameLower) ?? { fails: 0, lockedUntil: 0 }
  entry.fails += 1
  if (entry.fails >= RECOVERY_MAX_FAILS) {
    entry.lockedUntil = Date.now() + RECOVERY_BACKOFF_MS
    entry.fails = 0
  }
  recoveryFails.set(usernameLower, entry)
}

/** Test hook: forget all in-memory recovery throttling. */
export function resetRecoveryThrottle() { recoveryFails.clear() }

// Authenticator seed awaiting its first correct code. Memory only, never persisted.
let pendingTotpSeed: Uint8Array | null = null

export interface SignUpOptions {
  role?: AccountRole
  /**
   * Optional at signup. Preferred path: create the instructor profile first, then
   * enter the access code once on the Start a training class page.
   */
  accessCode?: string
}

interface AuthState {
  activeAccount: ActiveAccount | null
  sessionKey: Uint8Array | null
  storageAvailable: boolean
  storageReadOnly: boolean
  authError: string | null
  prefs: AccountPrefs
  showSignIn: boolean
  showSettings: boolean
  showAnalytics: boolean
  /**
   * Freshly generated recovery code, shown once after signup / reset / regenerate
   * and cleared by `acknowledgeRecoveryCode`. Never persisted.
   */
  pendingRecoveryCode: string | null
  /** True when the pending code belongs to a brand-new account (UI then offers the authenticator step). */
  pendingRecoveryNewAccount: boolean
  /** Authenticator pairing offer awaiting its first correct code. */
  totpPairing: TotpPairingOffer | null

  setShowSignIn: (show: boolean) => void
  setShowSettings: (show: boolean) => void
  setShowAnalytics: (show: boolean) => void
  clearAuthError: () => void

  signUp: (
    username: string,
    displayName: string,
    password: string,
    options?: SignUpOptions,
  ) => Promise<boolean>
  signIn: (username: string, password: string) => Promise<boolean>
  /** One-time supervised unlock for an already-signed-in instructor account. */
  unlockInstructor: (accessCode: string) => Promise<boolean>
  signOut: () => void
  clearLegacyPersistedSession: () => void
  savePrefs: (prefs: AccountPrefs) => Promise<void>
  /** Verify and attach a signed admin pass to the signed-in profile. */
  applyAdminPass: (pass: string) => Promise<boolean>
  /** Remove the admin pass from the signed-in profile. */
  removeAdminPass: () => Promise<boolean>

  // ── Password recovery (recovery code + optional authenticator) ──
  acknowledgeRecoveryCode: () => void
  /** Checks username + recovery code (counts toward the throttle). Tells the UI whether a TOTP step follows. */
  checkRecoveryCode: (username: string, recoveryCode: string) => Promise<RecoveryCheck>
  /** Reset a forgotten password. Rotates the recovery code and signs the user in. */
  resetPasswordWithRecovery: (
    username: string,
    recoveryCode: string,
    totpCode: string | null,
    newPassword: string,
  ) => Promise<RecoveryReset>
  /** Create or regenerate the recovery code for the signed-in profile (works for legacy accounts). Returns the new code. */
  setupRecovery: () => Promise<string | null>
  /** Wrapped-account password change: re-wraps the data key, rewrites no records. */
  changePasswordWrapped: (newPassword: string) => Promise<boolean>
  beginTotpPairing: () => TotpPairingOffer | null
  confirmTotpPairing: (code: string) => Promise<boolean>
  cancelTotpPairing: () => void
  unpairTotp: () => Promise<boolean>
}

type AuthSet = (partial: Partial<AuthState>) => void

// Shared tail of password sign-in and recovery reset: upgrade legacy blobs, purge
// expired operational records, publish the session.
async function finishSignIn(set: AuthSet, record: AccountRecord, key: Uint8Array) {
  await verifyAdminPassFor(record)
  const migration = await migrateAccountCipherBlobs(record.id, key)
  const storageReadOnly = migration === 'failed'
  setAccountStorageReadOnly(record.id, storageReadOnly)
  if (!storageReadOnly) await purgeExpiredOperationalRecords(record.id)
  set({
    activeAccount: toActive(record),
    sessionKey: key,
    storageReadOnly,
    prefs: loadPrefs(record, key),
    authError: storageReadOnly
      ? 'Encrypted data upgrade could not complete. This profile is read-only; export a backup before repairing it.'
      : null,
    showSignIn: false,
  })
}

// Admin-pass verification pulls in Ed25519 (@noble/curves), which must stay out of the startup
// bundle (assert-bundle-isolation budget). So the verifier loads on demand, only for a profile
// that carries a pass, and its verdict is cached against that exact account id + pass text.
// toActive stays synchronous: it trusts the cache only for the same id and the same pass, so an
// edited or swapped pass is unverified (not admin) until verifyAdminPassFor runs on it.
let adminVerdict: { accountId: string; pass: string; claim: AdminClaim | null } | null = null

async function verifyAdminPassFor(record: AccountRecord): Promise<AdminClaim | null> {
  if (!record.adminPass) return null
  if (adminVerdict?.accountId === record.id && adminVerdict.pass === record.adminPass) return adminVerdict.claim
  const { verifyAdminPass } = await import('@/account/adminPass')
  const claim = verifyAdminPass(record.adminPass)
  adminVerdict = { accountId: record.id, pass: record.adminPass, claim }
  return claim
}

function cachedAdminClaim(account: AccountRecord): AdminClaim | null {
  if (!account.adminPass || !adminVerdict) return null
  return adminVerdict.accountId === account.id && adminVerdict.pass === account.adminPass ? adminVerdict.claim : null
}

function toActive(account: AccountRecord): ActiveAccount {
  const admin = cachedAdminClaim(account)
  return {
    ...(admin ? { isAdmin: true, adminEmail: admin.email } : {}),
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    // Unlock is stored as instructorUnlockedAt after the Start a training class
    // code succeeds. Missing timestamp = still locked (including pre-existing
    // instructor profiles that need one more supervised unlock on this page).
    instructorUnlocked: account.role === 'instructor'
      ? typeof account.instructorUnlockedAt === 'number'
      : undefined,
    recoveryConfigured: !!account.keyWraps,
    totpPaired: !!account.totp,
  }
}

function clearLegacySession() {
  const storage = resolveStorage()
  if (!storage) return
  try {
    storage.removeItem(SESSION_KEY)
  } catch { /* private mode — nothing persisted */ }
}

function loadPrefs(account: AccountRecord, key: Uint8Array): AccountPrefs {
  if (!account.prefsBlob) return {}
  try {
    return decryptJson<AccountPrefs>(key, account.prefsBlob, accountCipherAad('prefs', account.id))
  } catch {
    return {}
  }
}

export const useAuthStore = create<AuthState>()(
  devtools(
    subscribeWithSelector((set, get) => ({
      activeAccount: null,
      sessionKey: null,
      storageAvailable: accountStorageAvailable(),
      storageReadOnly: false,
      authError: null,
      prefs: {},
      showSignIn: false,
      showSettings: false,
      showAnalytics: false,
      pendingRecoveryCode: null,
      pendingRecoveryNewAccount: false,
      totpPairing: null,

      setShowSignIn: (show) => set({ showSignIn: show, authError: null }),
      setShowSettings: (show) => set({
        showSettings: show,
        ...(show ? { showAnalytics: false } : {}),
      }),
      setShowAnalytics: (show) => set({
        showAnalytics: show,
        ...(show ? { showSettings: false } : {}),
      }),
      clearAuthError: () => set({ authError: null }),

      signUp: async (username, displayName, password, options) => {
        const name = username.trim()
        if (name.length < 2) { set({ authError: 'Username must be at least 2 characters' }); return false }
        if (name.length > 64) { set({ authError: 'Username must be 64 characters or fewer' }); return false }
        if (/\p{C}/u.test(name)) { set({ authError: 'Username cannot contain control or formatting characters' }); return false }
        if (password.length < 8) { set({ authError: 'Password must be at least 8 characters' }); return false }
        if (password.length > 128) { set({ authError: 'Password must be 128 characters or fewer' }); return false }
        const safeDisplayName = displayName.trim() || name
        if (safeDisplayName.length > 64 || /\p{C}/u.test(safeDisplayName)) {
          set({ authError: 'Display name must be 64 characters or fewer and cannot contain control characters' })
          return false
        }
        if (!accountStorageAvailable()) { set({ authError: 'Device storage unavailable — accounts need IndexedDB' }); return false }

        const role = options?.role
        let instructorUnlockedAt: number | undefined
        let instructorUnlockPending: boolean | undefined
        if (role === 'instructor') {
          if (options?.accessCode?.trim()) {
            const unlocked = await unlockWithInstructorAccessCode(options.accessCode)
            if (!unlocked.ok) {
              set({ authError: unlocked.error })
              return false
            }
            instructorUnlockedAt = Date.now()
          } else {
            instructorUnlockPending = true
          }
        }

        const existing = await getAccountByUsername(name)
        if (existing) { set({ authError: 'That username already exists on this device' }); return false }

        // New accounts use a random data key K, wrapped under the password key and
        // under a fresh recovery code (shown once via pendingRecoveryCode).
        const kdfParams = makeKdfParams()
        const passwordKey = deriveKey(password, kdfParams)
        const key = newDataKey()
        const recovery = newRecoveryMaterial()
        const accountId = makeId()
        const record: AccountRecord = {
          schemaVersion: 1,
          id: accountId,
          username: name,
          usernameLower: name.toLowerCase(),
          displayName: safeDisplayName,
          createdAt: Date.now(),
          kdfParams,
          checkBlob: makeCheckBlob(key, accountId),
          keyWraps: buildKeyWraps(accountId, key, passwordKey, recovery),
          ...(role ? { role } : {}),
          ...(instructorUnlockedAt !== undefined ? { instructorUnlockedAt } : {}),
          ...(instructorUnlockPending ? { instructorUnlockPending: true } : {}),
        }
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save the profile to device storage' }); return false }

        set({
          activeAccount: toActive(record),
          sessionKey: key, storageReadOnly: false, prefs: {}, authError: null, showSignIn: false,
          pendingRecoveryCode: recovery.code, pendingRecoveryNewAccount: true,
        })
        return true
      },

      unlockInstructor: async (accessCode) => {
        const { activeAccount } = get()
        if (!activeAccount || activeAccount.role !== 'instructor') {
          set({ authError: 'Sign in as an instructor to unlock' })
          return false
        }
        const unlocked = await unlockWithInstructorAccessCode(accessCode)
        if (!unlocked.ok) {
          set({ authError: unlocked.error })
          return false
        }
        if (activeAccount.instructorUnlocked) {
          set({ authError: null })
          return true
        }
        const record = await getAccountByUsername(activeAccount.username)
        if (!record || record.role !== 'instructor') {
          set({ authError: 'Instructor profile not found on this device' })
          return false
        }
        record.instructorUnlockedAt = Date.now()
        delete record.instructorUnlockPending
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save unlock status to device storage' }); return false }
        set({
          activeAccount: toActive(record),
          authError: null,
        })
        return true
      },

      signIn: async (username, password) => {
        const record = await getAccountByUsername(username)
        if (!record) { set({ authError: 'No profile with that username on this device' }); return false }
        // Wrapped accounts unwrap the data key with the password key; legacy accounts
        // use the password-derived key directly. A wrong password fails either way.
        const unlocked = unlockDataKey(record, password)
        if (!unlocked) {
          set({ authError: 'Incorrect password' })
          return false
        }
        await finishSignIn(set, record, unlocked.dataKey)
        return true
      },

      signOut: () => {
        clearLegacySession()
        pendingTotpSeed = null
        set({
          pendingRecoveryCode: null,
          pendingRecoveryNewAccount: false,
          totpPairing: null,
          activeAccount: null,
          sessionKey: null,
          storageReadOnly: false,
          prefs: {},
          showSettings: false,
          showAnalytics: false,
        })
      },

      clearLegacyPersistedSession: clearLegacySession,

      savePrefs: async (prefs) => {
        const { activeAccount, sessionKey, storageReadOnly } = get()
        if (!activeAccount || !sessionKey || storageReadOnly) return
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) return
        record.prefsBlob = encryptJson(
          sessionKey,
          prefs,
          accountCipherAad('prefs', activeAccount.id),
        )
        await putAccount(record)
        set({ prefs })
      },

      applyAdminPass: async (pass) => {
        const { activeAccount } = get()
        if (!activeAccount) { set({ authError: 'Sign in before adding an admin pass' }); return false }
        const trimmed = pass.trim()
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) { set({ authError: 'Profile not found on this device' }); return false }
        if (!await verifyAdminPassFor({ ...record, adminPass: trimmed })) {
          set({ authError: 'That admin pass is not valid' })
          return false
        }
        record.adminPass = trimmed
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save the admin pass to device storage' }); return false }
        set({ activeAccount: toActive(record), authError: null })
        return true
      },

      removeAdminPass: async () => {
        const { activeAccount } = get()
        if (!activeAccount) return false
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) return false
        delete record.adminPass
        const ok = await putAccount(record)
        if (!ok) return false
        set({ activeAccount: toActive(record), authError: null })
        return true
      },

      // ── Password recovery ──────────────────────────────────────────────────

      acknowledgeRecoveryCode: () => set({ pendingRecoveryCode: null, pendingRecoveryNewAccount: false }),

      checkRecoveryCode: async (username, recoveryCode) => {
        const lower = username.trim().toLowerCase()
        const wait = recoveryLockSeconds(lower)
        if (wait > 0) {
          set({ authError: `Too many recovery attempts. Try again in ${wait} seconds` })
          return { ok: false }
        }
        const record = await getAccountByUsername(username)
        if (!record) {
          recordRecoveryFailure(lower)
          set({ authError: 'No profile with that username on this device' })
          return { ok: false }
        }
        if (!record.keyWraps) {
          set({ authError: 'No recovery code was set up for this profile, so its password cannot be reset' })
          return { ok: false }
        }
        if (!unlockWithRecoveryCode(record, recoveryCode)) {
          recordRecoveryFailure(lower)
          set({ authError: 'That recovery code is not correct' })
          return { ok: false }
        }
        set({ authError: null })
        return { ok: true, totpRequired: !!record.totp }
      },

      resetPasswordWithRecovery: async (username, recoveryCode, totpCode, newPassword) => {
        const lower = username.trim().toLowerCase()
        const wait = recoveryLockSeconds(lower)
        if (wait > 0) {
          set({ authError: `Too many recovery attempts. Try again in ${wait} seconds` })
          return { ok: false }
        }
        if (newPassword.length < 8) { set({ authError: 'Password must be at least 8 characters' }); return { ok: false } }
        if (newPassword.length > 128) { set({ authError: 'Password must be 128 characters or fewer' }); return { ok: false } }
        const record = await getAccountByUsername(username)
        if (!record) {
          recordRecoveryFailure(lower)
          set({ authError: 'No profile with that username on this device' })
          return { ok: false }
        }
        if (!record.keyWraps) {
          set({ authError: 'No recovery code was set up for this profile, so its password cannot be reset' })
          return { ok: false }
        }
        const unlocked = unlockWithRecoveryCode(record, recoveryCode)
        if (!unlocked) {
          recordRecoveryFailure(lower)
          set({ authError: 'That recovery code is not correct' })
          return { ok: false }
        }
        // UI-level gate (see totp.ts): the recovery code alone already unwrapped K.
        if (record.totp) {
          const seed = openTotpSeed(record.totp, unlocked.dataKey, record.id)
          if (!seed || !totpCode || !verifyTotp(seed, totpCode)) {
            recordRecoveryFailure(lower)
            set({ authError: 'That authenticator code is not correct' })
            return { ok: false }
          }
        }
        const rewrapped = rewrapForPassword(record, unlocked.dataKey, newPassword)
        if (!rewrapped) { set({ authError: 'Could not reset this profile' }); return { ok: false } }
        // Rotate the recovery code on every use: the old one stops working.
        const rotated = withRotatedRecovery(
          { ...record, keyWraps: rewrapped.keyWraps },
          unlocked.dataKey,
        )
        const next: AccountRecord = {
          ...record,
          kdfParams: rewrapped.kdfParams,
          keyWraps: rotated.keyWraps,
        }
        const ok = await putAccount(next)
        if (!ok) { set({ authError: 'Could not save the new password to device storage' }); return { ok: false } }
        recoveryFails.delete(lower)
        await finishSignIn(set, next, unlocked.dataKey)
        set({ pendingRecoveryCode: rotated.code, pendingRecoveryNewAccount: false })
        return { ok: true, newRecoveryCode: rotated.code }
      },

      setupRecovery: async () => {
        const { activeAccount, sessionKey, storageReadOnly } = get()
        if (!activeAccount || !sessionKey) { set({ authError: 'Sign in before setting up recovery' }); return null }
        if (storageReadOnly) { set({ authError: 'This profile is read-only; export a backup before repairing it' }); return null }
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) { set({ authError: 'Profile not found on this device' }); return null }
        // sessionKey is K for wrapped accounts and the password-derived key (= K) for
        // legacy ones, so nothing already on disk is re-encrypted.
        const rotated = withRotatedRecovery(record, sessionKey)
        const next: AccountRecord = { ...record, keyWraps: rotated.keyWraps }
        const ok = await putAccount(next)
        if (!ok) { set({ authError: 'Could not save the recovery code to device storage' }); return null }
        set({ activeAccount: toActive(next), pendingRecoveryCode: rotated.code, pendingRecoveryNewAccount: false, authError: null })
        return rotated.code
      },

      changePasswordWrapped: async (newPassword) => {
        const { activeAccount, sessionKey, storageReadOnly } = get()
        if (!activeAccount || !sessionKey || storageReadOnly) return false
        if (newPassword.length < 8 || newPassword.length > 128) return false
        const record = await getAccountByUsername(activeAccount.username)
        if (!record?.keyWraps) return false
        // Only the password wrap and its salt change; K and every blob stay as they are.
        const rewrapped = rewrapForPassword(record, sessionKey, newPassword)
        if (!rewrapped) return false
        const ok = await putAccount({ ...record, ...rewrapped })
        return ok
      },

      beginTotpPairing: () => {
        const { activeAccount, sessionKey, storageReadOnly } = get()
        if (!activeAccount || !sessionKey) { set({ authError: 'Sign in before pairing an authenticator' }); return null }
        if (storageReadOnly) { set({ authError: 'This profile is read-only; export a backup before repairing it' }); return null }
        if (!activeAccount.recoveryConfigured) {
          set({ authError: 'Set up a recovery code before pairing an authenticator' })
          return null
        }
        pendingTotpSeed = generateTotpSecret()
        const secret = base32Encode(pendingTotpSeed)
        const offer: TotpPairingOffer = { secret, uri: buildOtpauthUri(activeAccount.username, secret) }
        set({ totpPairing: offer, authError: null })
        return offer
      },

      confirmTotpPairing: async (code) => {
        const { activeAccount, sessionKey } = get()
        if (!activeAccount || !sessionKey || !pendingTotpSeed) return false
        // Pairing only saves once the app shows a correct code, so a mistyped secret
        // can never lock the reset flow behind a code nobody can produce.
        if (!verifyTotp(pendingTotpSeed, code)) {
          set({ authError: 'That code does not match. Check the app and try again' })
          return false
        }
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) return false
        const next: AccountRecord = { ...record, totp: sealTotpSeed(pendingTotpSeed, sessionKey, record.id) }
        const ok = await putAccount(next)
        if (!ok) { set({ authError: 'Could not save the authenticator to device storage' }); return false }
        pendingTotpSeed = null
        set({ activeAccount: toActive(next), totpPairing: null, authError: null })
        return true
      },

      cancelTotpPairing: () => {
        pendingTotpSeed = null
        set({ totpPairing: null, authError: null })
      },

      unpairTotp: async () => {
        const { activeAccount, storageReadOnly } = get()
        if (!activeAccount || storageReadOnly) return false
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) return false
        const next: AccountRecord = { ...record }
        delete next.totp
        const ok = await putAccount(next)
        if (!ok) return false
        set({ activeAccount: toActive(next), authError: null })
        return true
      },
    })),
    { name: 'AuthStore' },
  ),
)

// Non-hook accessor for the chain-of-custody pipeline: events carry the active
// profile's identity, falling back to the historical default when signed out.
export function getActiveOperator(): { operatorId: string; operatorName: string | null } {
  const { activeAccount } = useAuthStore.getState()
  return activeAccount
    ? { operatorId: `operator:${activeAccount.username}`, operatorName: activeAccount.displayName }
    : { operatorId: 'operator-1', operatorName: null }
}

// Settings panel needs these for profile maintenance without re-imports.
export { deleteAccount, listAccounts }
