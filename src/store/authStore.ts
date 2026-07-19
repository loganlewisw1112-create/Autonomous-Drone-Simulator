import { create } from 'zustand'
import { devtools, subscribeWithSelector } from 'zustand/middleware'
import {
  deriveKey, encryptJson, decryptJson, makeCheckBlob, verifyCheckBlob, makeKdfParams, makeId, toBase64, fromBase64,
} from '@/account/crypto'
import {
  accountStorageAvailable, deleteAccount, getAccountByUsername, listAccounts, putAccount,
} from '@/account/accountDb'
import type { AccountPrefs, AccountRecord } from '@/account/types'

// Local-only auth. The derived AES key lives in memory for the session; with
// remember-me it is additionally kept in localStorage so a reload stays signed
// in on a personal device (tradeoff surfaced in the sign-in UI).

const SESSION_KEY = 'drone-sim:session:v1'
const LAST_ACCOUNT_KEY = 'drone-sim:active-account:v1'

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

  signUp: (username: string, displayName: string, password: string, rememberMe: boolean) => Promise<boolean>
  signIn: (username: string, password: string, rememberMe: boolean) => Promise<boolean>
  signOut: () => void
  restoreRememberedSession: () => Promise<void>
  savePrefs: (prefs: AccountPrefs) => Promise<void>
}

function persistSession(account: AccountRecord, key: Uint8Array, rememberMe: boolean) {
  const storage = resolveStorage()
  if (!storage) return
  try {
    storage.setItem(LAST_ACCOUNT_KEY, account.username)
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
      setShowSettings: (show) => set({ showSettings: show }),
      setShowAnalytics: (show) => set({ showAnalytics: show }),
      clearAuthError: () => set({ authError: null }),

      signUp: async (username, displayName, password, rememberMe) => {
        const name = username.trim()
        if (name.length < 2) { set({ authError: 'Username must be at least 2 characters' }); return false }
        if (password.length < 8) { set({ authError: 'Password must be at least 8 characters' }); return false }
        if (!accountStorageAvailable()) { set({ authError: 'Device storage unavailable — accounts need IndexedDB' }); return false }
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
        }
        const ok = await putAccount(record)
        if (!ok) { set({ authError: 'Could not save the profile to device storage' }); return false }

        persistSession(record, key, rememberMe)
        set({
          activeAccount: { id: record.id, username: record.username, displayName: record.displayName },
          sessionKey: key, prefs: {}, authError: null, showSignIn: false,
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
          activeAccount: { id: record.id, username: record.username, displayName: record.displayName },
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
          activeAccount: { id: record.id, username: record.username, displayName: record.displayName },
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
