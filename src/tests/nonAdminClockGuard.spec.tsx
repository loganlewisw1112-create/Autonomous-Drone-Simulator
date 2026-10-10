// @vitest-environment jsdom
//
// Regression guard for the "admin has no session clock" change: everything that is NOT a
// verified admin profile must keep today's public-demo clock exactly (30 min wall, 10 min idle,
// 15 min debrief, same sessionStorage key and record shape). The profiles below are built through
// the real auth flow (real signature verification, real pass-to-profile binding), not by setting
// `isAdmin` by hand, so a loosened admin check would turn these red.
import 'fake-indexeddb/auto'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ADMIN_PASS_PREFIX, adminPassSigningBytes, bytesToBase64Url } from '../../server/adminPassVerify.mjs'
import { getAccountByUsername, putAccount } from '@/account/accountDb'

vi.mock('@/hooks/useDeviceMode', () => ({ useDeviceMode: () => 'desktop', useIsTablet: () => false }))
vi.mock('@/licensing/usagePolicy', async (importActual) => {
  const actual = await importActual<typeof import('@/licensing/usagePolicy')>()
  return { ...actual, USAGE_POLICY: actual.buildUsagePolicy('public_demo') }
})

// Throwaway signing key: the real one never appears in a test.
const trusted = ed25519.keygen()
vi.mock('@/account/adminKeys', () => ({
  get TRUSTED_ADMIN_PUBLIC_KEYS() { return [bytesToBase64Url(trusted.publicKey)] },
  get REVOKED_PASS_IDS() { return [] },
}))
vi.mock('@/account/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/account/crypto')>()
  return {
    ...actual,
    deriveKey: (password: string, params: Parameters<typeof actual.deriveKey>[1]) =>
      actual.deriveKey(password, { ...params, iterations: Math.min(params.iterations, 1_000) }),
  }
})

const { UsagePolicyGate, useUsagePolicy } = await import('@/licensing/UsagePolicyGate')
const { useAuthStore } = await import('@/store/authStore')

const MINUTE = 60_000
const START = Date.UTC(2026, 9, 10, 12, 0, 0)
const STORAGE_KEY = 'drone-sim-usage-clock-v1:public_demo:rolling'
const OWNER = 'owner@example.com'

function issuePass(email: string): string {
  const payload = { v: 1, email, name: 'Owner', passId: `adm-${email}`, issuedAt: Date.now() - 1000 }
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), trusted.secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}

const auth = () => useAuthStore.getState()
async function newProfile(username: string, password: string) {
  await auth().signUp(username, '', password)
  auth().acknowledgeRecoveryCode()
}

type Setup = () => Promise<void>
const NON_ADMIN_PROFILES: Array<[string, Setup]> = [
  ['no profile at all', async () => { /* signed out */ }],
  ['a profile without a pass', async () => { await newProfile('student', 'student-pass-1') }],
  ['a profile whose stored pass was tampered with', async () => {
    await newProfile(OWNER, 'tamper-pass-1')
    expect(await auth().applyAdminPass(issuePass(OWNER))).toBe(true)
    auth().signOut()
    const record = await getAccountByUsername(OWNER)
    const [prefix, , sig] = record!.adminPass!.split('.')
    const forged = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
      v: 1, email: 'attacker@example.com', name: 'X', passId: 'adm-x', issuedAt: Date.now(),
    })))
    await putAccount({ ...record!, adminPass: `${prefix}.${forged}.${sig}` })
    expect(await auth().signIn(OWNER, 'tamper-pass-1')).toBe(true)
  }],
  ['a profile holding a genuine pass issued to a different email', async () => {
    await newProfile('copycat', 'copycat-pass-1')
    auth().signOut()
    const record = await getAccountByUsername('copycat')
    await putAccount({ ...record!, adminPass: issuePass(OWNER) })
    expect(await auth().signIn('copycat', 'copycat-pass-1')).toBe(true)
  }],
]

let lastPolicy: ReturnType<typeof useUsagePolicy> | null = null
function Probe() {
  lastPolicy = useUsagePolicy()
  return <div data-testid="probe" />
}
const mount = () => render(<UsagePolicyGate><Probe /></UsagePolicyGate>)
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
const bannerText = () => screen.getByTestId('usage-policy-banner').textContent ?? ''
const storedClock = () => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as
  { firstSeenAt: number; lastActivityAt: number; debriefStartedAt: number | null } | null

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  sessionStorage.clear()
  lastPolicy = null
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
    pendingRecoveryCode: null, pendingRecoveryNewAccount: false,
  })
})

