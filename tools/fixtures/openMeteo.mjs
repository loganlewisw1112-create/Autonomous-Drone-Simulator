// Open-Meteo ERA5 historical archive fetch + normalisation (REALISM_ROADMAP WP-2 / WP-0).
//
// Authoring-time ONLY. This file lives under tools/, is never bundled, and is never imported
// by src/ — that is what keeps the determinism rule (§3) intact: real data is fetched here,
// frozen to a committed fixture, and never fetched at runtime.
//
// ERA5 note: `visibility` is not provided by the ERA5 archive (units come back "undefined",
// values null), so it is deliberately omitted from the observed baseline rather than guessed —
// scenarios keep their profile visibility. Wind/gust are in knots, temperature in °F, matching
// ScenarioWeatherProfile.baseConditions units exactly.

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive'
export const OPEN_METEO_LICENSE = 'CC BY 4.0 — Open-Meteo (ECMWF ERA5 reanalysis)'

const nums = (a) => (Array.isArray(a) ? a.filter((x) => x != null) : [])
const max = (a) => (a.length ? Math.max(...a) : null)
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10)

export async function fetchObservedWeather({ lat, lng, date }) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    start_date: date,
    end_date: date,
    hourly: 'temperature_2m,wind_speed_10m,wind_gusts_10m,cloud_cover',
    wind_speed_unit: 'kn',
    temperature_unit: 'fahrenheit',
    timezone: 'auto',
  })
  const url = `${ARCHIVE_URL}?${params.toString()}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status} for ${lat},${lng} ${date}`)
  const json = await res.json()
  const h = json.hourly ?? {}

  // Baseline = the day's operational peak for wind/gust (what you plan around) and mean temp.
  const observed = {
    windKts: round1(max(nums(h.wind_speed_10m))),
    gustKts: round1(max(nums(h.wind_gusts_10m))),
    tempF: (() => { const m = mean(nums(h.temperature_2m)); return m == null ? null : Math.round(m) })(),
    cloudCoverPct: max(nums(h.cloud_cover)),
    aggregation: 'daily peak wind/gust, mean temperature; visibility not in ERA5',
  }
  return { url, license: OPEN_METEO_LICENSE, observed }
}
