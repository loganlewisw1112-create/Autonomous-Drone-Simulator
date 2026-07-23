import { describe, expect, it } from 'vitest'
import {
  CLEAN_MARGIN_DB,
  CLUTTER_PROFILES,
  clutterForLocationTag,
  computeLinkBudget,
  controlLatencyFromLoss,
  DEFAULT_RADIO,
  effectiveExponent,
  freeSpacePathLossDb,
  nlosPenaltyDb,
  packetLossFromMargin,
  reportedSignalDbm,
  resolveLink,
  shadowFadingDb,
  type LinkBudgetInput,
} from '@/sim/safety/commsModel'
import { applyCommsModel } from '@/sim/safety/SafetyManager'
import { offsetLatLng } from '@/utils/geometry'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import type { DroneState, ScenarioConfig } from '@/types'

// REALISM_ROADMAP WP-8 / §18.4.

const GCS = { position: { lat: 37.8992, lng: -122.2432 }, altMslM: 2 }

/** A drone `groundM` away at `altFt`, in the same MSL datum as the ground station. */
function aircraft(groundM: number, altFt: number) {
  return {
    position: offsetLatLng(GCS.position, 90, groundM),
    altMslM: altFt * 0.3048,
  }
}

const clearSky: OcclusionService = {
  groundElevation: () => 0,
  surfaceHeight: () => 0,
  hasLineOfSight: () => ({ clear: true, blockedBy: null, blockHeight: null, blockedAt: null, clearanceM: 50 }),
  skyVisibility: () => true,
}

/** A ridge that buries the ray 20 m deep. */
const ridge: OcclusionService = {
  ...clearSky,
  hasLineOfSight: () => ({
    clear: false, blockedBy: 'terrain', blockHeight: 300,
    blockedAt: GCS.position, clearanceM: -20,
  }),
}

function link(overrides: Partial<LinkBudgetInput> = {}): LinkBudgetInput {
  return {
    from: GCS,
    to: aircraft(500, 200),
    clutter: 'suburban',
    seed: 5005,
    linkId: 'uav-01',
    occlusion: clearSky,
    ...overrides,
  }
}

