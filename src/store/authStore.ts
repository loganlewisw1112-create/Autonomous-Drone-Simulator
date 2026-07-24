import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import {
  deriveKey, encryptJson, decryptJson, makeCheckBlob, verifyCheckBlob, makeKdfParams, makeId, toBase64, fromBase64,
} from '@/account/crypto'
import {
  accountStorageAvailable, deleteAccount, getAccountByUsername, listAccounts, putAccount,
} from '@/account/accountDb'
import { configuredInstructorAccessHash, verifyInstructorAccessCode } from '@/account/instructorAccess'
import type { AccountPrefs, AccountRecord, AccountRole } from '@/account/types'

// Local-only auth. The derived AES key lives in memory for the session; with
// remember-me it is additionally kept in localStorage so a reload stays signed
// in on a personal device (tradeoff surfaced in the sign-in UI).

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
}

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
  authError: string | null
  prefs: AccountPrefs
  showSignIn: boolean
  showSettings: boolean
  showAnalytics: boolean

  setShowSignIn: (show: boolean) => void
  setShowSettings: (show: boolean) => void
  setShowAnalytics: (show: boolean) => void
  clearAuthError: () => void

  signUp: (
    username: string,
    displayName: string,
    password: string,
    rememberMe: boolean,
    options?: SignUpOptions,
  ) => Promise<boolean>
  signIn: (username: string, password: string, rememberMe: boolean) => Promise<boolean>
  /** One-time supervised unlock for an already-signed-in instructor account. */
  unlockInstructor: (accessCode: string) => Promise<boolean>
  signOut: () => void
  restoreRememberedSession: () => Promise<void>
  savePrefs: (prefs: AccountPrefs) => Promise<void>
}

function toActive(account: AccountRecord): ActiveAccount {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    instructorUnlocked: account.role === 'instructor'
      ? typeof account.instructorUnlockedAt === 'number'
      : undefined,
  }
}

function persistSession(account: AccountRecord, key: Uint8Array, rememberMe: boolean) {
  const storage = resolveStorage()
  if (!storage) return
  try {
    if (rememberMe) {
      storage.setItem(SESSION_KEY, JSON.stringify({ v: 1, username: account.username, key: toBase64(key) }))
    } else {
      storage.removeItem(SESSION_KEY)
    }
  } catch { /* private mode — session stays memory-only */ }
}

function loadPrefs(account: AccountRecord, key: Uint8Array): AccountPrefs {
  if (!account.prefsBlob) return {}
  try {
    return decryptJson<AccountPrefs>(key, account.prefsBlob)
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
      authError: null,
      prefs: {},
      showSignIn: false,
      showSettings: false,
      showAnalytics: false,

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

      signUp: async (username, displayName, password, rememberMe, options) => {
        const name = username.trim()
        if (name.length < 2) { set({ authError: 'Username must be at least 2 characters' }); return false }
        if (password.length < 8) { set({ authError: 'Password must be at least 8 characters' }); return false }
        if (!accountStorageAvailable()) { set({ authError: 'Device storage unavailable — accounts need IndexedDB' }); return false }

        const role = options?.role
        let instructorUnlockedAt: number | undefined
        if (role === 'instructor' && options?.accessCode?.trim()) {
          if (!configuredInstructorAccessHash()) {
            set({ authError: 'Instructor unlock is not configured on this build (missing access hash)' })
            return false
          }
          if (!verifyInstructorAccessCode(options.accessCode)) {
            set({ authError: 'Invalid instructor access code' })
            return false
          }
          instructorUnlockedAt = Date.now()
        }

        const existing = await getAccountByUsername(name)
        if (existing) { set({ authError: 'That username already exists on this device' }); return false }

        const kdfParams = makeKdfParams()
        const key = deriveKey(password, kdfParams)
        const record: AccountRecord = {
          schemaVersion: 1,
          id: makeId(),
          username: name,
          usernameLower: name.toLowerCase(),
          displayName: displayName.trim() || name,
          createdAt: Date.now(),
          kdfParams,
          checkBlob: makeCheckBlob(key),
          ...(role ? { role } : {}),
          ...(instructorUnlockedAt !== undefined ? { instructorUnlockedAt } : {}),
        }
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save the profile to device storage' }); return false }

        persistSession(record, key, rememberMe)
        set({
          activeAccount: toActive(record),
          sessionKey: key, prefs: {}, authError: null, showSignIn: false,
        })
        return true
      },

      unlockInstructor: async (accessCode) => {
        const { activeAccount } = get()
        if (!activeAccount || activeAccount.role !== 'instructor') {
          set({ authError: 'Sign in as an instructor to unlock' })
          return false
        }
        if (activeAccount.instructorUnlocked) {
          set({ authError: null })
          return true
        }
        if (!configuredInstructorAccessHash()) {
          set({ authError: 'Instructor unlock is not configured on this build (missing access hash)' })
          return false
        }
        if (!verifyInstructorAccessCode(accessCode)) {
          set({ authError: 'Invalid instructor access code' })
          return false
        }
        const record = await getAccountByUsername(activeAccount.username)
        if (!record || record.role !== 'instructor') {
          set({ authError: 'Instructor profile not found on this device' })
          return false
        }
        record.instructorUnlockedAt = Date.now()
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save unlock status to device storage' }); return false }
        set({
          activeAccount: toActive(record),
          authError: null,
        })
        return true
      },

      signIn: async (username, password, rememberMe) => {
        const record = await getAccountByUsername(username)
        if (!record) { set({ authError: 'No profile with that username on this device' }); return false }
        const key = deriveKey(password, record.kdfParams)
        if (!verifyCheckBlob(key, record.checkBlob)) {
          set({ authError: 'Incorrect password' })
          return false
        }
        persistSession(record, key, rememberMe)
        set({
          activeAccount: toActive(record),
          sessionKey: key, prefs: loadPrefs(record, key), authError: null, showSignIn: false,
        })
        return true
      },

      signOut: () => {
        try { resolveStorage()?.removeItem(SESSION_KEY) } catch { /* noop */ }
        set({ activeAccount: null, sessionKey: null, prefs: {}, showSettings: false, showAnalytics: false })
      },

      restoreRememberedSession: async () => {
        const storage = resolveStorage()
        if (!storage) return
        let stored: { v?: number; username?: string; key?: string } | null = null
        try {
          const raw = storage.getItem(SESSION_KEY)
          stored = raw ? JSON.parse(raw) : null
        } catch {
          return
        }
        if (!stored || stored.v !== 1 || !stored.username || !stored.key) return
        const record = await getAccountByUsername(stored.username)
        if (!record) return
        const key = fromBase64(stored.key)
        if (!verifyCheckBlob(key, record.checkBlob)) return
        set({
          activeAccount: toActive(record),
          sessionKey: key, prefs: loadPrefs(record, key),
        })
      },

      savePrefs: async (prefs) => {
        const { activeAccount, sessionKey } = get()
        if (!activeAccount || !sessionKey) return
        const record = await getAccountByUsername(activeAccount.username)
        if (!record) return
        record.prefsBlob = encryptJson(sessionKey, prefs)
        await putAccount(record)
        set({ prefs })
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
