// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runDebugLine, listDebugCommands } from '@/debug/registry'
import { registerAllDebugCommands } from '@/debug/commands'
import { buildDebugBundle, resolveStorePath, sanitize } from '@/debug/commands/core'
import { REPLAY_VERIFY_UNAVAILABLE } from '@/debug/commands/verify'
import { resetFaultCommandStateForTests } from '@/debug/commands/faults'
import { getRunDebugTaint } from '@/debug/taint'
import { isFaultInjected, listInjectedFaults } from '@/sim/faults/injectedFaults'
import { getMissionSafetyOverride } from '@/sim/mission/MissionManager'
import { applyCommsModel } from '@/sim/safety/SafetyManager'
import { buildAggregates } from '@/components/account/analyticsData'
import { debugTaintForSession } from '@/account/runRecorder'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { initFleet, startSimLoop, stopSimLoop } from '@/sim/SimulationLoop'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { prepareScenarioTerrain } from '@/scenarios/terrainFixtures'
import { verifyChain } from '@/utils/chainOfCustody'
import { useAuthStore } from '@/store/authStore'
import { useDroneStore } from '@/store/droneStore'
import type { DebugLineKind } from '@/debug/types'
import type { DroneState } from '@/types'
import type { StoredRunSummary } from '@/account/types'

registerAllDebugCommands()

const wildfireTerrain = await prepareScenarioTerrain('demo_wildfire')
if (!wildfireTerrain.ok) throw new Error(wildfireTerrain.reason)

let lines: Array<{ text: string; kind: DebugLineKind }> = []
const io = {
  print: (text: string, kind: DebugLineKind = 'out') => { lines.push({ text, kind }) },
  json: (value: unknown) => { lines.push({ text: JSON.stringify(value), kind: 'json' }) },
}
async function run(line: string) {
  lines = []
  await runDebugLine(line, io)
  return lines
}
const text = () => lines.map((l) => l.text).join('\n')

const coastal = ALL_SCENARIOS.find((s) => s.id === 'demo_sar_coastal')!

function flyingDrone(overrides: Partial<DroneState> = {}): DroneState {
  return {
    id: 'uav-01', label: 'UAV-01', color: '#fff', position: { ...coastal.startPosition },
    altitudeFt: 150, headingDeg: 90, speedMs: 8, batteryPct: 80, signalDbm: -55,
    missionState: 'navigate', currentWaypointIndex: 0, conflictFlag: false,
    geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 1, ...overrides,
  }
}

beforeEach(() => {
  useDroneStore.getState().resetMission()
  resetFaultCommandStateForTests()
  useDroneStore.setState({
    scenario: coastal,
    weatherState: getDefaultWeatherState(coastal.seed),
    events: [],
    lastHash: '0'.repeat(64),
    drones: [flyingDrone()],
  })
})

describe('debug registry', () => {
  it('help lists every group, unknown commands error', async () => {
    await run('help')
    for (const group of ['system', 'inspect', 'sim', 'fault', 'verify', 'overlay']) expect(text()).toMatch(new RegExp(group, 'i'))
    await run('frobnicate')
    expect(lines[0]).toMatchObject({ kind: 'err' })
    expect(lines[0].text).toMatch(/Unknown command/)
  })

  it('the classroom relay pack is not registered outside the classroom edition', () => {
    expect(listDebugCommands().some((c) => c.name === 'relay')).toBe(false)
  })
})

describe('DEBUG taint', () => {
  it('a mutating command taints the run and records it IN the hash chain, which still verifies', async () => {
    expect(getRunDebugTaint()).toBeNull()
    await run('battery uav-01 40')
    expect(useDroneStore.getState().drones[0].batteryPct).toBe(40)
    expect(getRunDebugTaint()?.reasons[0]).toMatch(/battery uav-01 40/)

    const events = useDroneStore.getState().events
    const override = events.find((e) => e.eventType === 'debug_override')
    expect(override?.payload).toMatchObject({ simulationOnly: true })
    expect(verifyChain(events)).toBe(true)
    await run('chain verify')
    expect(text()).toMatch(/PASS/)
    expect(text()).toMatch(/debug overrides recorded in chain: 1/)
  })

  it('read-only commands do not taint', async () => {
    await run('status')
    await run('chain verify')
    await run('overlay list')
    await run('faults')
    expect(getRunDebugTaint()).toBeNull()
  })

  it('a mission reset clears the taint and every injected fault', async () => {
    await run('fault motor uav-01')
    expect(isFaultInjected('motor', 'uav-01')).toBe(true)
    useDroneStore.getState().resetMission()
    expect(getRunDebugTaint()).toBeNull()
    expect(listInjectedFaults()).toEqual([])
  })

  it('saved runs carry the taint and analytics leave them out, with a count', () => {
    const session = { events: useDroneStore.getState().events, completedAt: 1 } as Parameters<typeof debugTaintForSession>[0]
    expect(debugTaintForSession(session)).toBeUndefined()
    const clean = { metrics: {}, durationSec: 60, chainVerified: true, droneOutcomes: [] } as unknown as StoredRunSummary
    const tainted = { ...clean, debugTaint: { firstAt: 1, reasons: ['battery uav-01 40'] } } as StoredRunSummary
    const aggregates = buildAggregates([clean, tainted, tainted])
    expect(aggregates.total).toBe(1)
    expect(aggregates.debugExcluded).toBe(2)
  })
})

