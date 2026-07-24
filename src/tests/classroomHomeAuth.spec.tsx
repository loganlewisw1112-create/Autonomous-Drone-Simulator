// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, render, screen } from '@testing-library/react'
import { ClassroomHome } from '@/components/classroom/ClassroomHome'
import { useAuthStore } from '@/store/authStore'
import { hashInstructorAccessCode } from '@/account/instructorAccess'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
    storageAvailable: true,
  })
  vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', hashInstructorAccessCode('home-test'))
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('ClassroomHome auth', () => {
  it('shows signup/signin with student/instructor role picker when signed out', () => {
    render(<ClassroomHome />)
    expect(screen.getByTestId('classroom-auth')).toBeTruthy()
    expect(screen.getByTestId('classroom-role-picker')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Student' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Instructor' })).toBeTruthy()
  })

  it('shows continue links after a classroom account is signed in', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
      },
      sessionKey: new Uint8Array(32),
    })
    render(<ClassroomHome />)
    expect(screen.getByRole('link', { name: /Continue to instructor classrooms/i })).toBeTruthy()
    expect(screen.queryByTestId('classroom-auth')).toBeNull()
  })
})
