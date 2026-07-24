import { NIST_LANE_SCENARIOS } from '@/scenarios/nistLanes'

/** Incident missions in the published catalog (excludes NIST skills drills). */
export const INCIDENT_MISSION_COUNT = 25

/** NIST standard test-method lanes — outside the 25 incident missions. */
export const NIST_MISSION_COUNT = 6

export const EXPECTED_CATALOG_COUNT = INCIDENT_MISSION_COUNT + NIST_MISSION_COUNT

/** Canonical historical disaster scenario ids (10). */
export const HISTORICAL_SCENARIO_IDS = [
  'hist_kilauea_leilani_2018',
  'hist_oso_sr530_2014',
  'hist_harvey_houston_2017',
  'hist_camp_fire_paradise_2018',
  'hist_surfside_cts_2021',
  'hist_helene_asheville_2024',
  'hist_katrina_lower_ninth_2005',
  'hist_joplin_ef5_2011',
  'hist_marshall_fire_2021',
  'hist_east_palestine_2023',
] as const

/** Training / refreshed incident ids (15) — tutorials plus operational drills. */
export const TRAINING_SCENARIO_IDS = [
  'demo_basic',
  'demo_sar',
  'demo_sar_coastal',
  'demo_perimeter',
  'demo_wildfire',
  'train_uscg_maritime_sar',
  'train_hazmat_plume',
  'train_welfare_grid',
  'train_wildfire_flank',
  'train_mountain_sar',
  'train_flood_corridor',
  'train_urban_usar',
  'train_tornado_sector',
  'train_night_relay_sar',
  'train_infra_inspection',
] as const

export const NIST_SCENARIO_IDS = NIST_LANE_SCENARIOS.map((s) => s.id)

export const ALL_INCIDENT_IDS = [...TRAINING_SCENARIO_IDS, ...HISTORICAL_SCENARIO_IDS] as const
