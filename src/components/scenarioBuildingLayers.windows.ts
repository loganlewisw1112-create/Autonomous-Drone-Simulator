import type maplibregl from 'maplibre-gl'
import type { DeviceMode } from '@/hooks/useDeviceMode'

const LAYER_ID = 'scenario-buildings-extrusion'
const SOURCE_ID = 'scenario-buildings'

const heightColor: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'h'],
  0, '#334a52',
  8, '#55727a',
  20, '#7d8f94',
  50, '#b4c0c2',
]

export function removeScenarioBuildingLayer(map: maplibregl.Map, _deviceMode: DeviceMode): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID)
}

export function addScenarioBuildingLayer(
  map: maplibregl.Map,
  _deviceMode: DeviceMode,
  beforeId?: string,
): void {
  map.addLayer({
    id: LAYER_ID,
    type: 'fill-extrusion',
    source: SOURCE_ID,
    paint: {
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': 0,
      'fill-extrusion-color': heightColor,
      'fill-extrusion-opacity': 0.68,
    },
  }, beforeId)
}
