// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThermalHoldCoach, coachHint } from '@/components/ThermalHoldCoach'
import { useDroneStore } from '@/store/droneStore'
import type { DroneState, MissionEvent, ThermalContactState } from '@/types'

const HOLD_START_SEC = 100

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
    selectedThermalId: null,
    elapsedSec: HOLD_START_SEC + 5,
    events: [firstEvent('mission-A')],
    ui: { ...useDroneStore.getState().ui, sensorMode: 'eo' },
    ...over,
  })
}

const banner = () => screen.queryByRole('status')

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

  it('goes away when the operator dispatches a ground unit', () => {
    render(<ThermalHoldCoach />)
    expect(banner()).not.toBeNull()
    act(() => { useDroneStore.getState().dispatchGroundUnit('near', 'intervention', { lat: 37.7, lng: -122.4 }) })
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
    expect(screen.getByRole('status')).toHaveClass('thermal-hold-coach--phone')
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