describe('RF link budget (WP-8 §18.4)', () => {
  it('free-space path loss reproduces the textbook 2.4 GHz anchors', () => {
    // ~40 dB at 1 m and ~100 dB at 1 km are the standard 2.4 GHz figures.
    expect(freeSpacePathLossDb(1, 2400)).toBeCloseTo(40.05, 1)
    expect(freeSpacePathLossDb(1000, 2400)).toBeCloseTo(100.05, 1)
    // Doubling distance costs exactly 6 dB.
    expect(freeSpacePathLossDb(200, 2400) - freeSpacePathLossDb(100, 2400)).toBeCloseTo(6.02, 2)
    // Doubling frequency also costs 6 dB — 5.8 GHz is lossier than 2.4 GHz at the same range.
    expect(freeSpacePathLossDb(100, 5800)).toBeGreaterThan(freeSpacePathLossDb(100, 2400))
  })

  it('carries §18.4 clutter exponents in the published order', () => {
    const order = ['open', 'rural', 'suburban', 'urban', 'dense_urban'] as const
    for (let i = 1; i < order.length; i += 1) {
      expect(CLUTTER_PROFILES[order[i]].exponent).toBeGreaterThan(CLUTTER_PROFILES[order[i - 1]].exponent)
      expect(CLUTTER_PROFILES[order[i]].shadowSigmaDb).toBeGreaterThanOrEqual(CLUTTER_PROFILES[order[i - 1]].shadowSigmaDb)
    }
    // Each sits inside its published band rather than on a boundary.
    expect(CLUTTER_PROFILES.open.exponent).toBeGreaterThanOrEqual(2.0)
    expect(CLUTTER_PROFILES.open.exponent).toBeLessThanOrEqual(2.2)
    expect(CLUTTER_PROFILES.dense_urban.exponent).toBeGreaterThanOrEqual(3.6)
    expect(CLUTTER_PROFILES.dense_urban.exponent).toBeLessThanOrEqual(4.5)
  })

  it('blends the exponent toward free space as the link climbs out of the clutter', () => {
    const { exponent: n, clutterHeightM: h } = CLUTTER_PROFILES.urban
    // At or below the rooftops, full clutter loss.
    expect(effectiveExponent(n, h, 0)).toBeCloseTo(n, 9)
    expect(effectiveExponent(n, h, h)).toBeCloseTo(n, 9)
    // Well above them, essentially free space.
    expect(effectiveExponent(n, h, h + 3 * h + 10)).toBeCloseTo(2.0, 9)
    expect(effectiveExponent(n, h, 500)).toBeCloseTo(2.0, 9)
    // Monotonic between.
    expect(effectiveExponent(n, h, 40)).toBeLessThan(effectiveExponent(n, h, 25))

    // Denser clutter takes more height to escape — the whole point of carrying a clutter height.
    const dense = CLUTTER_PROFILES.dense_urban
    const sub = CLUTTER_PROFILES.suburban
    expect(effectiveExponent(dense.exponent, dense.clutterHeightM, 60))
      .toBeGreaterThan(effectiveExponent(sub.exponent, sub.clutterHeightM, 60))
  })

  it('climbing improves the link at fixed ground range', () => {
    const low = computeLinkBudget(link({ to: aircraft(800, 80), clutter: 'urban' }))
    const high = computeLinkBudget(link({ to: aircraft(800, 400), clutter: 'urban' }))
    expect(high.marginDb).toBeGreaterThan(low.marginDb)
    expect(high.exponent).toBeLessThan(low.exponent)
  })

  it('range costs margin, and denser clutter costs more of it', () => {
    const near = computeLinkBudget(link({ to: aircraft(200, 200) }))
    const far = computeLinkBudget(link({ to: aircraft(2000, 200) }))
    expect(far.marginDb).toBeLessThan(near.marginDb)

    const open = computeLinkBudget(link({ to: aircraft(1500, 150), clutter: 'open' }))
    const dense = computeLinkBudget(link({ to: aircraft(1500, 150), clutter: 'dense_urban' }))
    expect(dense.marginDb).toBeLessThan(open.marginDb)
  })

  it('applies the §18.4 NLOS penalty scaled by how deep the blocker buries the ray', () => {
    expect(nlosPenaltyDb(5)).toBe(0)
    expect(nlosPenaltyDb(0)).toBe(0)
    // The published band is +15 to 25 dB.
    expect(nlosPenaltyDb(-0.1)).toBeGreaterThanOrEqual(15)
    expect(nlosPenaltyDb(-30)).toBeCloseTo(25, 6)
    expect(nlosPenaltyDb(-1000)).toBeCloseTo(25, 6)
    expect(nlosPenaltyDb(-20)).toBeGreaterThan(nlosPenaltyDb(-5))
  })

  it('a drone behind a ridge loses margin with no scripted event', () => {
    const clear = computeLinkBudget(link({ to: aircraft(1200, 150), occlusion: clearSky }))
    const blocked = computeLinkBudget(link({ to: aircraft(1200, 150), occlusion: ridge }))

    expect(clear.los).toBe(true)
    expect(blocked.los).toBe(false)
    expect(blocked.nlosPenaltyDb).toBeGreaterThanOrEqual(15)
    expect(blocked.marginDb).toBeLessThan(clear.marginDb - 15)
    // Nothing about this came from a timer.
    expect(blocked.interferenceDb).toBe(0)
  })

  it('treats a missing occlusion fixture as clear rather than inventing an obstruction', () => {
    const withNone = computeLinkBudget(link({ occlusion: undefined }))
    expect(withNone.los).toBe(true)
    expect(withNone.nlosPenaltyDb).toBe(0)
  })

  it('shadow fading is bounded, spatially correlated and free of RNG state', () => {
    const sigma = CLUTTER_PROFILES.urban.shadowSigmaDb
    let sum = 0
    for (let d = 1; d < 4000; d += 1) {
      const x = shadowFadingDb(5005, 'uav-01', d, sigma)
      expect(Math.abs(x)).toBeLessThanOrEqual(sigma)
      sum += x
    }
    // Zero-mean, so fading neither flatters nor punishes the link on average.
    expect(Math.abs(sum / 3999)).toBeLessThan(sigma * 0.15)

    // Correlated over short moves — a hovering aircraft holds a steady fade rather than
    // shimmering, which a per-tick RNG draw would produce.
    for (let d = 10; d < 500; d += 10) {
      expect(Math.abs(shadowFadingDb(5005, 'uav-01', d + 1, sigma) - shadowFadingDb(5005, 'uav-01', d, sigma)))
        .toBeLessThan(sigma * 0.5)
    }

    // Pure, and per-link.
    expect(shadowFadingDb(5005, 'uav-01', 250, sigma)).toBe(shadowFadingDb(5005, 'uav-01', 250, sigma))
    expect(shadowFadingDb(5005, 'uav-01', 250, sigma)).not.toBe(shadowFadingDb(5005, 'uav-02', 250, sigma))
  })

  it('maps margin to packet loss and latency along the documented curve', () => {
    expect(packetLossFromMargin(CLEAN_MARGIN_DB)).toBe(0)
    expect(packetLossFromMargin(30)).toBe(0)
    expect(packetLossFromMargin(0)).toBe(100)
    expect(packetLossFromMargin(-5)).toBe(100)
    // Monotonic and accelerating as margin collapses.
    let previous = -1
    for (let m = CLEAN_MARGIN_DB; m >= 0; m -= 1) {
      const loss = packetLossFromMargin(m)
      expect(loss).toBeGreaterThanOrEqual(previous)
      previous = loss
    }
    // Half margin loses well under half the packets — the curve is quadratic, not linear.
    expect(packetLossFromMargin(10)).toBeCloseTo(25, 6)

    expect(controlLatencyFromLoss(0)).toBe(45)
    expect(controlLatencyFromLoss(50)).toBe(90)
    expect(controlLatencyFromLoss(100)).toBeGreaterThan(controlLatencyFromLoss(75))
  })

  it('clamps reported signal onto the app scale', () => {
    expect(reportedSignalDbm(-5)).toBe(-30)
    expect(reportedSignalDbm(-250)).toBe(-100)
    expect(reportedSignalDbm(-72.4)).toBe(-72)
  })

  it('derives a defensible clutter class from the existing weather location tag', () => {
    expect(clutterForLocationTag('coastal')).toBe('open')
    expect(clutterForLocationTag('urban')).toBe('urban')
    expect(clutterForLocationTag('wildfire')).toBe('suburban')
    expect(clutterForLocationTag('desert_border')).toBe('rural')
    expect(clutterForLocationTag('mountain')).toBe('rural')
    expect(clutterForLocationTag(undefined)).toBe('suburban')
  })
})

