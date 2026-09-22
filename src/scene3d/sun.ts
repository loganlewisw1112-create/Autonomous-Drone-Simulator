/**
 * Solar position — the NOAA Solar Calculator algorithm (Meeus-derived), inline. No dependency.
 *
 * Input is always an explicit instant; nothing here reads the wall clock. Callers pass the SCENARIO
 * clock (see sceneClock.ts) so a replay lights exactly as the original run did.
 *
 * Accuracy target: ±0.5° against independent references (Gate 2.1) — NOAA quotes ±0.0167° for
 * ±72° latitude, far tighter than lighting needs.
 */
const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export interface SunPosition {
  /** Degrees clockwise from true north. */
  azimuthDeg: number
  /** Degrees above the horizon, atmospheric refraction included. Negative = below. */
  elevationDeg: number
}

export function sunPosition(utcMs: number, latDeg: number, lngDeg: number): SunPosition {
  const julianDay = utcMs / 86_400_000 + 2_440_587.5
  const t = (julianDay - 2_451_545) / 36_525 // Julian centuries since J2000.0

  const meanLong = mod(280.46646 + t * (36_000.76983 + t * 0.0003032), 360)
  const meanAnom = 357.52911 + t * (35_999.05029 - 0.0001537 * t)
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
  const centre =
    Math.sin(meanAnom * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * RAD) * 0.000289
  const omega = 125.04 - 1934.136 * t
  const apparentLong = meanLong + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD)
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
  const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD)
  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLong * RAD))

  const y = Math.tan((obliquity / 2) * RAD) ** 2
  const equationOfTimeMin = 4 * DEG * (
    y * Math.sin(2 * meanLong * RAD) -
    2 * eccentricity * Math.sin(meanAnom * RAD) +
    4 * eccentricity * y * Math.sin(meanAnom * RAD) * Math.cos(2 * meanLong * RAD) -
    0.5 * y * y * Math.sin(4 * meanLong * RAD) -
    1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnom * RAD))

  const minutesUtc = mod(utcMs / 60_000, 1440)
  const trueSolarMin = mod(minutesUtc + equationOfTimeMin + 4 * lngDeg, 1440)
  const hourAngle = trueSolarMin / 4 - 180 // degrees; 0 at local solar noon, positive afternoon

  const lat = latDeg * RAD
  const cosZenith = clamp(Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle * RAD), -1, 1)
  const zenith = Math.acos(cosZenith)
  const geometricElevation = 90 - zenith * DEG

  const azDenominator = Math.cos(lat) * Math.sin(zenith)
  let azimuthDeg: number
  if (Math.abs(azDenominator) < 1e-9) {
    azimuthDeg = latDeg > 0 ? 180 : 0 // sun at the zenith/nadir: azimuth is undefined, pick the meridian
  } else {
    const a = Math.acos(clamp((Math.sin(lat) * cosZenith - Math.sin(declination)) / azDenominator, -1, 1)) * DEG
    azimuthDeg = hourAngle > 0 ? mod(a + 180, 360) : mod(540 - a, 360)
  }

  return { azimuthDeg, elevationDeg: geometricElevation + refractionDeg(geometricElevation) }
}

/** NOAA's piecewise atmospheric refraction, degrees. */
function refractionDeg(elevationDeg: number): number {
  if (elevationDeg > 85) return 0
  const tanE = Math.tan(elevationDeg * RAD)
  let arcsec: number
  if (elevationDeg > 5) arcsec = 58.1 / tanE - 0.07 / tanE ** 3 + 0.000086 / tanE ** 5
  else if (elevationDeg > -0.575) arcsec = 1735 + elevationDeg * (-518.2 + elevationDeg * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)))
  else arcsec = -20.772 / tanE
  return arcsec / 3600
}

/** Unit vector FROM the scene TOWARD the sun, in scene ENU (+X east, +Y north, +Z up). */
export function sunDirection({ azimuthDeg, elevationDeg }: SunPosition): [number, number, number] {
  const horizontal = Math.cos(elevationDeg * RAD)
  return [horizontal * Math.sin(azimuthDeg * RAD), horizontal * Math.cos(azimuthDeg * RAD), Math.sin(elevationDeg * RAD)]
}

function mod(value: number, by: number): number {
  return ((value % by) + by) % by
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}
