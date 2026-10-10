// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { ed25519 } from '@noble/curves/ed25519.js'
import { ADMIN_PASS_PREFIX, adminPassSigningBytes, bytesToBase64Url } from '../../server/adminPassVerify.mjs'
import { getAccountByUsername, putAccount } from '@/account/accountDb'
import { getScenarioById } from '@/scenarios/registry'
import type { DroneState, ScenarioConfig, ScenarioVariantConfig } from '@/types'

// Throwaway signing key: the real one never appears in a test.
const trusted = ed25519.keygen()
const stranger = ed25519.keygen()
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

const { useAuthStore } = await import('@/store/authStore')
const { useDroneStore } = await import('@/store/droneStore')

function issuePass(email: string, secretKey = trusted.secretKey): string {
  const payload = { v: 1, email, name: 'Owner', passId: `adm-${email}`, issuedAt: Date.now() - 1000 }
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}

const DAY: ScenarioVariantConfig = {
  seed: 42, timeOfDay: 'day', season: 'summer', weatherSeverity: 0,
  commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
}

function parkedDrone(id: string, scenario: ScenarioConfig): DroneState {
  return {
    id, label: id.toUpperCase(), color: '#00d4ff', position: { ...scenario.startPosition },
    altitudeFt: 0, headingDeg: 0, speedMs: 0, batteryPct: 100, signalDbm: -55,
    missionState: 'idle', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0,
  }
}

function untrainedPreflight() {
  const coastal = getScenarioById('demo_sar_coastal')!.config
  useDroneStore.setState({
    scenario: coastal,
    scenarioVariant: DAY,
    authorizationCompletedSteps: [],
    events: [],
    lastHash: '0'.repeat(64),
    lifecycle: 'preflight',
    ui: { ...useDroneStore.getState().ui, isRunning: false },
    drones: [parkedDrone('uav-01', coastal)],
    launchPlan: null,
  })
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
  useAuthStore.setState({
    activeAccount: null, sessionKey: null, authError: null, prefs: {},
    showSignIn: false, showSettings: false, showAnalytics: false,
    pendingRecoveryCode: null, pendingRecoveryNewAccount: false,
  })
})

describe('admin pass on a profile', () => {
  it('a valid pass makes the profile ADMIN; a forged one is refused; removal reverts it', async () => {
    await useAuthStore.getState().signUp('owner', '', 'owner-pass-1')
    useAuthStore.getState().acknowledgeRecoveryCode()

    expect(await useAuthStore.getState().applyAdminPass(issuePass('x@y.com', stranger.secretKey))).toBe(false)
    expect(useAuthStore.getState().authError).toBe('That admin pass is not valid')
    expect(useAuthStore.getState().activeAccount?.isAdmin).toBeFalsy()

    expect(await useAuthStore.getState().applyAdminPass(issuePass('Owner@Example.com'))).toBe(true)
    expect(useAuthStore.getState().activeAccount).toMatchObject({ isAdmin: true, adminEmail: 'owner@example.com' })

    expect(await useAuthStore.getState().removeAdminPass()).toBe(true)
    expect(useAuthStore.getState().activeAccount?.isAdmin).toBeFalsy()
  }, 20000)

  it('a pass edited in device storage grants nothing at the next sign-in', async () => {
    await useAuthStore.getState().signUp('tamper', '', 'tamper-pass-1')
    useAuthStore.getState().acknowledgeRecoveryCode()
    await useAuthStore.getState().applyAdminPass(issuePass('owner@example.com'))
    useAuthStore.getState().signOut()

    const record = await getAccountByUsername('tamper')
    const [prefix, , sig] = record!.adminPass!.split('.')
    const forgedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
      v: 1, email: 'attacker@example.com', name: 'X', passId: 'adm-x', issuedAt: Date.now(),
    })))
    await putAccount({ ...record!, adminPass: `${prefix}.${forgedPayload}.${sig}` })

    expect(await useAuthStore.getState().signIn('tamper', 'tamper-pass-1')).toBe(true)
    expect(useAuthStore.getState().activeAccount?.isAdmin).toBeFalsy()
  }, 20000)
})

describe('admin override of the authorization-training gate', () => {
  it('still blocks a non-admin', () => {
    untrainedPreflight()
    expect(useDroneStore.getState().isAuthorizationTrainingReady()).toBe(false)
    useDroneStore.getState().beginLaunchSequence()
    expect(useDroneStore.getState().lifecycle).toBe('preflight')
  })

  it('lets an admin launch, and records the override in the evidence chain', () => {
    useAuthStore.setState({
      activeAccount: { id: 'a1', username: 'owner', displayName: 'Owner', isAdmin: true, adminEmail: 'owner@example.com' },
    })
    untrainedPreflight()
    expect(useDroneStore.getState().isAuthorizationTrainingReady()).toBe(true)
    useDroneStore.getState().beginLaunchSequence()
    expect(useDroneStore.getState().lifecycle).toBe('running')

    const override = useDroneStore.getState().events.find((e) => e.payload.command === 'admin_override')
    expect(override).toMatchObject({
      eventType: 'operator_command',
      payload: { gate: 'authorization_training', adminEmail: 'owner@example.com', authorizationStepsCompleted: [] },
    })
    // Training is not faked as complete.
    expect(useDroneStore.getState().authorizationCompletedSteps).toEqual([])
  })
})
