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

  it('creates an instructor account when the access code matches the build hash', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach1', 'Instructor', 'password123', false,
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
  }, 20000)

  it('rejects instructor signup with a wrong access code', async () => {
    const ok = await useAuthStore.getState().signUp(
      'teach2', 'Instructor', 'password123', false,
      { role: 'instructor', accessCode: 'nope' },
    )
    expect(ok).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/Invalid instructor access code/)
    expect(useAuthStore.getState().activeAccount).toBeNull()
  }, 20000)

  it('rejects instructor signup when the build has no access hash', async () => {
    vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', '')
    const ok = await useAuthStore.getState().signUp(
      'teach3', 'Instructor', 'password123', false,
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    expect(ok).toBe(false)
    expect(useAuthStore.getState().authError).toMatch(/not configured/)
  }, 20000)

  it('restores role on remember-me session', async () => {
    await useAuthStore.getState().signUp(
      'teach4', 'Instructor', 'password123', true,
      { role: 'instructor', accessCode: ACCESS_CODE },
    )
    useAuthStore.setState({ activeAccount: null, sessionKey: null })
    await useAuthStore.getState().restoreRememberedSession()
    expect(useAuthStore.getState().activeAccount?.role).toBe('instructor')
  }, 20000)

  it('keeps solo signUp without a role for Mobile/Windows compatibility', async () => {
    const ok = await useAuthStore.getState().signUp('solo', 'Solo', 'password123', false)
    expect(ok).toBe(true)
    expect(useAuthStore.getState().activeAccount?.role).toBeUndefined()
  }, 20000)
})
