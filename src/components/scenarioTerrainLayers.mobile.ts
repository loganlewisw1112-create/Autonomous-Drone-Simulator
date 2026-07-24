import type maplibregl from 'maplibre-gl'
import type { DeviceMode } from '@/hooks/useDeviceMode'

/** Mobile omits MapLibre 3D terrain — phone WebGL + bundle budget. */
export function removeScenarioTerrainLayer(_map: maplibregl.Map): void {
  /* no-op */
}

export async function addScenarioTerrainLayer(
  _map: maplibregl.Map,
  _maplibre: typeof maplibregl,
  _fixtureId: string | undefined,
  _deviceMode: DeviceMode,
): Promise<void> {
  /* no-op */
}
