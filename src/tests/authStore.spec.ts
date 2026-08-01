// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { useAuthStore, getActiveOperator } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'
import { exportBackup, putAccount, putMission } from '@/account/accountDb'
import { deriveKey, encryptLegacyJson, makeKdfParams } from '@/account/crypto'
import { CHECK_MARKER } from '@/account/types'

const SESSION_KEY = 'drone-sim:session:v1'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
  })
})

describe('authStore', () => {
  it('signUp creates a profile, signs in, and validates inputs', async () => {
    const { signUp } = useAuthStore.getState()
    expect(await signUp('x', '', 'longenough')).toBe(false)   // short username
    expect(await signUp('logan', '', 'short')).toBe(false)    // short password
    expect(await signUp('logan', 'Logan LW', 'longenough')).toBe(true)
    const state = useAuthStore.getState()
    expect(state.activeAccount?.username).toBe('logan')
    expect(state.activeAccount?.displayName).toBe('Logan LW')
    expect(state.sessionKey).not.toBeNull()
    // duplicate username rejected
    expect(await signUp('LOGAN', '', 'longenough')).toBe(false)
  })

  // Three real PBKDF2-310k derivations run synchronously in this one test (signUp,
  // a wrong-password signIn, a correct signIn) — each is genuinely CPU-bound, so a
  // shared/slow CI runner can exceed the 5s default. Widen the ceiling; this doesn't
  // change how fast the crypto actually runs, just the margin before it's flagged.
  it('signIn accepts the right password and rejects the wrong one', async () => {
    await useAuthStore.getState().signUp('op1', 'Operator One', 'password123')
    useAuthStore.getState().signOut()
    expect(useAuthStore.getState().activeAccount).toBeNull()

    expect(await useAuthStore.getState().signIn('op1', 'wrong-password')).toBe(false)
    expect(useAuthStore.getState().authError).toBe('Incorrect password')
    expect(await useAuthStore.getState().signIn('op1', 'password123')).toBe(true)
    expect(useAuthStore.getState().activeAccount?.displayName).toBe('Operator One')
  }, 20000)

  it('removes a legacy persisted raw key without restoring the session', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, username: 'op2', key: 'raw-key' }))
    useAuthStore.getState().clearLegacyPersistedSession()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
    expect(useAuthStore.getState().activeAccount).toBeNull()
  })

  it('sign-up never persists password-derived material', async () => {
    await useAuthStore.getState().signUp('op3', '', 'password123')
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('opens a failed legacy migration read-only without deleting exportable data', async () => {
    const kdfParams = { ...makeKdfParams(), iterations: 1000 }
    const key = deriveKey('password123', kdfParams)
    const foreign = deriveKey('not-the-account-key', { ...makeKdfParams(), iterations: 1000 })
    await putAccount({
      schemaVersion: 1,
      id: 'readonly-profile',
      username: 'readonly',
      usernameLower: 'readonly',
      displayName: 'Read Only',
      createdAt: 1000,
      kdfParams,
      checkBlob: encryptLegacyJson(key, { check: CHECK_MARKER }),
    })
    await putMission({
      schemaVersion: 2,
      id: 'corrupt-mission',
      accountId: 'readonly-profile',
      updatedAt: 1000,
      blob: encryptLegacyJson(foreign, { corrupt: true }),
    })

    expect(await useAuthStore.getState().signIn('readonly', 'password123')).toBe(true)
    expect(useAuthStore.getState().storageReadOnly).toBe(true)
    expect(useAuthStore.getState().authError).toMatch(/read-only/i)
    expect(await exportBackup('readonly-profile')).not.toBeNull()
  })

  it('chain-of-custody events pick up the active operator and fall back when signed out', async () => {
    useDroneStore.getState().emitEvent({ eventType: 'mission_start', droneId: 'drone-1', payload: {} })
    let events = useDroneStore.getState().events
    expect(events[events.length - 1].operatorId).toBe('operator-1')

    await useAuthStore.getState().signUp('fieldop', 'Field Op', 'password123')
    expect(getActiveOperator().operatorId).toBe('operator:fieldop')
    useDroneStore.getState().emitEvent({ eventType: 'mission_start', droneId: 'drone-1', payload: {} })
    events = useDroneStore.getState().events
    expect(events[events.length - 1].operatorId).toBe('operator:fieldop')
  })
})
