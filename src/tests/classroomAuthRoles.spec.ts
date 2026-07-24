// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { useAuthStore } from '@/store/authStore'
import { hashInstructorAccessCode } from '@/account/instructorAccess'

const ACCESS_CODE = 'phase1-agency-code'
const ACCESS_HASH = hashInstructorAccessCode(ACCESS_CODE)

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
  })
  vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', ACCESS_HASH)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('authStore classroom roles', () => {
  it('creates a student account without an access code', async () => {
    const ok = await useAuthStore.getState().signUp(
      'student1', 'Student One', 'password123', false, { role: 'student' },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBe('student')
  }, 20000)

  it('creates an instructor account without unlock; unlock finishes later', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach1', 'Instructor', 'password123', false,
      { role: 'instructor' },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
  }, 20000)

  it('unlocks an instructor when the access code matches the build hash', async () => {
    await useAuthStore.getState().signUp(
      'teach1b', 'Instructor', 'password123', false,
      { role: 'instructor' },
    )
    const ok = await useAuthStore.getState().unlockInstructor(ACCESS_CODE)
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('rejects unlock with a wrong access code', async () => {
    await useAuthStore.getState().signUp(
      'teach2', 'Instructor', 'password123', false,
      { role: 'instructor' },
    )
    const ok = await useAuthStore.getState().unlockInstructor('nope')
    expect(ok).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/Invalid instructor access code/)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(false)
  }, 20000)

  it('rejects unlock when the build has no access hash', async () => {
    await useAuthStore.getState().signUp(
      'teach3', 'Instructor', 'password123', false,
      { role: 'instructor' },
    )
    vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', '')
    const ok = await useAuthStore.getState().unlockInstructor(ACCESS_CODE)
    expect(ok).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/not configured/)
  }, 20000)

  it('can still unlock at signup when an access code is supplied', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach4', 'Instructor', 'password123', false,
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('restores unlock status on remember-me session', async () => {
    await useAuthStore.getState().signUp(
      'teach5', 'Instructor', 'password123', true,
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    useAuthStore.setState({ activeAccount: null, sessionKey: null })
    await useAuthStore.getState().restoreRememberedSession()
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
    expect(useAuthStore.getState().activeAccount?.instructorUnlocked).toBe(true)
  }, 20000)

  it('keeps solo signUp without a role for Mobile/Windows compatibility', async () => {
    const ok = await useAuthStore.getState().signUp('solo', 'Solo', 'password123', false)
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBeUndefined()
  }, 20000)
})
