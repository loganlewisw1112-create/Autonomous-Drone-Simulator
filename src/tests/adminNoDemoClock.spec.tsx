// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useDeviceMode', () => ({ useDeviceMode: () => 'desktop', useIsTablet: () => false }))
vi.mock('@/licensing/usagePolicy', async (importActual) => {
  const actual = await importActual<typeof import('@/licensing/usagePolicy')>()
  return { ...actual, USAGE_POLICY: actual.buildUsagePolicy('public_demo') }
})

import { UsagePolicyGate, useUsagePolicy } from '@/licensing/UsagePolicyGate'
import { ADMIN_OVERRIDE_LABEL } from '@/account/adminOverride'
import { useAuthStore } from '@/store/authStore'

const MINUTE = 60_000
const START = Date.UTC(2026, 9, 10, 12, 0, 0)
const STORAGE_KEY = 'drone-sim-usage-clock-v1:public_demo:rolling'

const ADMIN = { id: 'a1', username: 'owner', displayName: 'Owner', isAdmin: true, adminEmail: 'owner@example.com' }
const STUDENT = { id: 's1', username: 'student', displayName: 'Student' }

type Account = NonNullable<ReturnType<typeof useAuthStore.getState>['activeAccount']>
const signIn = (account: typeof ADMIN | typeof STUDENT) =>
  act(() => { useAuthStore.setState({ activeAccount: account as unknown as Account }) })
const signOut = () => act(() => { useAuthStore.setState({ activeAccount: null }) })
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

let lastPolicy: ReturnType<typeof useUsagePolicy> | null = null
function Probe() {
  lastPolicy = useUsagePolicy()
  return <div data-testid="probe" />
}

interface StoredClock { firstSeenAt: number; lastActivityAt: number; debriefStartedAt: number | null }
const bannerText = () => screen.getByTestId('usage-policy-banner').textContent ?? ''
const storedClock = () => {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  return raw ? JSON.parse(raw) as StoredClock : null
}
const seedClock = (clock: StoredClock) => sessionStorage.setItem(STORAGE_KEY, JSON.stringify(clock))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  sessionStorage.clear()
  lastPolicy = null
  useAuthStore.setState({ activeAccount: null })
})

afterEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
  useAuthStore.setState({ activeAccount: null })
})

function mount() {
  return render(<UsagePolicyGate><Probe /></UsagePolicyGate>)
}

describe('public demo gate: admin has no session clock', () => {
  it('sanity: a non-admin still gets the countdown banner and the debrief after 30 minutes', () => {
    signIn(STUDENT)
    mount()
    expect(bannerText()).toBe('PUBLIC DEMO · session: 30 min remaining · idle timeout: 10 min remaining')
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    expect(lastPolicy?.adminOverride).toBeUndefined()
    advance(31 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
    expect(bannerText()).toMatch(/^DEBRIEF ONLY/)
  })

  it('admin: no countdown, phase active and new activity allowed after >30 min wall and >10 min idle', () => {
    signIn(ADMIN)
    mount()
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
    expect(bannerText()).toBe(`PUBLIC DEMO · ${ADMIN_OVERRIDE_LABEL}: no session time limit`)
    expect(screen.getByTestId('admin-override-policy').textContent).toContain(ADMIN_OVERRIDE_LABEL)

    // 45 minutes with zero user activity: past both the 30 min wall clock and the 10 min idle limit.
    advance(45 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
    const text = bannerText()
    expect(text).toBe(`PUBLIC DEMO · ${ADMIN_OVERRIDE_LABEL}: no session time limit`)
    expect(text).not.toMatch(/remaining|DEBRIEF|ENDED|idle timeout/)
    expect(screen.getByTestId('usage-policy-banner').getAttribute('role')).toBe('status')

    // Hours later, still unlimited, and no debrief was ever stamped.
    advance(5 * 60 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null })
    expect(storedClock()?.debriefStartedAt ?? null).toBeNull()
  })

  it('admin: user activity does not change the unlimited state', () => {
    signIn(ADMIN)
    mount()
    advance(40 * MINUTE)
    act(() => { window.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
    expect(bannerText()).not.toMatch(/remaining/)
  })

  it('admin signing in after the window already hit debrief gets the unlimited state', () => {
    signIn(STUDENT)
    mount()
    advance(31 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
    expect(storedClock()?.debriefStartedAt).not.toBeNull()

    signIn(ADMIN)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
    expect(bannerText()).toBe(`PUBLIC DEMO · ${ADMIN_OVERRIDE_LABEL}: no session time limit`)
    expect(storedClock()?.debriefStartedAt ?? null).toBeNull()
  })

  it('admin signing in after the window fully expired (debrief elapsed) also gets the unlimited state', () => {
    signIn(STUDENT)
    mount()
    advance(31 * MINUTE)
    advance(16 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'expired', canBeginNewActivity: false })
    expect(bannerText()).toMatch(/^DEMO WINDOW ENDED/)

    signIn(ADMIN)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
    expect(bannerText()).not.toMatch(/ENDED|DEBRIEF/)
  })

  it('admin mounted on top of an already-expired stored clock is unlimited from the first render', () => {
    seedClock({ firstSeenAt: START - 3 * 60 * MINUTE, lastActivityAt: START - 3 * 60 * MINUTE, debriefStartedAt: START - 2 * 60 * MINUTE })
    signIn(ADMIN)
    mount()
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: null, adminOverride: true })
  })

  it('admin signing out starts a fresh 30 minute clock for the next non-admin, and persists it', () => {
    signIn(ADMIN)
    mount()
    advance(2 * 60 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'active', remainingMs: null })

    const signedOutAt = Date.now()
    signOut()
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    expect(lastPolicy?.adminOverride).toBeUndefined()
    expect(lastPolicy?.remainingMs).toBe(10 * MINUTE) // the idle limit is the nearer of the two
    expect(bannerText()).toBe('PUBLIC DEMO · session: 30 min remaining · idle timeout: 10 min remaining')
    expect(storedClock()).toEqual({ firstSeenAt: signedOutAt, lastActivityAt: signedOutAt, debriefStartedAt: null })

    // Keep interacting: the wall clock (not idle) now ends the window 30 min after sign-out.
    for (let i = 0; i < 5; i += 1) {
      advance(5 * MINUTE)
      act(() => { window.dispatchEvent(new Event('pointerdown')) })
    }
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    expect(bannerText()).toMatch(/^PUBLIC DEMO · session: 5 min remaining · idle timeout: \d+ min remaining$/)
    advance(6 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
  })

  it('an admin sign-out after the previous non-admin window had expired still restarts fresh', () => {
    signIn(STUDENT)
    mount()
    advance(31 * MINUTE)
    signIn(ADMIN)
    advance(10 * MINUTE)
    signOut()
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    expect(bannerText()).toBe('PUBLIC DEMO · session: 30 min remaining · idle timeout: 10 min remaining')
    expect(storedClock()?.debriefStartedAt ?? null).toBeNull()
  })

  it('while an admin is signed in the stored clock tracks "now", so a reload (which signs the admin out) is not born expired', () => {
    signIn(ADMIN)
    const { unmount } = mount()
    advance(3 * 60 * MINUTE)
    const stored = storedClock()
    expect(Date.now() - (stored?.firstSeenAt ?? 0)).toBeLessThanOrEqual(15_000)
    unmount()
    useAuthStore.setState({ activeAccount: null })
    render(<UsagePolicyGate><Probe /></UsagePolicyGate>)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    expect(bannerText()).toMatch(/^PUBLIC DEMO · session: \d+ min remaining/)
  })
})
