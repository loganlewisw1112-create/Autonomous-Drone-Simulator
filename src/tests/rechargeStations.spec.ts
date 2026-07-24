import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { selectRechargeStationForDrone } from '@/sim/mission/rechargeStations'

const maritime = ALL_SCENARIOS.find((scenario) => scenario.id === 'train_uscg_maritime_sar')

describe('staged recharge station selection', () => {
  it('returns undefined when a scenario has no staged recharge network', () => {
    expect(maritime).toBeTruthy()
    if (!maritime) return

    expect(selectRechargeStationForDrone({
      scenario: maritime,
      droneId: 'uav-01',
      sortieCount: 0,
      currentWaypointIndex: 0,
    })).toBeNull()
  })
})