describe('fault injection drives the real mechanisms', () => {
  it('rejects unknown drones and out-of-range values', async () => {
    await run('fault motor uav-99')
    expect(lines[0]).toMatchObject({ kind: 'err' })
    await run('battery uav-01 150')
    expect(lines[0]).toMatchObject({ kind: 'err' })
    await run('wind 500')
    expect(lines[0]).toMatchObject({ kind: 'err' })
    expect(useDroneStore.getState().drones[0].batteryPct).toBe(80)
  })

  it('motor: the mission safety override sends a flying aircraft to an emergency landing', async () => {
    const drone = flyingDrone()
    expect(getMissionSafetyOverride(drone, { batteryReservePct: 20, weatherForceRtb: false })).toBeNull()
    await run('fault motor uav-01')
    expect(getMissionSafetyOverride(drone, { batteryReservePct: 20, weatherForceRtb: false }))
      .toEqual({ nextState: 'emergency', reason: 'motor_failure' })
    // A parked aircraft is left alone.
    expect(getMissionSafetyOverride({ ...drone, missionState: 'idle' }, { batteryReservePct: 20, weatherForceRtb: false })).toBeNull()
    await run('fault motor uav-01 off')
    expect(getMissionSafetyOverride(drone, { batteryReservePct: 20, weatherForceRtb: false })).toBeNull()
  })

  it('link: the RF budget drops the faulted drone to the loss floor', async () => {
    const drone = flyingDrone()
    const clean = applyCommsModel([drone], 0, coastal, undefined)[0].signalDbm
    await run('fault link uav-01')
    const jammed = applyCommsModel([drone], 0, coastal, undefined)[0].signalDbm
    expect(clean).toBeGreaterThan(-90)
    expect(jammed).toBeLessThanOrEqual(-90)
  })

  it('wind: writes the weather state and "faults clear" restores it', async () => {
    const before = useDroneStore.getState().weatherState.windKts
    await run('wind 33 270')
    expect(useDroneStore.getState().weatherState.windKts).toBe(33)
    expect(text()).toMatch(/Direction ignored/)
    await run('faults clear')
    expect(useDroneStore.getState().weatherState.windKts).toBe(before)
  })
})

describe('gps fault through the production loop', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { stopSimLoop(); vi.useRealTimers() })

  /** Fly one sim minute of demo_wildfire (it has a committed GNSS constellation), optionally with a GPS fault. */
  async function flyWildfire(withFault: boolean) {
    const wildfire = ALL_SCENARIOS.find((s) => s.id === 'demo_wildfire')!
    useDroneStore.getState().resetMission()
    useDroneStore.setState({ scenario: wildfire, weatherState: getDefaultWeatherState(wildfire.seed), launchPlan: null })
    initFleet()
    const target = useDroneStore.getState().drones[0].id
    useDroneStore.getState().completeAuthorizationTraining('test')
    useDroneStore.getState().beginLaunchSequence()
    useDroneStore.getState().setRunning(true)
    if (withFault) {
      await run(`fault gps ${target}`)
      expect(lines.some((l) => /not supported/.test(l.text))).toBe(false)
    }
    startSimLoop()
    vi.advanceTimersByTime(60 * 20 * 50) // one sim minute
    stopSimLoop()
    const events = [...useDroneStore.getState().events]
    return {
      lost: events.filter((e) => e.eventType === 'gnss_fix_lost' && e.droneId === target).length,
      chainOk: verifyChain(events),
    }
  }

  it('takes the GNSS evaluator no-fix path for the faulted drone only', async () => {
    const control = await flyWildfire(false)
    const faulted = await flyWildfire(true)
    expect(control.lost).toBe(0)
    expect(faulted.lost).toBeGreaterThan(0)
    expect(faulted.chainOk).toBe(true)
  }, 60000)
})

describe('verify, overlay and inspect commands', () => {
  it('replay verify says plainly that it is not available, never MATCH', async () => {
    await run('replay verify')
    expect(text()).toContain(REPLAY_VERIFY_UNAVAILABLE)
    expect(text()).not.toMatch(/\bMATCH\b/)
  })

  it('overlay toggles the matching layer key and rejects unknown names', async () => {
    const key = Object.keys(useDroneStore.getState().ui.layerVisibility)[0] as keyof ReturnType<typeof useDroneStore.getState>['ui']['layerVisibility']
    const start = useDroneStore.getState().ui.layerVisibility[key]
    await run(`overlay ${key} ${start ? 'off' : 'on'}`)
    expect(useDroneStore.getState().ui.layerVisibility[key]).toBe(!start)
    await run('overlay nosuchlayer')
    expect(lines[0]).toMatchObject({ kind: 'err' })
  })

  it('speed accepts only the sim\'s supported speeds', async () => {
    await run('speed 7')
    expect(lines[0]).toMatchObject({ kind: 'err' })
  })

  it('store and export bundle never reveal key material, passes or recovery data', () => {
    const secret = new Uint8Array(32).fill(7)
    useAuthStore.setState({
      sessionKey: secret,
      pendingRecoveryCode: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01',
      activeAccount: { id: 'a1', username: 'owner', displayName: 'Owner', isAdmin: true, adminEmail: 'owner@example.com' },
    })
    expect(() => resolveStorePath('auth.sessionKey')).toThrow(/redacted/)
    expect(() => resolveStorePath('auth.pendingRecoveryCode')).toThrow(/redacted/)
    const view = JSON.stringify(sanitize(useAuthStore.getState()))
    expect(view).not.toContain('ABCD-EFGH')
    expect(view).toContain('[redacted]')
    const bundle = JSON.stringify(buildDebugBundle())
    expect(bundle).not.toContain('ABCD-EFGH')
    expect(bundle).not.toContain('"sessionKey":{')
    expect(bundle).not.toMatch(/DSA1\./)
    useAuthStore.setState({ sessionKey: null, pendingRecoveryCode: null, activeAccount: null })
  })
})
