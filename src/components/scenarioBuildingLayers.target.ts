import type maplibregl from 'maplibre-gl'
import type { DeviceMode } from '@/hooks/useDeviceMode'
import { buildingRenderMode } from '@/components/tacticalMapGeoJson'

const FILL_LAYER_ID = 'scenario-buildings-fill'
const EXTRUSION_LAYER_ID = 'scenario-buildings-extrusion'
const SOURCE_ID = 'scenario-buildings'

const heightColor: maplibregl.ExpressionSpecification = [
  'interpolate', ['linear'], ['get', 'h'],
  0, '#334a52',
  8, '#55727a',
  20, '#7d8f94',
  50, '#b4c0c2',
]

export function removeScenarioBuildingLayer(map: maplibregl.Map, _deviceMode: DeviceMode): void {
  if (map.getLayer(EXTRUSION_LAYER_ID)) map.removeLayer(EXTRUSION_LAYER_ID)
  if (map.getLayer(FILL_LAYER_ID)) map.removeLayer(FILL_LAYER_ID)
}

export function addScenarioBuildingLayer(
  map: maplibregl.Map,
  deviceMode: DeviceMode,
  beforeId?: string,
): void {
  if (buildingRenderMode(deviceMode) === 'fill-extrusion') {
    map.addLayer({
      id: EXTRUSION_LAYER_ID,
      type: 'fill-extrusion',
      source: SOURCE_ID,
      paint: {
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': 0,
        'fill-extrusion-color': heightColor,
        'fill-extrusion-opacity': 0.68,
      },
    }, beforeId)
    return
  }

  map.addLayer({
    id: FILL_LAYER_ID,
    type: 'fill',
    source: SOURCE_ID,
    paint: {
      'fill-color': heightColor,
      'fill-opacity': 0.34,
      'fill-outline-color': '#b8c8cc',
    },
  }, beforeId)
}
