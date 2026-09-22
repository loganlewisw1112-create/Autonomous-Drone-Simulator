// Shared constants for the deterministic render harness (see AUTONOMOUS-PLAN-3d-view.md P-0.4).
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PORT = 4290 // fixed; never 4173/5173 — must not collide with a dev server the user has up
export const BASE_URL = `http://127.0.0.1:${PORT}/?harness=1`
export const OUT_DIR = resolve(ROOT, 'artifacts', 'harness-dist')
export const ARTIFACTS = resolve(ROOT, 'artifacts')
export const VIEWPORT = { width: 1600, height: 1000 }

// The plan's scenario: seed 20011 is the CAL FIRE Dixie northern-flank mission. In the active
// catalog it is `train_wildfire_flank` (a refresh of the culled `extreme_cal_fire_dixie`, same
// seed) — Feather River canyon rim, real DEM, five aircraft. `sim.seed()` resolves it by seed.
export const SCENARIO_SEED = 20011
export const FREEZE_AT_SEC = 31
