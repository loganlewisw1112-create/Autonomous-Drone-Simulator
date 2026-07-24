import type { LatLng, ScenarioConfig, Waypoint } from '@/types'

const M_PER_DEG_LAT = 111_320

/** Offset a point by meters north/east from an origin. */
export function offsetM(origin: LatLng, northM: number, eastM: number): LatLng {
  const metersPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180)
  return {
    lat: origin.lat + northM / M_PER_DEG_LAT,
    lng: origin.lng + eastM / metersPerDegLng,
  }
}

/** Build parallel search lanes — each drone sweeps west→east with capped dwells. */
export function parallelLanes(
  origin: LatLng,
  droneCount: number,
  laneSpacingM: number,
  sweepEastM: number,
  prefix: string,
  altitudeFt: number,
): Record<string, Waypoint[]> {
  const routes: Record<string, Waypoint[]> = {}
  for (let i = 0; i < droneCount; i += 1) {
    const id = `uav-${String(i + 1).padStart(2, '0')}`
    const laneOrigin = offsetM(origin, i * laneSpacingM - ((droneCount - 1) * laneSpacingM) / 2, 0)
    routes[id] = [
      { id: `${prefix}-${id}-w`, position: offsetM(laneOrigin, 0, -sweepEastM / 2), altitudeFt, label: `Lane${i + 1}-W`, dwellTimeSec: 12 },
      { id: `${prefix}-${id}-m`, position: laneOrigin, altitudeFt, label: `Lane${i + 1}-Mid`, dwellTimeSec: 15 },
      { id: `${prefix}-${id}-e`, position: offsetM(laneOrigin, 0, sweepEastM / 2), altitudeFt, label: `Lane${i + 1}-E`, dwellTimeSec: 12 },
    ]
  }
  return routes
}

/** Relay route with two legs — avoids indefinite single-point hover (Phase 2 discipline). */
export function relayRoute(origin: LatLng, legEastM: number, prefix: string, altitudeFt: number): Waypoint[] {
  return [
    { id: `${prefix}-relay-a`, position: origin, altitudeFt, label: 'Relay-A', dwellTimeSec: 20 },
    { id: `${prefix}-relay-b`, position: offsetM(origin, 0, legEastM), altitudeFt: altitudeFt - 20, label: 'Relay-B', dwellTimeSec: 18 },
  ]
}

/** Cap authored dwell times so runtime never inherits multi-minute holds. */
export function capRouteDwells(routes: Record<string, Waypoint[]>, maxSec = 25): Record<string, Waypoint[]> {
  return Object.fromEntries(
    Object.entries(routes).map(([droneId, waypoints]) => [
      droneId,
      waypoints.map((wp) => ({
        ...wp,
        dwellTimeSec: wp.dwellTimeSec !== undefined ? Math.min(wp.dwellTimeSec, maxSec) : undefined,
      })),
    ]),
  )
}

/** Shallow-clone a scenario with a new id/name and route dwell caps. */
export function refreshScenario(
  base: ScenarioConfig,
  overrides: Partial<ScenarioConfig> & Pick<ScenarioConfig, 'id' | 'name'>,
): ScenarioConfig {
  const perDroneWaypoints = base.perDroneWaypoints
    ? capRouteDwells(base.perDroneWaypoints)
    : undefined
  return {
    ...base,
    ...overrides,
    perDroneWaypoints: overrides.perDroneWaypoints ?? perDroneWaypoints,
  }
}
