// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThermalHoldCoach, coachHint, coachHintStatic } from '@/components/ThermalHoldCoach'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { prepareScenarioRoads } from '@/scenarios/roadFixtures'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState, MissionEvent, ScenarioConfig, ThermalContactState } from '@/types'

const HOLD_START_SEC = 100
const DEMO_BASIC = ALL_SCENARIOS.find((sc) => sc.id === 'demo_basic')! as ScenarioConfig

function drone(patch: Partial<DroneState> = {}): DroneState {
  return {
    id: 'drone-1',
    label: 'UAV-1',
    color: '#00d4ff',
    position: { lat: 37.77, lng: -122.48 },
    altitudeFt: 200,
    headingDeg: 0,
    speedMs: 0,
    batteryPct: 80,
    signalDbm: -50,
    missionState: 'thermal_hold',
    currentWaypointIndex: 0,
    conflictFlag: false,
    geofenceBreachFlag: false,
    bvlosFlag: false,
    sortieCount: 0,
    thermalHoldStartSec: HOLD_START_SEC,
    ...patch,
  } as DroneState
}

function contact(sourceId: string, dLat: number, patch: Partial<ThermalContactState> = {}): ThermalContactState {
  return {
    sourceId,
    class: 'generic-person',
    position: { lat: 37.77 + dLat, lng: -122.48 },
    confidence: 0.9,
    tick: 1,
    selected: false,
    weatherAdjustedConfidence: 0.9,
    ...patch,
  }
}

function firstEvent(hash: string): MissionEvent {
  return {
    tick: 0, timestamp: 0, droneId: 'drone-1', operatorId: 'op', role: 'pic',
    eventType: 'state_change', payload: {}, prevHash: '0'.repeat(64), hash,
  } as MissionEvent
}

function seed(over: Record<string, unknown> = {}) {
  useDroneStore.setState({
    drones: [drone()],
    thermalContacts: [contact('far', 0.005), contact('near', 0.0005)],
    groundUnits: [],
    scenario: null,
    selectedThermalId: null,
    elapsedSec: HOLD_START_SEC + 5,
    events: [firstEvent('mission-A')],
    ui: { ...useDroneStore.getState().ui, sensorMode: 'eo' },
    ...over,
  })
}

// The banner is the content of an always-present live region, so `role=status` no longer says
// whether it is open. The banner root carries the test id.
const banner = () => screen.queryByTestId('thermal-hold-coach')

