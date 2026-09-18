# PROGRESS — 3D scene layer

Branch: feat/3d-scene-layer
Plan: AUTONOMOUS-PLAN-3d-view.md
Last updated: 2026-09-18T02:30:00-07:00
Repo: `D:\CODING\PROJECTS - CURRENTLY WORKING ON\portfolio_local_repo_ready\04-autonomous-drone-mission-simulator`

Claim marks: **V** = Verified (command named), **I** = Inferred (basis named), **U** = Unverified.

## State
Current phase: 3
Gate status: not attempted
Next concrete action: build the invisible shadow receivers. (1) `src/scene3d/terrainReceiver.ts`: mesh a heightfield from the LOCAL DEM fixture (`terrainRasterFor(fixtureId)` + `elevationAt`, x exactly the live exaggeration 1.15) - NOT from S3 tiles - covering only the shadow box (start 2 km radius around `frame.focus`, regenerate on camera move with hysteresis), `ShadowMaterial`, polygon offset per zoom band. CAUTION: MapLibre only DRAWS relief inside the whole-tile block and only at zoom >= 14 (see findings) - the receiver must be flat-at-0 exactly where the map is, or shadows will float; move the `liveTerrainBounds` logic out of the harness into `src/scene3d/`. (2) building receivers from the Overture `buildings.json` fixtures (`buildingFixtures.ts`). `train_wildfire_flank` has NO buildings - Gate 3.4 needs a second scenario (`demo_wildfire` or `hist_surfside_cts_2021`; check it launches via `runQuickDemo`). FALLBACK 3 is pre-approved: after 2 failed remediation attempts on 3.3/3.4/3.5 switch to projected blob-shadow decals and re-gate 3.1/3.2/3.7 only.

## Completed phases
- [x] P-0 preflight — `c352cb4` — `GATE P0 PASS assertions=17/17 failed=[]`, screenshots byte-identical (sha256 `54fc703b429ef5f9…`) across 4 cold launches in 2 gate runs **V** (`node harness/gates/run.mjs p0`)
- [x] Phase 0 render harness — `50d9260` — `GATE 0 PASS assertions=9/9 failed=[] p75_layer_ms=0.1` **V** (`node harness/gates/run.mjs 0`). **Architecture go/no-go: GO.** Terrain occludes scene geometry through the shared depth buffer at pitch 0, 60 **and 107**.

- [x] Phase 1 airframes + LOD - `3e6a2c7` - `GATE 1 PASS assertions=8/8 failed=[] p75_layer_ms=0.3` **V** (`node harness/gates/run.mjs 1`), first run, no remediation.

- [x] Phase 2 lighting - commit `feat(scene3d): solar-driven lighting...` - `GATE 2 PASS assertions=10/10 failed=[] p75_layer_ms=0.4` **V** (`node harness/gates/run.mjs 2`). One remediation: night levels (a lighting value, not a criterion).

## Gate 2 record
| # | Result **V** |
|---|---|
| 2.1 sun position | vs independent PSA/Python table at the AOI: dawn dAz 0.001 dEl 0.157, noon 0.004/0.008, dusk 0.001/0.162, night 0.002/0.010 (the low-sun elevation gap is refraction, which the reference omits); vs **NREL SPA published example: dAz 0.003 dEl 0.003**. Need <= 0.5 |
| 2.2 light follows sun | bright side of a matte sphere vs sun azimuth: dawn 0.0, noon 0.0, dusk 0.0, night 0.1 deg (need <= 10) |
| 2.3 night dark not black | night airframe luminance **4.7 %** of noon (need 2-20). First run 1.0 % -> raised night fill/environment intensities in `skyPalette.ts` |
| 2.4 strobe | exactly 2 upward mid-luminance crossings in 2 s of SIM time (1 Hz) |
| 2.5 determinism | lit frame across two cold launches: **0.0000 %** |
| 2.6 PMREM | 0 rebuilds over 300 frames at a fixed sun; exactly +1 when the sun moves |
| 2.7 budget | p75 **0.4 ms** with lighting + shadow pass, 20 aircraft, 18 draw calls (budget 5 ms) |
| 2.8 (extra) | lit-but-empty scene vs unmounted map: 0.0003 % - shadow/PMREM framebuffer switches do not bleed into MapLibre |
| 2.9 (extra) | scenario `timeOfDay` drives the sun: dawn az 72 el 5.0 / day az 180 el 67 / dusk az 288 el 4.8 / night el -33 |

