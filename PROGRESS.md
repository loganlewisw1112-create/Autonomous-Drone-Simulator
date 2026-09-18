# PROGRESS — 3D scene layer

Branch: feat/3d-scene-layer
Plan: AUTONOMOUS-PLAN-3d-view.md
Last updated: 2026-09-18T00:20:00-07:00
Repo: `D:\CODING\PROJECTS - CURRENTLY WORKING ON\portfolio_local_repo_ready\04-autonomous-drone-mission-simulator`

Claim marks: **V** = Verified (command named), **I** = Inferred (basis named), **U** = Unverified.

## State
Current phase: 0
Gate status: not attempted
Next concrete action: add `@types/three@0.186.0` (dev), create `src/scene3d/SceneLayer.ts` + `src/scene3d/index.ts` (handle with enable/disable/addTestBox), write `harness/gates/gate-0.mjs`, run `npm run gate -- 0`.

## Completed phases
- [x] P-0 preflight — commit `chore(harness): …` — `GATE P0 PASS assertions=17/17 failed=[]`, screenshots byte-identical (sha256 `54fc703b429ef5f9…`) across 4 cold launches in 2 gate runs **V** (`node harness/gates/run.mjs p0`)

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
- **Harness is double-locked** → compile-time `VITE_HARNESS=1` (set only by `harness/server.mjs`) AND run-time `?harness=1`. Public builds fold `HARNESS_ENABLED` to `false` and never emit the harness chunk. Plan asked for query-param only; this is strictly smaller blast radius on a publicly deployed app (§1.8).
- **Harness never bypasses product gates** (usage policy, platform gate, licensing, sign-in) — only self-dismissing onboarding chrome.
- **Browser** → Playwright bundled Chromium if a matching build is cached, else system Chrome via `channel: 'chrome'`. No browser download performed.
- **PNG decoding** → ~50-line inline decoder in `harness/assert.mjs`; no image dependency added (§1.3).
- **Gate "tree clean"** → interpreted as "no changes outside this phase's declared paths", since the gate necessarily runs before its own commit.

## Deviations from plan
- **Branch cut from `fix/maplibre-worker-prod-asset` (`e07f1bc`), not `main` (`e57e5dd`).** `e07f1bc` = `main` + one commit (open PR #96). Without it a production build never emits MapLibre's worker and the map renders blank — the harness serves a production build, so every pixel gate would be meaningless on `main`. Affects: when #96 squash-merges, merge `main` into this branch (no rebase, per §1.1).
- **Repo located by known path, not the one-level scan in P-0.1** — the simulator sits two levels below the project root, so the literal scan finds zero candidates. Identity still asserted by the gate (P0.1a).
- **`sim.seed(n)` selects, it does not force.** It loads the active-catalog scenario whose seed is `n` and refuses otherwise; it never overrides a scenario's seed (that would desync replay). 20011 → `train_wildfire_flank`.
- **`train_wildfire_flank` has no Overture buildings fixture.** Gate 3.4 (shadows climb buildings) will need a second harness scenario with `buildings.json` (candidates: `demo_wildfire`, `hist_surfside_cts_2021`). Note `hist_marshall_fire_2021` cannot fly: its observed 56 kt gust closes every launch bay ("no launch bay assigned") — that is the scenario working as designed.
- **`npm ci` not run**; `node_modules` was present. The first `npm install` reported `added 25, removed 10, changed 59`, i.e. `node_modules` had drifted from the lockfile and is now synced. Lockfile diff is additive only (+53 lines: three, playwright).
- **`/autocompact`, `/clear`** are interactive CLI commands not available to this runner; PROGRESS.md handoff discipline is kept regardless.

## Open findings (not blocking)
- `three@0.186.0` ships no TypeScript types. Phase 0 will need `@types/three@0.186.0` (dev-only, types-only, verified to resolve) — outside §1.3's literal allowlist; the alternative is an `any`-typed module shim.
- Plan docs + `cameraDirector.js` are committed at the repo root per *Before kickoff*. This repo is public; they go public if the branch is ever pushed.

## Files touched this phase
- new: `harness/{config,server,probe,assert}.mjs`, `harness/gates/{run,gate-p0}.mjs`, `src/scene3d/harness/{flag,installHarness}.ts`, `PROGRESS.md`, plan docs, `cameraDirector.js`
- integration (each one line + import): `src/App.tsx`, `src/components/WelcomeOverlay.tsx`, `src/components/TacticalMap.tsx`, `vite.config.ts`
- `package.json` (+`three`, +`@playwright/test`, +`gate` script), `package-lock.json`, `.gitignore` (+`artifacts/`)
