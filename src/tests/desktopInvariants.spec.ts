/**
 * LAW.1 guard: the desktop ("Windows") layout at >=981px is frozen.
 *
 * This phase made the mobile map full-bleed and gave drones per-platform
 * physics, both of which touch code the desktop shell also runs. These asserts
 * pin the desktop-side values to exactly what they were before the branch, so a
 * future refactor of the shared helpers can't quietly move desktop chrome.
 */
import { describe, it, expect } from 'vitest'
import { mapBadgeInsets } from '@/components/TacticalMap'
import { LEGACY_PLATFORM, LEGACY_FAA_SPEED_LIMIT_MS } from '@/sim/drone/platformCatalog'
import { stepDrone } from '@/sim/drone/DroneEntity'
import type { DroneCmd, DroneState } from '@/types'

describe('LAW.1 — desktop map chrome is unchanged', () => {
  it('keeps the historical in-map badge insets on desktop', () => {
    // Pre-branch literals: badges sat at 8px, the stacked thermal badge at 36px,
    // the FOLLOW button at 80px, and bottom-anchored chrome at 8/28px.
    expect(mapBadgeInsets('desktop')).toEqual({
      top: 8,
      topStacked: 36,
      topFollow: 80,
      bottom: 8,
      bottomRaised: 28,
    })
  })

  it('uses numeric (not calc-string) insets on desktop so nothing reflows', () => {
    for (const value of Object.values(mapBadgeInsets('desktop'))) {
      expect(typeof value).toBe('number')
    }
  })

  it('gives mobile string insets that clear the floating chrome', () => {
    const mobile = mapBadgeInsets('phone-portrait')
    for (const value of Object.values(mobile)) {
      expect(typeof value).toBe('string')
      expect(value).toContain('safe-area-inset')
    }
  })
})

describe('LAW.1 — the default physics path is the pre-branch airframe', () => {
  it('LEGACY_PLATFORM reproduces the original module constants exactly', () => {
    expect(LEGACY_PLATFORM.maxSpeedMs).toBe(12)
    expect(LEGACY_PLATFORM.turnRateDegS).toBe(90)
    expect(LEGACY_PLATFORM.accelMs2).toBe(3)
    expect(LEGACY_PLATFORM.climbRateFtS).toBe(5)   // 300 ft/min
    expect(LEGACY_PLATFORM.enduranceMultiplier).toBe(1)
    expect(LEGACY_FAA_SPEED_LIMIT_MS).toBe(25.4)
  })

  it('stepDrone called without a platform behaves as the legacy airframe', () => {
    const state = {
      id: 'uav-01', position: { lat: 37.77, lng: -122.41 }, altitudeFt: 100,
      headingDeg: 0, speedMs: 0, batteryPct: 100,
    } as unknown as DroneState
    const cmd = { throttle: 1, targetHeadingDeg: 0, targetAltitudeFt: 100 } as DroneCmd

    // Same call with and without the explicit legacy spec must agree.
    expect(stepDrone(state, cmd, 0.05)).toEqual(stepDrone(state, cmd, 0.05, LEGACY_PLATFORM))
  })
})
