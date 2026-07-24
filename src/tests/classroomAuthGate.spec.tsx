// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { render, screen, cleanup } from '@testing-library/react'
import { ClassroomAuthGate } from '@/components/classroom/ClassroomAuthGate'
import { useAuthStore } from '@/store/authStore'
import { hashInstructorAccessCode } from '@/account/instructorAccess'

const ACCESS_HASH = hashInstructorAccessCode('gate-test-code')

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
    storageAvailable: true,
  })
  vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', ACCESS_HASH)
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('ClassroomAuthGate', () => {
  it('shows the auth panel when signed out', () => {
    render(
      <ClassroomAuthGate requiredRole="student">
        <div data-testid="live-child">live</div>
      </ClassroomAuthGate>,
    )
    expect(screen.getByTestId('classroom-auth')).toBeTruthy()
    expect(screen.queryByTestId('live-child')).toBeNull()
  })

  it('renders children when the signed-in role matches', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'a1', username: 's1', displayName: 'Student', role: 'student',
      },
      sessionKey: new Uint8Array(32),
    })
    render(
      <ClassroomAuthGate requiredRole="student">
        <div data-testid="live-child">live</div>
      </ClassroomAuthGate>,
    )
    expect(screen.getByTestId('live-child')).toBeTruthy()
    expect(screen.queryByTestId('classroom-auth')).toBeNull()
  })

  it('blocks a student account from the instructor path', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'a1', username: 's1', displayName: 'Student', role: 'student',
      },
      sessionKey: new Uint8Array(32),
    })
    render(
      <ClassroomAuthGate requiredRole="instructor">
        <div data-testid="live-child">live</div>
      </ClassroomAuthGate>,
    )
    expect(screen.getByTestId('classroom-wrong-role')).toBeTruthy()
    expect(screen.queryByTestId('live-child')).toBeNull()
  })

  it('blocks solo operator accounts from classroom instructor path', () => {
    useAuthStore.setState({
      activeAccount: {
        id: 'a1', username: 'op', displayName: 'Operator',
      },
      sessionKey: new Uint8Array(32),
    })
    render(
      <ClassroomAuthGate requiredRole="instructor">
        <div data-testid="live-child">live</div>
      </ClassroomAuthGate>,
    )
    expect(screen.getByTestId('classroom-wrong-role')).toBeTruthy()
  })
})
