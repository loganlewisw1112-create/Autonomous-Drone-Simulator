import { describe, it, expect } from 'vitest'
import type { LaunchBayPlan, LaunchBayStatus } from '@/types'

function makeBayStatus(overrides: Partial<LaunchBayStatus> = {}): LaunchBayStatus {
  return {
    siteId: 'site-a',
    capacityDrones: 2,
    assignedDroneIds: [],
    weatherClosed: false,
    ...overrides,
  }
}

function validatePlan(
  droneIds: string[],
  assignments: Record<string, string>,
  bayStatuses: LaunchBayStatus[],
): { readyToLaunch: boolean; blockers: string[] } {
  const blockers: string[] = []
  droneIds.forEach((id) => {
    if (!assignments[id]) blockers.push(`${id} — no launch bay assigned`)
  })
  bayStatuses.forEach((bay) => {
    if (bay.weatherClosed && bay.assignedDroneIds.length > 0) {
      blockers.push(`Bay ${bay.siteId} is weather-closed but has drones assigned`)
    }
    if (bay.assignedDroneIds.length > bay.capacityDrones) {
      blockers.push(`Bay ${bay.siteId} over capacity (${bay.assignedDroneIds.length}/${bay.capacityDrones})`)
    }
  })
  return { readyToLaunch: blockers.length === 0, blockers }
}

describe('launchBayPlan', () => {
  it('empty assignments blocks all drones', () => {
    const drones = ['uav-01', 'uav-02', 'uav-03']
    const bays = [makeBayStatus({ siteId: 'site-a', assignedDroneIds: [] })]
    const { readyToLaunch, blockers } = validatePlan(drones, {}, bays)
    expect(readyToLaunch).toBe(false)
    expect(blockers).toHaveLength(3)
  })

  it('all drones assigned to valid bays → readyToLaunch', () => {
    const drones = ['uav-01', 'uav-02']
    const assignments = { 'uav-01': 'site-a', 'uav-02': 'site-a' }
    const bays = [makeBayStatus({ siteId: 'site-a', assignedDroneIds: ['uav-01', 'uav-02'], capacityDrones: 2 })]
    const { readyToLaunch, blockers } = validatePlan(drones, assignments, bays)
    expect(readyToLaunch).toBe(true)
    expect(blockers).toHaveLength(0)
  })

  it('weather-closed bay with assignments blocks launch', () => {
    const drones = ['uav-01']
    const assignments = { 'uav-01': 'site-a' }
    const bays = [makeBayStatus({
      siteId: 'site-a',
      assignedDroneIds: ['uav-01'],
      weatherClosed: true,
      closureReason: 'heavy fog',
    })]
    const { readyToLaunch, blockers } = validatePlan(drones, assignments, bays)
    expect(readyToLaunch).toBe(false)
    expect(blockers[0]).toContain('weather-closed')
  })

  it('over-capacity bay blocks launch', () => {
    const drones = ['uav-01', 'uav-02', 'uav-03']
    const assignments = { 'uav-01': 'site-a', 'uav-02': 'site-a', 'uav-03': 'site-a' }
    const bays = [makeBayStatus({
      siteId: 'site-a',
      assignedDroneIds: ['uav-01', 'uav-02', 'uav-03'],
      capacityDrones: 2,
    })]
    const { readyToLaunch, blockers } = validatePlan(drones, assignments, bays)
    expect(readyToLaunch).toBe(false)
    expect(blockers[0]).toContain('over capacity')
  })

  it('mixed valid/invalid assignments reports only blocking drones', () => {
    const drones = ['uav-01', 'uav-02', 'uav-03']
    const assignments = { 'uav-01': 'site-a', 'uav-02': 'site-a' } // uav-03 missing
    const bays = [makeBayStatus({ siteId: 'site-a', assignedDroneIds: ['uav-01', 'uav-02'], capacityDrones: 2 })]
    const { readyToLaunch, blockers } = validatePlan(drones, assignments, bays)
    expect(readyToLaunch).toBe(false)
    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toContain('uav-03')
  })

  it('LaunchBayPlan structure is serializable', () => {
    const plan: LaunchBayPlan = {
      assignments: { 'uav-01': 'site-a' },
      bayStatuses: [makeBayStatus({ siteId: 'site-a', assignedDroneIds: ['uav-01'] })],
      readyToLaunch: true,
      blockers: [],
    }
    const json = JSON.stringify(plan)
    const parsed: LaunchBayPlan = JSON.parse(json)
    expect(parsed.readyToLaunch).toBe(true)
    expect(parsed.assignments['uav-01']).toBe('site-a')
  })
})