## Gate 1 record
| # | Result **V** |
|---|---|
| 1.1 build | teal2 20 meshes / 1096 tris (low 467); x10 20 meshes / 1208 tris (low 494); 0 console errors |
| 1.2 silhouettes | span-normalised IoU: three-quarter **0.386**, top **0.297**, side **0.401** (need < 0.80 - tested from 3 views, plan asked for 1) |
| 1.3 LOD | 200 m -> 1096 tris, 800 m -> 467, 3000 m -> 16 (sprite); bands full/low/sprite confirmed structurally |
| 1.4 props | 3609 px changed across one 50 ms SIM step on uav-01 (need >= 100) |
| 1.5 instancing | 20 aircraft -> **9** draw calls (budget 40) |
| 1.6 budget | p75 **0.3 ms**, bands full 2 / low 10 / sprite 8 (budget 4 ms) |
| 1.7 weight | **164.2 KB** gz added JS (three + scene3d + harness) vs the shipped build (budget 250) |
| 1.8 (extra) | DOM drone markers opacity 1 -> 0 -> 1 across enable()/disable() |

## Gate 0 record
| # | Result **V** |
|---|---|
| 0.1 box renders | 1406 px of box colour at the projected position (need >= 400) |
| 0.2 geo-anchored | worst 0.71 px vs `map.project()` over zoom 12-18 + a pitch-50 view (need <= 2) |
| 0.3 @ pitch 0 | terrain on **0 px** / off 1260 px — box 8 m under the surface at UAV-01's lng/lat |
| 0.3 @ pitch 60 | terrain on **0 px** / off 2743 px — natural ridge clears the sight-line by 16 m, camera 330 m out, box 10 m AGL |
| 0.3 @ pitch 107 | terrain on **0 px** / off 2461 px — natural ridge clears by 10 m, camera 500 m out and *below* the box, box 30 m AGL |
| 0.4 no GL bleed | luminance delta 0.000 %, pixel diff 0.0006 % away from the box; frame not black (mean 229.6) |
| 0.4k kill switch | `scene.disable()` vs never-mounted frame: **0.0000 %** |
| 0.5 style stack | **139** layers before / mounted / after; 0 WebGL / GL_INVALID / shader console errors |
| 0.6 budget | layer `render()` p75 **0.1 ms** over 300 frames (budget 2 ms) |

Remediation history for 0.3 (none of it touched a criterion): attempt 1 searched for a ridge with a target altitude taken from `queryTerrainElevation()` right after a terrain re-enable, which returned 0 -> bogus geometry. Attempt 2 found real DEM ridges that MapLibre does not draw (see finding below). Attempt 3 restricted the search to relief MapLibre actually renders and walked the box AGL down 30 -> 10 -> 3 -> buried; natural ridges were found for both pitches, the buried fallback was never needed.

## Determinism record (P-0.6)
- **Noise floor: 0 % — byte-identical.** Every later diff threshold is therefore the plan's literal number, no 3× floor padding needed.
- Attempt 1 failed at 0.18 % of pixels. Cause, located by diff-clustering + `elementsFromPoint`: the screenshot caught MapLibre symbol labels mid cross-fade (placement fades ~300 ms *after* `areTilesLoaded()`), plus DOM markers mid-interpolation. Not unseeded sim state — fleet state was identical in both launches.
- Fix (attempt 2, passed): `__harness.ready()` additionally waits for MapLibre's `idle` event after a forced repaint, then 120 ms + 2 frames for marker interpolation. No app behaviour changed.
- Scenario: seed **20011** resolves in the active catalog to **`train_wildfire_flank`** (a refresh of the culled `extreme_cal_fire_dixie`; same seed). 5 aircraft: 4× `teal_2`, 1× `skydio_x10`. At T+31: uav-01 30 m AGL thermal_hold … uav-05 landed. DEM relief 850–1496 m — ample for the Gate 0 ridge-occlusion test.
- Browser: system Chrome via `channel: 'chrome'`, headed, 1600×1000, DSF 1 (cached Playwright Chromium builds did not match 1.63.0; nothing downloaded).

