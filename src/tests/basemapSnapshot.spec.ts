// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { captureBasemap } from '@/components/classroom/basemapSnapshot'

/**
 * The shared basemap capture underpinning the classroom wall.
 *
 * §16.2 rules out a MapLibre instance per tile (browsers cap live WebGL contexts at ~8-16), so a
 * 40-student wall cannot give every tile its own map. But every student in a class flies the SAME
 * scenario over the SAME area, so the basemap is one picture the whole class shares — rendered
 * once by a single transient instance and blitted by all 40 tiles.
 *
 * jsdom has no WebGL, so what is exercised here is the contract that matters most: the capture
 * must DEGRADE, never throw and never hang. A classroom on a locked-down laptop or a dead network
 * still gets its wall, just without streets under it.
 */
describe('shared basemap capture', () => {
  const bbox = { minLat: 37.876, maxLat: 37.921, minLng: -122.267, maxLng: -122.21 }

  it('resolves null instead of throwing when WebGL is unavailable', async () => {
    // The single most important property: a failure here must not take the console down.
    await expect(captureBasemap({ bbox, width: 480, height: 320 })).resolves.toBeNull()
  })

  it('refuses a degenerate canvas rather than dividing by zero', async () => {
    await expect(captureBasemap({ bbox, width: 0, height: 320 })).resolves.toBeNull()
    await expect(captureBasemap({ bbox, width: 480, height: 0 })).resolves.toBeNull()
  })

  it('cleans up its offscreen host on every path', async () => {
    const before = document.body.childElementCount
    await captureBasemap({ bbox, width: 480, height: 320 })
    await captureBasemap({ bbox, width: 0, height: 0 })
    // A capture that leaked its container would accumulate a hidden 480px div per class.
    expect(document.body.childElementCount).toBe(before)
  })

  it('is safe to call repeatedly', async () => {
    const results = await Promise.all([
      captureBasemap({ bbox, width: 480, height: 320 }),
      captureBasemap({ bbox, width: 480, height: 320 }),
      captureBasemap({ bbox, width: 480, height: 320 }),
    ])
    expect(results).toEqual([null, null, null])
    expect(document.body.querySelectorAll('div').length).toBe(0)
  })
})
