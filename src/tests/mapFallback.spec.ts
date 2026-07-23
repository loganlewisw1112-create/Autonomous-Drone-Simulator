import { describe, expect, it } from 'vitest'
import { parseMapMode, shouldFallBackToLocalStyle } from '@/components/TacticalMap'

/**
 * Regression guard for the basemap downgrade.
 *
 * Symptom: the map rendered as a flat blue rectangle with no streets, in a build where the tile
 * host was reachable and returning 200. Cause: the fallback was gated on MapLibre's `load` event
 * — style parsed AND every visible tile rendered — so a 4.5 s timer routinely destroyed a working
 * basemap whenever rendering was slow, and any single tile/glyph/sprite error did the same.
 */
describe('basemap fallback decision', () => {
  it('keeps the real basemap once the style has parsed, however slow rendering is', () => {
    // The bug. Style is in, tiles still painting, timer fires — the map must survive.
    expect(shouldFallBackToLocalStyle({
      styleParsed: true, mapReady: false, alreadyFallenBack: false,
    })).toBe(false)
  })

  it('falls back only when the style itself never arrived', () => {
    expect(shouldFallBackToLocalStyle({
      styleParsed: false, mapReady: false, alreadyFallenBack: false,
    })).toBe(true)
  })

  it('never downgrades a map that is already fully up', () => {
    expect(shouldFallBackToLocalStyle({
      styleParsed: true, mapReady: true, alreadyFallenBack: false,
    })).toBe(false)
    // Defensive: ready without a parsed style should not happen, but must not downgrade either.
    expect(shouldFallBackToLocalStyle({
      styleParsed: false, mapReady: true, alreadyFallenBack: false,
    })).toBe(false)
  })

  it('is one-way — a second trigger cannot re-fire', () => {
    // Both the timer and the error handler can fire; the switch must be idempotent.
    expect(shouldFallBackToLocalStyle({
      styleParsed: false, mapReady: false, alreadyFallenBack: true,
    })).toBe(false)
  })

  it('still honours an explicit offline request', () => {
    // ?map=fallback is the deliberate no-network path and is decided before any of the above.
    expect(parseMapMode('?map=fallback')).toBe('fallback')
    expect(parseMapMode('')).toBe('remote')
    expect(parseMapMode('?map=')).toBe('remote')
    expect(parseMapMode('?join=ABC123')).toBe('remote')
  })
})