## Post-change verification (final preflight tree) **V**
`typecheck` 0 · `lint` 0 · `build` 0 · `assert:bundles` 0 · `assert:training-scope` 0 · tests `171 passed | 1 skipped`, `1272 passed | 3 skipped` — **identical to baseline**.
Public `dist/` contains **0** files matching `__harness|installHarness`; harness build contains 1. The harness is not shipped.

## Baseline (P-0.2) — recorded before any feature code
Cut from `e07f1bc` (see Deviations). `git status --porcelain` empty at cut. **V**
- `npm run typecheck` → exit 0 **V**
- `npm run lint` → exit 0 **V**
- `npm run build` (windows target) → exit 0 **V**
- `npx vitest run --pool=forks --no-file-parallelism` → exit 0; `Test Files 171 passed | 1 skipped (172)`, `Tests 1272 passed | 3 skipped (1275)` **V**
- **Baseline red set: EMPTY.** Any red from here on is damage caused by this work.
- Raw output: `artifacts/baseline/{typecheck,lint,build,test}.txt` (git-ignored).
- Caveat: the test run overlapped in wall-time with the three one-line `HARNESS_ENABLED` integration edits
  (flag folds to `false` under vitest, so behaviour-neutral **I**). The full suite is re-run at the end of
  preflight on the final tree; that run, not this one, is the comparison point for Gate 6.4.

## P-0.3 facts re-verified against source
| Claim | Result |
|---|---|
| `maplibre-gl` is 6.x | **V** lockfile resolves **6.9.0** (spec measured 6.6.0 on an older served build; same major) |
| Terrain is Terrarium | **V** `scenarioTerrainLayers.impl.ts:155` `encoding: 'terrarium'` |
| …from AWS | **Mismatch, non-fatal.** AWS `elevation-tiles-prod` is the fixture *provenance* only. At runtime the DEM is the committed per-scenario `terrain.png`, served to MapLibre through a custom protocol (`scenarioTerrainLayers.impl.ts:149-157`). No network DEM fetch. Better for determinism; **changes Phase 3** — the shadow receiver must mesh the local fixture (`terrainFixtureFor`), not S3 tiles |
| Exaggeration 1.15 | **V** `scenarioTerrainLayers.impl.ts:158` |
| Buildings are `fill-extrusion` from Overture | **V** `buildingFixtures.ts`, committed `buildings.json` for 6 AOs |
| Drones are DOM `Marker`s | **V** `TacticalMap.tsx:1133` |
| No three.js / custom layer | **V** grep `from 'three'|renderingMode|type: 'custom'` over `src/` → 0 files |
| Replay/determinism exists | **V** fixed-timestep `tick()` (50 ms), `SimulationLoop.ts:97`; results depend on step count only |

## Startup interstitials (P-0.5a) — enumerated
| Surface | Mounts when | Under `?harness=1` |
|---|---|---|
| `LoadingScreen` | every cold load | **suppressed at source** — `App.tsx` `useState(HARNESS_ENABLED)` |
| `WelcomeOverlay` | first visit, no scenario | **suppressed at source** — early `return null` |
| `ClassroomServerPrompt` + "INSECURE CLASSROOM DEVELOPMENT MODE" banner | **classroom-target builds only** (`VITE_CLASSROOM_ENABLED`) | never compiled into the harness build (windows target). This is what the plan author saw on :4173 — a classroom `dist/` |
| `PreflightChecklist`, `LaunchBayPlanner` | `ui.showX` state | never opened — harness launches via `runQuickDemo`, which bypasses both by design |
| `SignInModal`, `AccountPanels`, `EntitlementActivation`, `CustomMissionHub` | explicit user action | not reachable from a cold load |
| `WindowsPlatformGate` | non-Windows UA on windows target | **deliberately NOT bypassed** — product control. Harness runs on Windows |
| `UsagePolicyGate` (public-demo usage clock) | sessionStorage clock expiry | **deliberately NOT bypassed** — product/licensing control. Each probe launch is a cold profile, so the clock restarts |

