// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ClassroomHome } from '@/components/classroom/ClassroomHome'
import { InstructorHub } from '@/components/classroom/InstructorHub'
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

  it('does not show the unlock section on home signup (unlock is on Start a training class)', async () => {
    render(<ClassroomHome />)
    const createBtn = screen.queryByRole('button', { name: 'Need an account? Create one' })
    if (createBtn) fireEvent.click(createBtn)
    fireEvent.click(screen.getByRole('button', { name: 'Instructor' }))
    expect(screen.queryByTestId('instructor-unlock-section')).toBeNull()
  })

  it('shows continue links after a classroom account is signed in', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
        instructorUnlocked: true,
      },
      sessionKey: new Uint8Array(32),
    })
    render(<ClassroomHome />)
    expect(screen.getByRole('link', { name: /Continue to instructor classrooms/i })).toBeTruthy()
    expect(screen.queryByTestId('classroom-auth')).toBeNull()
  })
})

describe('InstructorHub unlock gate', () => {
  it('prompts for access code before create/saved actions', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
        instructorUnlocked: false,
      },
      sessionKey: new Uint8Array(32),
    })
    render(<InstructorHub onStartLive={() => {}} />)
    expect(screen.getByText('Start a training class')).toBeTruthy()
    expect(screen.getByTestId('instructor-unlock-section')).toBeTruthy()
    expect(screen.getByPlaceholderText('Insert access code here')).toBeTruthy()
    expect(screen.queryByTestId('create-new-class')).toBeNull()
    expect(screen.queryByTestId('access-saved-classes')).toBeNull()
  })

  it('shows create new class and access saved classes after unlock', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
        instructorUnlocked: true,
      },
      sessionKey: new Uint8Array(32),
    })
    render(<InstructorHub onStartLive={() => {}} />)
    expect(screen.queryByTestId('instructor-unlock-section')).toBeNull()
    expect(screen.getByTestId('create-new-class')).toBeTruthy()
    expect(screen.getByTestId('access-saved-classes')).toBeTruthy()
  })
})
