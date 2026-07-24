// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ClassroomHome } from '@/components/classroom/ClassroomHome'
import { ClassSetup } from '@/components/classroom/ClassSetup'
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
    expect(screen.getByRole('link', { name: /Continue to Start a training class/i })).toBeTruthy()
    expect(screen.queryByTestId('classroom-auth')).toBeNull()
  })
})

describe('ClassSetup unlock gate', () => {
  it('shows Insert access code here on Start a training class before unlock', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
        instructorUnlocked: false,
      },
      sessionKey: new Uint8Array(32),
    })
    render(<ClassSetup onOpenSaved={() => {}} />)
    expect(screen.getByText('Start a training class')).toBeTruthy()
    expect(screen.getByTestId('instructor-unlock-section')).toBeTruthy()
    expect(screen.getByPlaceholderText('Insert access code here')).toBeTruthy()
    expect(screen.queryByTestId('create-new-class')).toBeNull()
    expect(screen.queryByLabelText('Scenario')).toBeNull()
  })

  it('reveals scenario Create class and Access saved after unlock', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'i1', username: 'teach', displayName: 'Teacher', role: 'instructor',
        instructorUnlocked: true,
      },
      sessionKey: new Uint8Array(32),
    })
    render(<ClassSetup onOpenSaved={() => {}} />)
    expect(screen.queryByTestId('instructor-unlock-section')).toBeNull()
    expect(screen.getByTestId('create-new-class')).toBeTruthy()
    expect(screen.getByTestId('access-saved-classes')).toBeTruthy()
    expect(screen.getByLabelText('Scenario')).toBeTruthy()
  })
})