beforeEach(() => {
  seed()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ThermalHoldCoach', () => {
  it('shows an accessible banner when a drone is in thermal_hold', () => {
    render(<ThermalHoldCoach />)
    const el = screen.getByRole('status')
    expect(el).toHaveAttribute('aria-live', 'polite')
    expect(el).toHaveTextContent('Thermal contact — UAV-1 is holding for you.')
    expect(el).toHaveTextContent('Dispatch a ground unit or mark it a false positive.')
    expect(screen.getByRole('button', { name: 'Show thermal view' })).toBeInTheDocument()
  })

  it('mounts the polite live region before the banner opens, and the banner appears inside that same node', () => {
    seed({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] })
    render(<ThermalHoldCoach />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveAttribute('aria-atomic', 'false')
    expect(banner()).toBeNull()
    expect(region).toBeEmptyDOMElement()

    act(() => { useDroneStore.setState({ drones: [drone()] }) })
    expect(screen.getByRole('status')).toBe(region) // not re-mounted with its content
    expect(banner()).not.toBeNull()
    expect(region).toContainElement(banner())

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(banner()).toBeNull()
    expect(screen.getByRole('status')).toBe(region) // stays mounted, empty again
    expect(region).toBeEmptyDOMElement()
  })

  it('keeps the ticking countdown out of the accessibility tree and gives screen readers one static line', () => {
    render(<ThermalHoldCoach />)
    const ticking = screen.getByTestId('thermal-hold-coach-hint')
    expect(ticking).toHaveAttribute('aria-hidden', 'true')
    expect(ticking).toHaveTextContent('about 25s')

    const fixed = screen.getByTestId('thermal-hold-coach-hint-static')
    expect(fixed).not.toHaveAttribute('aria-hidden')
    expect(fixed).toHaveClass('sr-only')
    expect(fixed).toHaveTextContent('Dispatch a ground unit or mark it a false positive.')
    expect(fixed).toHaveTextContent('The drone resumes on its own in about 25 seconds.')

    // Sim time advancing updates the visible number but never the static screen-reader text.
    act(() => { useDroneStore.setState({ elapsedSec: HOLD_START_SEC + 12 }) })
    expect(ticking).toHaveTextContent('about 18s')
    expect(screen.getByTestId('thermal-hold-coach-hint-static')).toBe(fixed)
    expect(fixed).toHaveTextContent('The drone resumes on its own in about 25 seconds.')
    expect(fixed.textContent).not.toMatch(/\b18\b/)
  })

  it('renders nothing while no drone is holding', () => {
    seed({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] })
    render(<ThermalHoldCoach />)
    expect(banner()).toBeNull()
  })

  it('"Show thermal view" switches to IR and selects the nearest unresolved contact', () => {
    // A resolved contact sitting right on the drone must not be picked.
    seed({ thermalContacts: [contact('resolved', 0.00001, { resolvedAt: 3 }), contact('far', 0.005), contact('near', 0.0005)] })
    render(<ThermalHoldCoach />)
    fireEvent.click(screen.getByRole('button', { name: 'Show thermal view' }))
    const s = useDroneStore.getState()
    expect(s.ui.sensorMode).toBe('ir')
    expect(s.selectedThermalId).toBe('near')
  })

  it('counts down from sim seconds (not wall clock) using thermalHoldStartSec and the 30 s auto-resume', () => {
    vi.useFakeTimers()
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent('about 25s')
    // Wall-clock time passing changes nothing.
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent('about 25s')
    // Sim time advancing does.
    act(() => { useDroneStore.setState({ elapsedSec: HOLD_START_SEC + 12 }) })
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent('about 18s')
  })

  it('goes away when the operator dispatches a ground unit', async () => {
    // Dispatch drives the road network (c12b) and is refused without one, so hold over a scenario
    // whose roads are staged and put the contacts where a unit can reach them.
    await prepareScenarioRoads(DEMO_BASIC.id)
    const hs = DEMO_BASIC.heatSources[0].position
    seed({
      scenario: DEMO_BASIC,
      drones: [drone({ position: hs })],
      thermalContacts: [contact('far', 0.005), { ...contact('near', 0), position: hs }],
    })
    render(<ThermalHoldCoach />)
    expect(banner()).not.toBeNull()
    act(() => { useDroneStore.getState().dispatchGroundUnit('near', 'intervention', { lat: 37.7, lng: -122.4 }) })
    expect(useDroneStore.getState().groundUnits).toHaveLength(1)
    expect(banner()).toBeNull()
  })

  it('goes away when the operator marks a contact a false positive', () => {
    render(<ThermalHoldCoach />)
    act(() => { useDroneStore.getState().resolveThermal('near', 'mark_false_positive') })
    expect(banner()).toBeNull()
  })

  it('goes away on Esc, and only listens for Esc while visible', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const keydownAdds = () => add.mock.calls.filter(([type]) => type === 'keydown').length
    const keydownRemoves = () => remove.mock.calls.filter(([type]) => type === 'keydown').length

    seed({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] })
    render(<ThermalHoldCoach />)
    expect(keydownAdds()).toBe(0) // not visible: no listener

    act(() => { useDroneStore.setState({ drones: [drone()] }) })
    expect(banner()).not.toBeNull()
    expect(keydownAdds()).toBe(1)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(banner()).toBeNull()
    expect(keydownRemoves()).toBe(1) // listener detached again
    add.mockRestore()
    remove.mockRestore()
  })

  it('goes away from the close button', () => {
    render(<ThermalHoldCoach />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss thermal hold guidance' }))
    expect(banner()).toBeNull()
  })

  it('goes away when the operator resumes the drone (hold ends)', () => {
    render(<ThermalHoldCoach />)
    act(() => {
      useDroneStore.setState({ elapsedSec: HOLD_START_SEC + 11 }) // past the 10 s resume lock
      useDroneStore.getState().resumeDrone('drone-1')
    })
    expect(useDroneStore.getState().drones[0].missionState).not.toBe('thermal_hold')
    expect(banner()).toBeNull()
  })

  it('does not show again for a second hold in the same mission', () => {
    render(<ThermalHoldCoach />)
    expect(banner()).not.toBeNull()
    // Hold ends, banner clears.
    act(() => { useDroneStore.setState({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] }) })
    expect(banner()).toBeNull()
    // A second hold, same mission (same first-event hash).
    act(() => { useDroneStore.setState({ drones: [drone({ thermalHoldStartSec: 200 })], elapsedSec: 205 }) })
    expect(banner()).toBeNull()
  })

  it('does not re-show for a second hold even after the first was dismissed with Esc', () => {
    render(<ThermalHoldCoach />)
    fireEvent.keyDown(window, { key: 'Escape' })
    act(() => { useDroneStore.setState({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] }) })
    act(() => { useDroneStore.setState({ drones: [drone({ thermalHoldStartSec: 300 })], elapsedSec: 301 }) })
    expect(banner()).toBeNull()
  })

  it('shows again in a new mission (different first-event hash)', () => {
    render(<ThermalHoldCoach />)
    expect(banner()).not.toBeNull()
    act(() => { useDroneStore.setState({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] }) })
    expect(banner()).toBeNull()
    // New mission: the store resets events, so the first event (and its hash) differs.
    act(() => {
      useDroneStore.setState({ events: [firstEvent('mission-B')] })
      useDroneStore.setState({ drones: [drone({ thermalHoldStartSec: 10 })], elapsedSec: 15 })
    })
    expect(banner()).not.toBeNull()
  })

  it('uses the phone placement class when mounted in the mobile shell', () => {
    render(<ThermalHoldCoach placement="phone" />)
    expect(screen.getByTestId('thermal-hold-coach')).toHaveClass('thermal-hold-coach--phone')
  })
})

