// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { useAuthStore, getActiveOperator } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'

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
    expect(await signUp('x', '', 'longenough', false)).toBe(false)   // short username
    expect(await signUp('logan', '', 'short', false)).toBe(false)    // short password
    expect(await signUp('logan', 'Logan LW', 'longenough', false)).toBe(true)
    const state = useAuthStore.getState()
    expect(state.activeAccount?.username).toBe('logan')
    expect(state.activeAccount?.displayName).toBe('Logan LW')
    expect(state.sessionKey).not.toBeNull()
    // duplicate username rejected
    expect(await signUp('LOGAN', '', 'longenough', false)).toBe(false)
  })

  // Three real PBKDF2-310k derivations run synchronously in this one test (signUp,
  // a wrong-password signIn, a correct signIn) — each is genuinely CPU-bound, so a
  // shared/slow CI runner can exceed the 5s default. Widen the ceiling; this doesn't
  // change how fast the crypto actually runs, just the margin before it's flagged.
  it('signIn accepts the right password and rejects the wrong one', async () => {
    await useAuthStore.getState().signUp('op1', 'Operator One', 'password123', false)
    useAuthStore.getState().signOut()
    expect(useAuthStore.getState().activeAccount).toBeNull()

    expect(await useAuthStore.getState().signIn('op1', 'wrong-password', false)).toBe(false)
    expect(useAuthStore.getState().authError).toBe('Incorrect password')
    expect(await useAuthStore.getState().signIn('op1', 'password123', false)).toBe(true)
    expect(useAuthStore.getState().activeAccount?.displayName).toBe('Operator One')
  }, 20000)

  it('remember-me persists a restorable session; signOut clears it', async () => {
    await useAuthStore.getState().signUp('op2', '', 'password123', true)
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull()

    // simulate reload: wipe in-memory state, then restore
    useAuthStore.setState({ activeAccount: null, sessionKey: null })
    await useAuthStore.getState().restoreRememberedSession()
    expect(useAuthStore.getState().activeAccount?.username).toBe('op2')

    useAuthStore.getState().signOut()
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('without remember-me nothing password-derived touches localStorage', async () => {
    await useAuthStore.getState().signUp('op3', '', 'password123', false)
    expect(localStorage.getItem(SESSION_KEY)).toBeNull()
  })

  it('chain-of-custody events pick up the active operator and fall back when signed out', async () => {
    useDroneStore.getState().emitEvent({ eventType: 'mission_start', droneId: 'drone-1', payload: {} })
    let events = useDroneStore.getState().events
    expect(events[events.length - 1].operatorId).toBe('operator-1')

    await useAuthStore.getState().signUp('fieldop', 'Field Op', 'password123', false)
    expect(getActiveOperator().operatorId).toBe('operator:fieldop')
    useDroneStore.getState().emitEvent({ eventType: 'mission_start', droneId: 'drone-1', payload: {} })
    events = useDroneStore.getState().events
    expect(events[events.length - 1].operatorId).toBe('operator:fieldop')
  })
})
