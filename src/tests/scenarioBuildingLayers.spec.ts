import { describe, expect, it } from 'vitest'
import type maplibregl from 'maplibre-gl'
import {
  addScenarioBuildingLayer as addMobileLayer,
  removeScenarioBuildingLayer as removeMobileLayer,
} from '@/components/scenarioBuildingLayers.mobile'
import {
  addScenarioBuildingLayer as addWindowsLayer,
  removeScenarioBuildingLayer as removeWindowsLayer,
} from '@/components/scenarioBuildingLayers.windows'

function mapHarness() {
  const layers = new Map<string, maplibregl.LayerSpecification>()
  const calls: Array<{ layer: maplibregl.LayerSpecification; beforeId?: string }> = []
  const map = {
    addLayer(layer: maplibregl.LayerSpecification, beforeId?: string) {
      calls.push({ layer, beforeId })
      layers.set(layer.id, layer)
      return this
    },
    getLayer(id: string) {
      return layers.get(id)
    },
    removeLayer(id: string) {
      layers.delete(id)
      return this
    },
  } as unknown as maplibregl.Map
  return { calls, layers, map }
}

describe('target-specific scenario building layers', () => {
  it('registers and removes only the 2D footprint layer in the mobile implementation', () => {
    const { calls, layers, map } = mapHarness()
    addMobileLayer(map, 'phone-portrait', 'thermal-circle')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      beforeId: 'thermal-circle',
      layer: { id: 'scenario-buildings-fill', type: 'fill', source: 'scenario-buildings' },
    })
    removeMobileLayer(map, 'phone-landscape')
    expect(layers.size).toBe(0)
  })

  it('registers and removes the 2.5D layer in the Windows implementation', () => {
    const { calls, layers, map } = mapHarness()
    addWindowsLayer(map, 'desktop')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      layer: { id: 'scenario-buildings-extrusion', type: 'fill-extrusion', source: 'scenario-buildings' },
    })
    removeWindowsLayer(map, 'desktop')
    expect(layers.size).toBe(0)
  })
})
