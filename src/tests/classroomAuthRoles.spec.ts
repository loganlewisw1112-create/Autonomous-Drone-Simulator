// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { useAuthStore } from '@/store/authStore'

const ACCESS_CODE = 'phase1-agency-code'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
  })
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configured: true, authenticated: false }),
    } as Response)
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    } as Response))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authStore classroom roles', () => {
  it('creates a student account without an access code', async () => {
    const ok = await useAuthStore.getState().signUp(
      'student1', 'Student One', 'password123', { role: 'student' },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBe('student')
  }, 20000)

  it('creates an instructor account without unlock; unlock finishes later', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach1', 'Instructor', 'password123',
      { role: 'instructor' },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
  }, 20000)

  it('requires unlock for instructors that never recorded instructorUnlockedAt', async () => {
    await useAuthStore.getState().signUp(
      'legacy-teach', 'Legacy', 'password123',
      { role: 'instructor' },
    )
    const { getAccountByUsername, putAccount } = await import('@/account/accountDb')
    const record = await getAccountByUsername('legacy-teach')
    expect(record).toBeTruthy()
    delete record!.instructorUnlockPending
    delete record!.instructorUnlockedAt
    await putAccount(record!)
    useAuthStore.setState({ activeAccount: null, sessionKey: null })
    const ok = await useAuthStore.getState().signIn('legacy-teach', 'password123')
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
  }, 20000)

  it('unlocks an instructor through an authenticated relay session', async () => {
    await useAuthStore.getState().signUp(
      'teach1b', 'Instructor', 'password123',
      { role: 'instructor' },
    )
    const ok = await useAuthStore.getState().unlockInstructor(ACCESS_CODE)
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('rejects an access code that violates the relay credential policy', async () => {
    await useAuthStore.getState().signUp(
      'teach2', 'Instructor', 'password123',
      { role: 'instructor' },
    )
    const ok = await useAuthStore.getState().unlockInstructor('nope')
    expect(ok).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/12–128 characters/)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
  }, 20000)

  it('fails closed when first-time relay provisioning has not occurred', async () => {
    await useAuthStore.getState().signUp(
      'teach3', 'Instructor', 'password123',
      { role: 'instructor' },
    )
    localStorage.clear()
    // Browser-local first-writer provisioning was removed; the relay administrator
    // must provision the scrypt credential before an instructor can unlock.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const ok = await useAuthStore.getState().unlockInstructor(ACCESS_CODE)
    expect(ok).toBe(false)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/relay unavailable/i)
    expect(localStorage.getItem('drone-sim:instructor-access-hash:v1')).toBeNull()
  }, 20000)

  it('can still unlock at signup when an access code is supplied', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach4', 'Instructor', 'password123',
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('restores unlock status after an explicit sign-in', async () => {
    await useAuthStore.getState().signUp(
      'teach5', 'Instructor', 'password123',
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    useAuthStore.getState().signOut()
    expect(useAuthStore.getState().activeAccount).toBeNull()
    await useAuthStore.getState().signIn('teach5', 'password123')
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('keeps solo signUp without a role for Mobile/Windows compatibility', async () => {
    const ok = await useAuthStore.getState().signUp('solo', 'Solo', 'password123')
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBeUndefined()
  }, 20000)
})