## Decisions taken
- **Scenario clock = scenario date + `scenarioVariant.timeOfDay` + sim elapsed seconds** (`sceneClock.ts`). The variant enum is exactly `dawn|day|dusk|night`; each resolves to a real solar event at the AOI on the scenario's date (dawn/dusk = sun at 5 deg, day = local solar noon, night = solar midnight). Date = the observed-weather fixture's `realDate` where the scenario has one, else the 2024 September equinox (neutral, documented, not a claim about the incident). No wall clock anywhere.
- **Gate 2.1 reference is a different algorithm in a different language** (PSA, Python, `harness/reference/solar_reference.py`), and that script is itself checked against NREL SPA's published worked example. It caught a real bug in ITSELF first (Python `//` floors where the C original truncates: 0.75 deg elevation error) - the published value is what exposed it.
- **Gate 2.4 "crosses its midpoint exactly 2 times" is read as 2 UPWARD crossings = 2 flashes in 2 s = 1 Hz.** A flash crosses the midpoint twice (up, down), so any 1 Hz strobe gives 4 total crossings in 2 s; counting rises is the only reading under which "exactly 2" describes a 1 Hz strobe. Strobe phase is offset 0.5 s so a flash never straddles a whole-second boundary.
- **Below the horizon the directional light becomes twilight glow from the sun's azimuth** (elevation clamped to +6 deg, palette intensity) - physically where twilight comes from, and it keeps 2.2 meaningful at -10 deg.
- **Shadow box is fitted to the view**: centred on the camera's look-at point, radius = view width at that distance x1.8, clamped 40-1500 m, 2048^2. No tone mapping, so unlit test geometry keeps exact colours.
- **Nav lights are always on, scaled by palette darkness** (0.3 by day -> 1.0 at night), mounted on the front motor pods; strobe only with rotors turning.
- **Aircraft are drawn at 6x true size** (`AIRFRAME_VISUAL_SCALE`, one constant in `fleet.ts`). A 0.5 m quad is sub-pixel beyond ~60 m; the plan's own Phase 0 stand-in was a 3 m box. LOD distances are unchanged. Tune in the aesthetic pass.
- **Authoring vs rendering are separate:** builders return a `Group` of >= 12 named meshes (what 1.1 counts); `fleet.ts` bakes them into hull / props / gimbal / low InstancedMeshes per type + one shared sprite batch = 9 draw calls at any fleet size.
- **Prop phase = f(SIM elapsedSec), never wall clock**, so frozen-clock frames and replays are identical. Consequence: at 20 Hz sim ticks the props (and positions) advance in steps; inter-tick smoothing belongs to Phase 4 with the camera smoothing.
- **Aircraft height reference = the ground MapLibre DRAWS** (`queryTerrainElevation`) + true AGL, not the sim DEM. Outside the drawn relief and below zoom 14 the map is flat, and the aircraft then sits its AGL above that flat ground instead of floating 1.5 km up. This neutralises the visual half of the partial-tile finding below.
- **DOM markers go `opacity:0`, not hidden**, while the layer owns the fleet - they stay in the hit-test tree so click-to-select keeps working.
- **Placeholder light rig** (fixed hemisphere + directional) lives in `index.ts` only so PBR airframes are not black in Phase 1. Phase 2 deletes it.
- **3D layer is default-OFF and harness-only until Phase 6.** Nothing in the public bundle imports `src/scene3d/` yet, so three.js adds 0 bytes to shipped builds and the frozen v1.1 product cannot regress. The user-facing mount arrives with the quality tiers, after the owner's aesthetic review.
- **Render order (global, fixed):** custom layer is LAST in the GL stack; draped 2D layers and terrain are beneath it by construction, `fill-extrusion` occludes through depth, symbols are overdrawn by geometry in front of them, DOM markers/HUD stay on top. Written up in `src/scene3d/README.md`.
- **Scene Z = rendered elevation (DEM x 1.15); aircraft Z = rendered ground + true AGL.** Vertical scale is re-derived every frame from the map-centre latitude to stay welded to MapLibre's terrain.
- **ENU anchor = `scenario.startPosition`**, elevation 0.
- **Gate 0.3 at pitch 0** uses a box 8 m under the surface at UAV-01's lng/lat: looking straight down nothing can stand "between" camera and an airborne box, so burial is the only meaningful pitch-0 occlusion test. Same depth mechanism.
- **Gate 0.3 at pitch 60 / 107** uses synthetic box positions (10 m / 30 m AGL) because no ridge stands between any aircraft's true T+31 position and a camera at those pitches inside the drawn relief. Aircraft true positions are tried first, every run.
- **Gate 0.3 zoom lens:** vertical FOV is narrowed (~1-2 deg) so a 3 m box several hundred metres away still covers >= 400 px with terrain off. The box stays 3 m, per plan.
- **0.4 / kill-switch frames are taken back-to-back at one camera**, before any other test: MapLibre label placement is history-dependent, so frames either side of a long camera journey differ (0.33 % measured) for reasons unrelated to the layer.
- **Harness is double-locked** → compile-time `VITE_HARNESS=1` (set only by `harness/server.mjs`) AND run-time `?harness=1`. Public builds fold `HARNESS_ENABLED` to `false` and never emit the harness chunk. Plan asked for query-param only; this is strictly smaller blast radius on a publicly deployed app (§1.8).
- **Harness never bypasses product gates** (usage policy, platform gate, licensing, sign-in) — only self-dismissing onboarding chrome.
- **Browser** → Playwright bundled Chromium if a matching build is cached, else system Chrome via `channel: 'chrome'`. No browser download performed.
- **PNG decoding** → ~50-line inline decoder in `harness/assert.mjs`; no image dependency added (§1.3).
- **Gate "tree clean"** → interpreted as "no changes outside this phase's declared paths", since the gate necessarily runs before its own commit.

