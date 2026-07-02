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
 * Generate parallel-track (lawnmower) waypoints for one drone in a multi-drone SAR.
 * Each drone gets interleaved rows: drone 0 → rows 0,3,6…; drone 1 → rows 1,4,7…; etc.
 * Adjacent rows within a drone's set alternate direction for continuous coverage.
 */
export function generatePerDroneWaypoints(
  searchArea: LatLng[],
  trackSpacingFt: number,
  droneIndex: number,
  droneCount: number,
  altitudeFt: number,
): Waypoint[] {
  if (searchArea.length < 3) return []

  const { minLat, maxLat, minLng, maxLng } = boundingBox(searchArea)
  const spacingDeg = (trackSpacingFt * 0.3048) / METERS_PER_DEG_LAT

  const waypoints: Waypoint[] = []
  let globalRow = 0
  let localRow = 0
  let lat = minLat + spacingDeg / 2

  while (lat <= maxLat) {
    if (globalRow % droneCount === droneIndex) {
      // Alternate direction on each of this drone's rows
      const goEast = localRow % 2 === 0
      waypoints.push(
        {
          id: `sar-d${droneIndex}-r${globalRow}-a`,
          position: { lat, lng: goEast ? minLng : maxLng },
          altitudeFt,
          label: `SAR-${globalRow + 1}`,
        },
        {
          id: `sar-d${droneIndex}-r${globalRow}-b`,
          position: { lat, lng: goEast ? maxLng : minLng },
          altitudeFt,
          label: `SAR-${globalRow + 1}B`,
        },
      )
      localRow++
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

  const { minLat, maxLat, minLng, maxLng } = boundingBox(searchArea)
  const spacingDeg = (trackSpacingFt * 0.3048) / METERS_PER_DEG_LAT

  const lines: Array<[LatLng, LatLng]> = []
  let lat = minLat + spacingDeg / 2

  while (lat <= maxLat) {
    lines.push([{ lat, lng: minLng }, { lat, lng: maxLng }])
    lat += spacingDeg
  }

  return lines
}
