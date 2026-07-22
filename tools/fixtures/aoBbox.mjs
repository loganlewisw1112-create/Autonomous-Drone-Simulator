// Area-of-operations bbox derivation for the fixture pipeline (REALISM_ROADMAP WP-0 / WP-3).
//
// Authoring-time ONLY, and pure: arithmetic over a scenario object, no I/O and no network.
// Lives under tools/, so it is never bundled and never imported by src/ — that is the whole
// point of the determinism rule (§3). The fixture fetchers import it to decide *where* to ask.
//
// WHY THIS EXISTS. tools/fixtures/scenarios.json pins a single lat/lng per scenario, which is
// all WP-2 needed — Open-Meteo answers for a point. WP-3 cannot work that way: the FAA UAS
// Facility Map is a 30 x 30 arc-second graticule (~925 m cells in the lower 48, §WP-3), so one
// point resolves one cell while a real route crosses several, each with its own published
// ceiling. The alternative — hand-maintaining a bbox per scenario in a second file — would
// silently drift out of sync the first time a waypoint moved, and a stale AO box means a route
// flying over cells nobody fetched. So the envelope is DERIVED from the scenario's own
// committed geometry instead: everywhere the aircraft are planned to go, plus everywhere they
// are fenced away from (a geofence corner is somewhere the safe-path router may legitimately
// detour to, so it belongs inside the AO).

/**
 * Margin added on every side of the raw geometry envelope, in metres.
 *
 * One UASFM cell is ~925 m across, so a margin of at least one cell guarantees that the cell
 * *containing* a point sitting exactly on the AO boundary is fetched whole rather than clipped.
 * 1500 m is that guarantee plus operational slack for RTB legs and geofence detours, and on a
 * typical 1-2 km AO it still lands well inside the ~20 KB per-scenario budget in §19.
 */
export const DEFAULT_AO_MARGIN_M = 1500

const METRES_PER_DEG_LAT = 111320
// Guards the 1/cos(lat) term against blowing up near the poles. All 21 scenarios are US-located
// so this never binds in practice; it exists so a bad input yields a big box, not Infinity.
const MIN_COS_LAT = 0.01

const isFinitePoint = (p) => p != null && Number.isFinite(p.lat) && Number.isFinite(p.lng)

/**
 * Every committed geometry point that defines a scenario's area of operations.
 *
 * Deliberately includes the geofences: the operator is fenced *away* from them, but the
 * safe-path router in routeAudit.ts detours around their buffered perimeter, so those corners
 * are reachable airspace and their published ceilings matter.
 *
 * Deliberately excludes heatSources — contacts are what the mission is looking for, not where
 * it is authorised to fly, and in every catalog scenario they already sit inside the searched
 * envelope anyway.
 *
 * @param {object} scenario a ScenarioConfig-shaped object (see src/types/index.ts)
 * @returns {Array<{lat: number, lng: number}>}
 */
export function aoPoints(scenario) {
  const points = []
  const push = (p) => { if (isFinitePoint(p)) points.push({ lat: p.lat, lng: p.lng }) }
  const pushAll = (list) => { if (Array.isArray(list)) list.forEach(push) }
  const pushWaypoints = (list) => { if (Array.isArray(list)) list.forEach((wp) => push(wp?.position)) }

  push(scenario?.startPosition)
  pushWaypoints(scenario?.waypoints)
  pushAll(scenario?.searchArea)

  Object.values(scenario?.perDroneWaypoints ?? {}).forEach(pushWaypoints)
  Object.values(scenario?.authoredRoutes ?? {}).forEach(pushWaypoints)
  Object.values(scenario?.perDroneStartPositions ?? {}).forEach(push)
  Object.values(scenario?.launchSites ?? {}).forEach((site) => push(site?.position))
  Object.values(scenario?.recoverySites ?? {}).forEach((site) => push(site?.position))
  Object.values(scenario?.perDroneRechargeStations ?? {}).forEach(pushAll)

  if (Array.isArray(scenario?.rechargeStations)) {
    scenario.rechargeStations.forEach((station) => push(station?.position))
  }
  if (Array.isArray(scenario?.geofences)) {
    scenario.geofences.forEach((gf) => pushAll(gf?.polygon))
  }

  return points
}

/**
 * The AO envelope for a scenario, as an ArcGIS-style WGS84 envelope.
 *
 * Rounded to 6 decimal places (~0.1 m) so the query URL — and therefore the SHA-256 the
 * manifest records for the fixture — is stable across runs. Byte-identical regeneration from a
 * clean checkout is WP-0's acceptance criterion, and a bbox that jitters in the 12th decimal
 * would quietly break it.
 *
 * @param {object} scenario a ScenarioConfig-shaped object
 * @param {{ marginM?: number }} [options]
 * @returns {{ xmin: number, ymin: number, xmax: number, ymax: number }}
 */
export function aoBbox(scenario, options = {}) {
  const marginM = options.marginM ?? DEFAULT_AO_MARGIN_M
  const points = aoPoints(scenario)
  if (points.length === 0) {
    throw new Error(`aoBbox: scenario "${scenario?.id ?? '?'}" has no usable geometry to derive an AO from`)
  }

  const lats = points.map((p) => p.lat)
  const lngs = points.map((p) => p.lng)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2

  const dLat = marginM / METRES_PER_DEG_LAT
  const dLng = marginM / (METRES_PER_DEG_LAT * Math.max(MIN_COS_LAT, Math.cos((midLat * Math.PI) / 180)))

  return {
    xmin: round6(clamp(Math.min(...lngs) - dLng, -180, 180)),
    ymin: round6(clamp(Math.min(...lats) - dLat, -90, 90)),
    xmax: round6(clamp(Math.max(...lngs) + dLng, -180, 180)),
    ymax: round6(clamp(Math.max(...lats) + dLat, -90, 90)),
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6
}