describe('relay hops (WP-8 accept criterion)', () => {
  const farAircraft = aircraft(4000, 120)

  it('a relay is taken only when it beats flying direct, and is limited by its worst leg', () => {
    const direct = resolveLink(link({ to: farAircraft, clutter: 'urban' }))
    expect(direct.viaRelayId).toBeNull()

    // A high relay placed midway between the operator and the aircraft.
    const midway = {
      id: 'uav-relay',
      position: offsetLatLng(GCS.position, 90, 2000),
      altMslM: 400 * 0.3048,
    }
    const relayed = resolveLink(link({ to: farAircraft, clutter: 'urban' }), [midway])

    expect(relayed.viaRelayId).toBe('uav-relay')
    expect(relayed.marginDb).toBeGreaterThan(direct.marginDb)
  })

  it('moving the relay measurably changes downstream link margin', () => {
    const at = (groundM: number, altFt: number) => resolveLink(
      link({ to: farAircraft, clutter: 'urban' }),
      [{ id: 'uav-relay', position: offsetLatLng(GCS.position, 90, groundM), altMslM: altFt * 0.3048 }],
    )
    const good = at(2000, 400)
    const poor = at(200, 400)

    // Parked next to the operator, the relay's second leg is nearly the whole distance, so it
    // helps far less than one placed midway. This is the accept criterion.
    expect(good.marginDb).toBeGreaterThan(poor.marginDb)
    // ...and moving it past the midpoint, so the FIRST leg becomes the long one, costs margin
    // again. The optimum is genuinely in the middle rather than "as far out as possible".
    expect(good.marginDb).toBeGreaterThan(at(3800, 400).marginDb)
  })

  it('a useless relay is ignored rather than making the link worse', () => {
    const direct = resolveLink(link({ to: aircraft(300, 200) }))
    const withBadRelay = resolveLink(link({ to: aircraft(300, 200) }), [
      { id: 'uav-far', position: offsetLatLng(GCS.position, 270, 9000), altMslM: 30 },
    ])
    expect(withBadRelay.viaRelayId).toBeNull()
    expect(withBadRelay.marginDb).toBeCloseTo(direct.marginDb, 9)
  })
})

