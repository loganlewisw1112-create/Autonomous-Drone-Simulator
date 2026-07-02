import { describe, expect, it } from 'vitest'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { selectRechargeStationForDrone } from '@/sim/mission/rechargeStations'

const rioGrande = ALL_SCENARIOS.find((scenario) => scenario.id === 'extreme_cbp_rio_grande_longrange')

describe('staged recharge station selection', () => {
  it('selects the next forward Rio Grande recharge station by sortie count', () => {
    expect(rioGrande).toBeTruthy()
    if (!rioGrande) return

    expect(selectRechargeStationForDrone({
      scenario: rioGrande,
      droneId: 'uav-03',
      sortieCount: 0,
      currentWaypointIndex: 0,
    })?.station.id).toBe('rg-rs-falcon-us83')

    expect(selectRechargeStationForDrone({
      scenario: rioGrande,
      droneId: 'uav-03',
      sortieCount: 2,
      currentWaypointIndex: 0,
    })?.station.id).toBe('rg-rs-rgc-us83')
  })

  it('does not send late-route Rio Grande drones backward to earlier recharge vehicles', () => {
    expect(rioGrande).toBeTruthy()
    if (!rioGrande) return

    const routeLength = rioGrande.perDroneWaypoints?.['uav-03']?.length ?? 0
    expect(selectRechargeStationForDrone({
      scenario: rioGrande,
      droneId: 'uav-03',
      sortieCount: 0,
      currentWaypointIndex: Math.max(0, routeLength - 1),
    })?.station.id).toBe('rg-rs-mission-us83')
  })
})