describe('ThermalHoldCoach desktop placement', () => {
  let feed: HTMLElement | null = null
  let rect = { left: 232, bottom: 150, width: 900 }

  function mountFeed() {
    const el = document.createElement('section')
    el.setAttribute('data-testid', 'mission-status-feed')
    el.getBoundingClientRect = () => ({
      x: rect.left, y: 8, left: rect.left, top: 8, right: rect.left + rect.width,
      bottom: rect.bottom, width: rect.width, height: rect.bottom - 8,
      toJSON: () => ({}),
    }) as DOMRect
    document.body.appendChild(el)
    feed = el
  }

  /** ResizeObserver stand-in that records what is observed and lets a test fire the callback. */
  function stubResizeObserver() {
    const instances: Array<{ cb: () => void; observed: Element[]; disconnect: ReturnType<typeof vi.fn> }> = []
    class FakeRO {
      cb: () => void
      observed: Element[] = []
      disconnect = vi.fn()
      constructor(cb: () => void) { this.cb = cb; instances.push(this) }
      observe(el: Element) { this.observed.push(el) }
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO)
    return instances
  }

  beforeEach(() => {
    rect = { left: 232, bottom: 150, width: 900 }
  })

  afterEach(() => {
    feed?.remove()
    feed = null
    vi.unstubAllGlobals()
  })

  it('sits 8px under the mission feed, left-aligned with it, at most 620px wide', () => {
    mountFeed()
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach')).toHaveStyle({ top: '158px', left: '232px', width: '620px' })
  })

  it('never grows wider than the feed, so it cannot reach the ops hub on the right', () => {
    rect = { left: 232, bottom: 150, width: 500 }
    mountFeed()
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach')).toHaveStyle({ left: '232px', width: '500px' })
  })

  it('falls back to the 52px top-centre default when there is no feed', () => {
    render(<ThermalHoldCoach />)
    const el = screen.getByTestId('thermal-hold-coach')
    expect(el.style.top).toBe('')
    expect(el.style.left).toBe('')
    expect(el.style.width).toBe('')
  })

  it('re-measures when the window resizes', () => {
    mountFeed()
    render(<ThermalHoldCoach />)
    rect = { left: 100, bottom: 300, width: 400 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(screen.getByTestId('thermal-hold-coach')).toHaveStyle({ top: '308px', left: '100px', width: '400px' })
  })

  it('re-measures when the feed itself resizes, and disconnects/unsubscribes on unmount', () => {
    const observers = stubResizeObserver()
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const resizeCalls = (spy: typeof add) => spy.mock.calls.filter(([type]) => type === 'resize').length
    mountFeed()
    const { unmount } = render(<ThermalHoldCoach />)
    expect(observers).toHaveLength(1)
    expect(observers[0].observed).toContain(feed)
    expect(resizeCalls(add)).toBe(1)

    rect = { left: 232, bottom: 210, width: 900 }
    act(() => { observers[0].cb() })
    expect(screen.getByTestId('thermal-hold-coach')).toHaveStyle({ top: '218px' })

    unmount()
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(resizeCalls(remove)).toBe(1)
    add.mockRestore()
    remove.mockRestore()
  })

  it('does not measure or observe anything while the banner is closed', () => {
    const observers = stubResizeObserver()
    mountFeed()
    seed({ drones: [drone({ missionState: 'navigate', thermalHoldStartSec: undefined })] })
    render(<ThermalHoldCoach />)
    expect(observers).toHaveLength(0)
  })

  it('leaves the phone placement unanchored even when a feed exists', () => {
    mountFeed()
    render(<ThermalHoldCoach placement="phone" />)
    const el = screen.getByTestId('thermal-hold-coach')
    expect(el.style.top).toBe('')
    expect(el.style.left).toBe('')
  })
})

describe('coachHint', () => {
  it("'unknown' gives the Dispatch wording with the seconds left", () => {
    const text = coachHint({ roadAccess: 'unknown', secondsLeft: 18 })
    expect(text).toContain('Dispatch a ground unit or mark it a false positive.')
    expect(text).toContain('about 18s')
  })

  it("'ok' reads the same as 'unknown'", () => {
    expect(coachHint({ roadAccess: 'ok', secondsLeft: 7 })).toBe(coachHint({ roadAccess: 'unknown', secondsLeft: 7 }))
  })

  it('rounds partial seconds up and never goes negative', () => {
    expect(coachHint({ roadAccess: 'unknown', secondsLeft: 17.2 })).toContain('about 18s')
    expect(coachHint({ roadAccess: 'unknown', secondsLeft: -4 })).toContain('about 0s')
  })
})

describe('coachHint with no road access', () => {
  it("'none' drops the Dispatch wording and says to mark it or let the drone resume", () => {
    const text = coachHint({ roadAccess: 'none', secondsLeft: 18 })
    expect(text).toContain('No road access — mark it or let the drone resume.')
    expect(text).not.toContain('Dispatch a ground unit')
    expect(text).toContain('about 18s')
  })

  it("'none' reads the same way for a screen reader, with the seconds spelled out", () => {
    const text = coachHintStatic({ roadAccess: 'none', secondsLeft: 25 })
    expect(text).toContain('No road access — mark it or let the drone resume.')
    expect(text).not.toContain('Dispatch a ground unit')
    expect(text).toContain('about 25 seconds')
  })
})

describe('ThermalHoldCoach road access', () => {
  const base = DEMO_BASIC
  const HINT_NONE = 'No road access — mark it or let the drone resume.'
  const HINT_DISPATCH = 'Dispatch a ground unit or mark it a false positive.'

  /** A drone holding right on top of one contact, in the given scenario. */
  function holdOver(scenario: ScenarioConfig | null, position: { lat: number; lng: number }) {
    seed({
      scenario,
      drones: [drone({ position })],
      thermalContacts: [{ ...contact('only', 0), position }],
    })
  }

  it('says there is no road access for a contact in a scenario with no road data (custom scenario)', () => {
    const custom = { ...base, id: 'custom_no_roads', terrainFixtureId: undefined } as ScenarioConfig
    holdOver(custom, base.heatSources[0].position)
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_NONE)
    expect(screen.getByTestId('thermal-hold-coach-hint')).not.toHaveTextContent('Dispatch a ground unit')
    expect(screen.getByTestId('thermal-hold-coach-hint-static')).toHaveTextContent(HINT_NONE)
    expect(screen.getByRole('status')).toHaveTextContent('Thermal contact — UAV-1 is holding for you.')
    // Marking it and "Show thermal view" are still on offer.
    expect(screen.getByRole('button', { name: 'Show thermal view' })).toBeInTheDocument()
  })

  it('says there is no road access for a contact more than 2 km from any road on a staged network', async () => {
    await prepareScenarioRoads('demo_basic')
    const hs = base.heatSources[0].position
    holdOver(base, { lat: hs.lat + 0.3, lng: hs.lng }) // roughly 33 km north of the fixture
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_NONE)
    expect(screen.getByTestId('thermal-hold-coach-hint-static')).toHaveTextContent(HINT_NONE)
  })

  it('keeps the Dispatch wording for a contact a ground unit can reach by road', async () => {
    await prepareScenarioRoads('demo_basic')
    holdOver(base, base.heatSources[0].position)
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_DISPATCH)
    expect(screen.getByTestId('thermal-hold-coach-hint-static')).toHaveTextContent(HINT_DISPATCH)
    expect(screen.getByTestId('thermal-hold-coach-hint')).not.toHaveTextContent('No road access')
  })

  it('keeps the Dispatch wording while no scenario is loaded (nothing to ask)', () => {
    holdOver(null, base.heatSources[0].position)
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_DISPATCH)
  })

  it('answers for the contact it targets: the nearest unresolved one, not a farther unreachable one', async () => {
    await prepareScenarioRoads('demo_basic')
    const hs = base.heatSources[0].position
    const nearReachable = hs
    const farUnreachable = { lat: hs.lat + 0.3, lng: hs.lng }
    seed({
      scenario: base,
      drones: [drone({ position: nearReachable })],
      thermalContacts: [
        { ...contact('far', 0), position: farUnreachable },
        { ...contact('near', 0), position: nearReachable },
      ],
    })
    render(<ThermalHoldCoach />)
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_DISPATCH)
    // The drone moves to the unreachable one: the banner follows its target.
    act(() => { useDroneStore.setState({ drones: [drone({ position: farUnreachable })] }) })
    expect(screen.getByTestId('thermal-hold-coach-hint')).toHaveTextContent(HINT_NONE)
  })
})