describe('applyCommsModel over the physical link budget', () => {
  function scenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
    return {
      id: 'wp8-test',
      name: 'WP-8',
      description: 'link budget fixture',
      seed: 5005,
      droneCount: 1,
      missionType: 'waypoint',
      startPosition: GCS.position,
      waypoints: [],
      geofences: [],
      heatSources: [],
      batteryStartPct: 100,
      batteryDrainRatePerSec: 0.01,
      commsLossWindows: [],
      ...overrides,
    }
  }

  function drone(groundM: number, altFt: number, overrides: Partial<DroneState> = {}): DroneState {
    return {
      id: 'uav-01',
      label: 'UAV-01',
      color: '#fff',
      position: offsetLatLng(GCS.position, 90, groundM),
      altitudeFt: altFt,
      headingDeg: 90,
      speedMs: 8,
      batteryPct: 80,
      signalDbm: -55,
      missionState: 'navigate',
      currentWaypointIndex: 0,
      conflictFlag: false,
      geofenceBreachFlag: false,
      bvlosFlag: false,
      sortieCount: 1,
      ...overrides,
    }
  }

  it('flying further degrades the link monotonically', () => {
    let previous = Infinity
    for (const groundM of [200, 1000, 3000, 6000, 12000]) {
      const state = applyCommsModel([drone(groundM, 150)], 0, scenario(), undefined)[0]
      expect(state.signalDbm).toBeLessThanOrEqual(previous)
      previous = state.signalDbm
    }
    // A 6 km link at 150 ft over suburban terrain is well clear of the rooftops and therefore
    // close to free space, so it still closes. That is correct — these platforms advertise
    // multi-kilometre range — and it is why the BVLOS case below needs real clutter, not
    // just distance.
    expect(applyCommsModel([drone(6000, 150)], 0, scenario(), undefined)[0].bvlosFlag).toBe(false)
  })

  it('dense urban at low altitude loses the link with no scripted event', () => {
    // The Times Square case: down among 40 m buildings, range collapses. This is why that
    // scenario authors a dedicated comms-relay sector.
    const low = applyCommsModel([drone(1500, 80)], 0, scenario({ rfClutter: 'dense_urban' }), undefined)[0]
    expect(low.bvlosFlag).toBe(true)
    expect(low.linkPacketLossPct).toBe(100)

    // Climbing out of the canyon helps materially — but at 1.5 km in dense urban it is still
    // marginal, which is exactly why that scenario authors a dedicated relay aircraft.
    const high = applyCommsModel([drone(1500, 400)], 0, scenario({ rfClutter: 'dense_urban' }), undefined)[0]
    expect(high.signalDbm).toBeGreaterThan(low.signalDbm)
    expect(high.linkMarginDb!).toBeGreaterThan(low.linkMarginDb!)

    // The relay is the fix that actually closes it.
    const relayed = applyCommsModel(
      [drone(1500, 400), drone(700, 400, { id: 'uav-relay', label: 'RELAY' })],
      0,
      scenario({ droneCount: 2, rfClutter: 'dense_urban' }),
      undefined,
    ).find((d) => d.id === 'uav-01')!
    expect(relayed.linkViaRelayId).toBe('uav-relay')
    expect(relayed.bvlosFlag).toBe(false)
    expect(relayed.linkPacketLossPct!).toBeLessThan(low.linkPacketLossPct!)
    expect(relayed.linkLatencyMs!).toBeLessThan(low.linkLatencyMs!)
  })

  it('exposes the terms behind the signal, including which aircraft carries the hop', () => {
    const drones = applyCommsModel(
      [drone(5000, 120), drone(2500, 400, { id: 'uav-02', label: 'UAV-02' })],
      0,
      scenario({ droneCount: 2, rfClutter: 'urban' }),
      undefined,
    )
    const far = drones.find((d) => d.id === 'uav-01')!
    expect(far.linkMarginDb).toBeTypeOf('number')
    expect(far.linkLos).toBe(true)
    expect(far.linkViaRelayId).toBe('uav-02')

    // A grounded aircraft cannot relay.
    const grounded = applyCommsModel(
      [drone(5000, 120), drone(2500, 0, { id: 'uav-02', label: 'UAV-02', missionState: 'landed' })],
      0,
      scenario({ droneCount: 2, rfClutter: 'urban' }),
      undefined,
    ).find((d) => d.id === 'uav-01')!
    expect(grounded.linkViaRelayId).toBeNull()
  })

  it('leaves idle and landed aircraft untouched', () => {
    const idle = applyCommsModel([drone(100, 0, { missionState: 'idle', signalDbm: -55 })], 0, scenario(), undefined)[0]
    expect(idle.signalDbm).toBe(-55)
    expect(idle.linkMarginDb).toBeUndefined()
  })

  it('is deterministic and stateless across repeated evaluation', () => {
    const once = applyCommsModel([drone(1500, 200)], 12, scenario(), undefined)[0]
    const twice = applyCommsModel([drone(1500, 200)], 12, scenario(), undefined)[0]
    expect(twice).toEqual(once)
    // Feeding the model its own output changes nothing: there is no integrator.
    expect(applyCommsModel([once], 12, scenario(), undefined)[0].signalDbm).toBe(once.signalDbm)
  })

  it('the default radio is a plausible public-safety C2 link', () => {
    expect(DEFAULT_RADIO.frequencyMhz).toBe(2400)
    expect(DEFAULT_RADIO.sensitivityDbm).toBeLessThan(-90)
    // A drone at 500 m and 200 ft in suburban clutter should hold a comfortable link — if this
    // fails the whole catalog becomes unflyable, which is the real risk in a change like this.
    const state = applyCommsModel([drone(500, 200)], 0, scenario(), undefined)[0]
    expect(state.signalDbm).toBeGreaterThan(-80)
    expect(state.bvlosFlag).toBe(false)
  })
})