## Deviations from plan
- **glTF override path is `src/scene3d/airframes/models/<id>.glb`, not `public/models/`.** Resolved at build time with `import.meta.glob`, so with no file present there is no runtime probe, no 404 in the console, and GLTFLoader is never fetched. **Unverified** - no .glb has ever been loaded through it.
- **The fleet model has no LANDING state.** Landing pose (stowed gimbal, 75 % rotor speed) is inferred: `return_to_base` or `emergency` below 8 m AGL. THERMAL HOLD and INSPECT map directly. There is no gimbal telemetry either; gimbal pitch follows mission state.
- **`@types/three@0.186.0` added (dev-only, pinned).** three ships no TypeScript types; the alternative was an `any`-typed module shim. Outside section 1.3's literal allowlist; zero runtime/bundle effect.
- **Branch cut from `fix/maplibre-worker-prod-asset` (`e07f1bc`), not `main` (`e57e5dd`).** `e07f1bc` = `main` + one commit (open PR #96). Without it a production build never emits MapLibre's worker and the map renders blank — the harness serves a production build, so every pixel gate would be meaningless on `main`. Affects: when #96 squash-merges, merge `main` into this branch (no rebase, per §1.1).
- **Repo located by known path, not the one-level scan in P-0.1** — the simulator sits two levels below the project root, so the literal scan finds zero candidates. Identity still asserted by the gate (P0.1a).
- **`sim.seed(n)` selects, it does not force.** It loads the active-catalog scenario whose seed is `n` and refuses otherwise; it never overrides a scenario's seed (that would desync replay). 20011 → `train_wildfire_flank`.
- **`train_wildfire_flank` has no Overture buildings fixture.** Gate 3.4 (shadows climb buildings) will need a second harness scenario with `buildings.json` (candidates: `demo_wildfire`, `hist_surfside_cts_2021`). Note `hist_marshall_fire_2021` cannot fly: its observed 56 kt gust closes every launch bay ("no launch bay assigned") — that is the scenario working as designed.
- **`npm ci` not run**; `node_modules` was present. The first `npm install` reported `added 25, removed 10, changed 59`, i.e. `node_modules` had drifted from the lockfile and is now synced. Lockfile diff is additive only (+53 lines: three, playwright).
- **`/autocompact`, `/clear`** are interactive CLI commands not available to this runner; PROGRESS.md handoff discipline is kept regardless.

## Open findings (not blocking)
- **The basemap does not get dark at night.** Phase 2 lights the MODELS; MapLibre's 2D style stays daytime-bright, so a correctly dark night airframe sits on a bright map and additive nav-light glows wash out toward white. Not in the plan's Phase 2 scope; Phase 5 (sky/fog) is the natural place for a night dimming treatment. Needs an owner/taste decision.
- **Observed-weather fixtures carry no visibility field** ("visibility not in ERA5" in the fixture's own `aggregation` note). Plan Phase 5 keys height fog to "the open-meteo visibility field already being fetched" - that field does not exist here. Phase 5 will need a documented proxy or a new fixture field.
- **The map draws less relief than the sim flies over (pre-existing).** `scenarioTerrainLayers.impl.ts` `extractTile` serves only DEM tiles lying *wholly* inside the committed crop. `train_wildfire_flank`: 2x2 z14 tiles (~3.7 km) inside a ~5 km DEM. Outside that block MapLibre's ground is flat at 0 m while the sim uses real elevation — 3D aircraft there will float ~1.2-1.5 km above a flat map. Fix is small (pad partial tiles with edge/zero elevation) but it edits an existing file outside this plan's scope; needs an owner decision before Phase 3/4, where it becomes visible.
- **DEM source is `minzoom = maxzoom = 14`**: below zoom 14 the map shows no terrain at all (pre-existing).
- **maplibre-gl 6.9.0:** `setTerrain(null)` -> `setTerrain(spec)` leaves `queryTerrainElevation()` at 0 indefinitely (measured over 2.4 s with repaints). Harness treats `terrain.disable()` as one-way per page. Matters to Phase 6's "terrain on/off" matrix: each terrain-off cell needs its own page load, or terrain-off cells run last.
- `queryTerrainElevation()` returns `0`, not `null`, where terrain is on but no DEM tile exists — never trust it without the DEM cross-check in `__harness.terrain.elevationAt()`.
- `calculateCameraOptionsFromTo()` silently clamps at `maxZoom` 22; with a very narrow FOV the camera lands further away than asked. Phase 4's camera director must keep FOV/zoom inside that envelope.
- Plan docs + `cameraDirector.js` are committed at the repo root per *Before kickoff*. This repo is public; they go public if the branch is ever pushed.
- `node_modules` had drifted from the lockfile before this work (first `npm install` re-synced 94 packages). Baseline and post-change test totals are nevertheless identical.

## Files touched this phase (Phase 2)
- new: `src/scene3d/{sun,sceneClock,skyPalette,lighting}.ts`, `harness/reference/solar_reference.py`, `harness/gates/gate-2.mjs`
- changed: `src/scene3d/SceneLayer.ts` (focus point, shadow map on, renderer handed to the frame hook), `src/scene3d/fleet.ts` (nav lights + strobe batch, shadow casting), `src/scene3d/fleetBinding.ts` (`storeSunSource`), `src/scene3d/index.ts` (placeholder rig deleted -> `LightingRig`; sun override, beacons, test sphere), `src/scene3d/harness/installHarness.ts` (`lighting.*`), `src/scene3d/README.md`, `PROGRESS.md`
- **No existing app file touched in Phase 2.**
