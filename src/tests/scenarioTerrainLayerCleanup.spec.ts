import { describe, expect, it, vi } from 'vitest'
import type * as maplibregl from 'maplibre-gl'
import { removeScenarioTerrainLayer } from '@/components/scenarioTerrainLayers.impl'

describe('scenario terrain layer cleanup', () => {
  it('is safe after MapLibre has already destroyed its style', () => {
    const disposedMap = {
      getTerrain: () => { throw new TypeError('style is gone') },
      getSource: () => { throw new TypeError('style is gone') },
    } as unknown as maplibregl.Map

    expect(() => removeScenarioTerrainLayer(disposedMap)).not.toThrow()
  })

  it('removes an attached terrain source once', () => {
    const setTerrain = vi.fn()
    const removeSource = vi.fn()
    const map = {
      getTerrain: () => ({ source: 'scenario-terrain-dem' }),
      setTerrain,
      getSource: () => ({}),
      removeSource,
    } as unknown as maplibregl.Map

    removeScenarioTerrainLayer(map)

    expect(setTerrain).toHaveBeenCalledWith(null)
    expect(removeSource).toHaveBeenCalledWith('scenario-terrain-dem')
  })
})