afterEach(() => {
  vi.useRealTimers()
  sessionStorage.clear()
  useAuthStore.setState({ activeAccount: null })
})

// Account setup uses real timers (async crypto / IndexedDB); the clock under test is faked after it.
function startClock() {
  vi.useFakeTimers()
  vi.setSystemTime(START)
}

describe('control: the harness really can produce an admin', () => {
  it('a genuine pass on the profile with the matching email is admin and has no countdown', async () => {
    await newProfile(OWNER, 'owner-pass-1')
    expect(await auth().applyAdminPass(issuePass(OWNER))).toBe(true)
    expect(auth().activeAccount?.isAdmin).toBe(true)
    startClock()
    mount()
    expect(lastPolicy).toMatchObject({ phase: 'active', remainingMs: null, adminOverride: true })
    expect(bannerText()).not.toMatch(/remaining/)
  }, 20000)
})

describe.each(NON_ADMIN_PROFILES)('public demo clock for %s', (_label, setup) => {
  beforeEach(async () => {
    await setup()
    expect(auth().activeAccount?.isAdmin).toBeFalsy()
    startClock()
  }, 20000)

  it('keeps the countdown banner and no admin marker', () => {
    mount()
    expect(bannerText()).toBe('PUBLIC DEMO · session: 30 min remaining · idle timeout: 10 min remaining')
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true, remainingMs: 10 * MINUTE })
    expect(lastPolicy?.adminOverride).toBeUndefined()
    expect(screen.queryByTestId('admin-override-policy')).toBeNull()
  })

  it('debriefs at 30 minutes of wall time even with continuous activity', () => {
    mount()
    for (let i = 0; i < 5; i += 1) {
      advance(5 * MINUTE)
      act(() => { window.dispatchEvent(new Event('pointerdown')) })
    }
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    advance(5 * MINUTE + 1000)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
    expect(bannerText()).toMatch(/^DEBRIEF ONLY/)
  })

  it('debriefs after 10 minutes idle', () => {
    mount()
    advance(9 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'active', canBeginNewActivity: true })
    advance(2 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
  })

  it('expires 15 minutes after the debrief starts', () => {
    mount()
    advance(11 * MINUTE)
    expect(lastPolicy?.phase).toBe('debrief')
    advance(14 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
    advance(2 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'expired', canBeginNewActivity: false })
    expect(bannerText()).toMatch(/^DEMO WINDOW ENDED/)
  })

  it('persists the clock under the same sessionStorage key and record shape', () => {
    mount()
    expect(Object.keys(storedClock() ?? {}).sort()).toEqual(['debriefStartedAt', 'firstSeenAt', 'lastActivityAt'])
    expect(storedClock()).toEqual({ firstSeenAt: START, lastActivityAt: START, debriefStartedAt: null })
    advance(11 * MINUTE)
    expect(storedClock()?.firstSeenAt).toBe(START)
    // Stamped by the next ticker poll after the idle limit passes (not before it, not after we looked).
    expect(storedClock()?.debriefStartedAt).toBeGreaterThanOrEqual(START + 10 * MINUTE)
    expect(storedClock()?.debriefStartedAt).toBeLessThanOrEqual(START + 11 * MINUTE)
  })

  it('a stored, already-expired clock is honoured on mount (no fresh window)', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      firstSeenAt: START - 3 * 60 * MINUTE, lastActivityAt: START - 3 * 60 * MINUTE, debriefStartedAt: START - 2 * 60 * MINUTE,
    }))
    mount()
    expect(lastPolicy).toMatchObject({ phase: 'expired', canBeginNewActivity: false })
  })
})

describe('an admin who signs out', () => {
  it('leaves a finite, freshly started clock that then runs to debrief and expiry', async () => {
    await newProfile(OWNER, 'owner-pass-1')
    expect(await auth().applyAdminPass(issuePass(OWNER))).toBe(true)
    startClock()
    mount()
    advance(2 * 60 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'active', remainingMs: null, adminOverride: true })

    const at = Date.now()
    act(() => { auth().signOut() })
    expect(auth().activeAccount).toBeNull()
    expect(lastPolicy?.adminOverride).toBeUndefined()
    expect(bannerText()).toBe('PUBLIC DEMO · session: 30 min remaining · idle timeout: 10 min remaining')
    expect(storedClock()).toEqual({ firstSeenAt: at, lastActivityAt: at, debriefStartedAt: null })

    advance(11 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'debrief', canBeginNewActivity: false })
    advance(16 * MINUTE)
    expect(lastPolicy).toMatchObject({ phase: 'expired', canBeginNewActivity: false })
  }, 20000)
})
