import type { LatLng, Waypoint } from '@/types'

const METERS_PER_DEG_LAT = 111000

function boundingBox(polygon: LatLng[]) {
  return {
    minLat: Math.min(...polygon.map((p) => p.lat)),
    maxLat: Math.max(...polygon.map((p) => p.lat)),
    minLng: Math.min(...polygon.map((p) => p.lng)),
    maxLng: Math.max(...polygon.map((p) => p.lng)),
  }
}

/**
 * Scan-line clip: the inside span of a horizontal line at `lat` across the polygon.
 * Even-odd intersection pairs are inside spans; the widest is returned so tracks stay inside
 * non-rectangular search areas instead of sweeping the whole bounding box.
 * Known simplification: concave polygons with multiple spans at one latitude fly only the
 * widest span (single-segment rows keep the lawnmower pattern flyable).
 */
function rowSpanAtLat(polygon: LatLng[], lat: number): [number, number] | null {
  const crossings: number[] = []
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    if ((a.lat > lat) !== (b.lat > lat)) {
      crossings.push(a.lng + ((lat - a.lat) / (b.lat - a.lat)) * (b.lng - a.lng))
    }
  }
  if (crossings.length < 2) return null
  crossings.sort((p, q) => p - q)
  let best: [number, number] | null = null
  for (let k = 0; k + 1 < crossings.length; k += 2) {
    if (!best || crossings[k + 1] - crossings[k] > best[1] - best[0]) {
      best = [crossings[k], crossings[k + 1]]
    }
  }
  return best
}

/**
 * Generate parallel-track (lawnmower) waypoints for one drone in a multi-drone SAR.
 * Each drone gets interleaved rows: drone 0 → rows 0,3,6…; drone 1 → rows 1,4,7…; etc.
 * Adjacent rows within a drone's set alternate direction for continuous coverage.
 * Rows are clipped to the search polygon (see rowSpanAtLat), not its bounding box.
 */
export function generatePerDroneWaypoints(
  searchArea: LatLng[],
  trackSpacingFt: number,
  droneIndex: number,
  droneCount: number,
  altitudeFt: number,
): Waypoint[] {
  if (searchArea.length < 3) return []

  const { minLat, maxLat } = boundingBox(searchArea)
  const spacingDeg = (trackSpacingFt * 0.3048) / METERS_PER_DEG_LAT

  const waypoints: Waypoint[] = []
  let globalRow = 0
  let localRow = 0
  let lat = minLat + spacingDeg / 2

  while (lat <= maxLat) {
    if (globalRow % droneCount === droneIndex) {
      const span = rowSpanAtLat(searchArea, lat)
      if (span) {
        const [west, east] = span
        // Alternate direction on each of this drone's rows
        const goEast = localRow % 2 === 0
        waypoints.push(
          {
            id: `sar-d${droneIndex}-r${globalRow}-a`,
            position: { lat, lng: goEast ? west : east },
            altitudeFt,
            label: `SAR-${globalRow + 1}`,
          },
          {
            id: `sar-d${droneIndex}-r${globalRow}-b`,
            position: { lat, lng: goEast ? east : west },
            altitudeFt,
            label: `SAR-${globalRow + 1}B`,
          },
        )
        localRow++
      }
    }
    lat += spacingDeg
    globalRow++
  }

  return waypoints
}

/** All track lines in the search area — used to render the SAR grid on the map. */
export function generateGridLines(
  searchArea: LatLng[],
  trackSpacingFt: number,
): Array<[LatLng, LatLng]> {
  if (searchArea.length < 3) return []

  const { minLat, maxLat } = boundingBox(searchArea)
  const spacingDeg = (trackSpacingFt * 0.3048) / METERS_PER_DEG_LAT

  const lines: Array<[LatLng, LatLng]> = []
  let lat = minLat + spacingDeg / 2

  while (lat <= maxLat) {
    const span = rowSpanAtLat(searchArea, lat)
    if (span) {
      lines.push([{ lat, lng: span[0] }, { lat, lng: span[1] }])
    }
    lat += spacingDeg
  }

  return lines
}
