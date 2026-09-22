# AUTONOMOUS EXECUTION PLAN — 3D scene layer for Drone Ops Center

Target runner: Claude Code, Fable 5.1, no human in the loop.
Companion document: `SPEC-3d-view.md` (the what). This document is the how, and it overrides the
spec wherever the two disagree.
Written 2026-09-17.

---

## READ THIS FIRST — three corrections to the premise

**1. Phase 1 of the spec is not autonomously executable and has been replaced.**
The spec says "source or model as glTF 2.0." An agent with no human cannot license, choose, or
validate 3D model assets, and will either hallucinate a download URL or ship whatever it finds.
Phase 1 is rewritten to build both airframes **procedurally in code** from three.js primitives.
Deterministic, zero licensing, ~40 KB instead of 2 MB, and still real PBR-shaded animated meshes.
A glTF override path is left open for later, when you can pick assets yourself.

**2. Self-generated golden images verify nothing.**
An agent that renders an image, saves it as the golden, and then compares against it has proved
only that its code is deterministic. The spec's "golden-image comparison, threshold tuned once"
is circular under autonomy. Replaced throughout with **property-based pixel assertions** — claims
about what must be true of the pixels (this region must darken when the sun moves; this pixel must
be sky, not background; this silhouette must vanish behind a ridge) that fail on wrongness, not
just on change. Goldens are still captured, but only as regression tripwires *after* a property
assertion has passed.

**3. "Runs until it completes successfully" holds for the engineering, not for taste.**
Every gate in this plan is a command that exits 0 or 1. None of them can tell you whether the
result looks good. The run terminates when the engineering is verifiably correct and leaves you a
review bundle of screenshots per phase. Budget an aesthetic pass with you afterward — it is
deferred, not eliminated. Anyone who tells you an agent can close that loop alone is selling
something.

Everything else in the spec survives. The architecture decision (three.js as a MapLibre custom
layer, not a renderer swap) stands, and the Phase 0 gate stands as the thing that can invalidate
the whole plan in the first three days.

---

## BEFORE KICKOFF — files that must be on disk

Place all three in the repo root before starting. The plan references them by name and the
preflight gate checks for them.

| File | Why |
|---|---|
| `AUTONOMOUS-PLAN-3d-view.md` | this document |
| `SPEC-3d-view.md` | the what; Part 3 phases cite its §0 facts |
| `cameraDirector.js` | consumed by Phase 4. **If absent, Phase 4 must write it from scratch** against the mode descriptions in Phase 4 and the camera facts in SPEC §0 — do not skip the phase and do not fetch it from anywhere |

## KICKOFF — paste this into Claude Code

```
Read AUTONOMOUS-PLAN-3d-view.md and SPEC-3d-view.md in full before doing anything.

Execute the plan autonomously. Do not ask me questions — every fork in the plan has a
pre-committed decision. Follow the execution contract in Part 1 exactly, including the
PROGRESS.md protocol and the context-budget rule.

Start at Part 2 (PREFLIGHT). Do not write any feature code until the preflight gate passes.

If you hit an abort condition, write ABORT.md with the evidence and stop. Do not push through.
```

---

# PART 1 — EXECUTION CONTRACT

Non-negotiable. Violating any clause here is a failure even if the feature works.

## 1.1 Git

- Work on branch `feat/3d-scene-layer`, cut from the current default branch at preflight.
- **Commit at every phase gate**, immediately after the gate passes, with the gate output quoted
  in the commit body. Approving this plan is the authorization for those commits.
- **Never push. Never force-push. Never rewrite history. Never delete a branch.**
- Never `git add -A` from the repo root. Stage explicit paths.
- If the working tree is dirty at preflight, stash it, record the stash ref in PROGRESS.md, and
  proceed on a clean tree.

## 1.2 Prohibited actions, full stop

No confirmation flow exists, so these are simply forbidden for the whole run:

- Pushing to any remote, opening a PR, or touching CI configuration.
- Deleting or disabling any existing test. A test that fails because of this work is a finding to
  be fixed or reported, never removed. Weakening an assertion to get green is the same violation.
- Adding any npm dependency other than `three` (see 1.3).
- Mass file deletion, moving directories, or reorganising anything outside the new
  `src/scene3d/` and `harness/` trees.
- Modifying the 139 existing style layers' definitions. The 3D layer *hides* 2D layers at
  runtime; it does not edit them.
- Anything that spends money, sends a message, or calls an external API not already used by the
  app (the app already calls OpenFreeMap, AWS Terrain Tiles, Overture, open-meteo — that list does
  not grow).
- Running parallel agents that write code. Read-only fan-out for search is fine; concurrent
  writers are not.

## 1.3 Dependencies

Exactly one runtime dependency is added:

```
three@0.186.0        # verified on registry.npmjs.org 2026-09-17
```

Dev-only, and only if not already present: `@playwright/test`. If Playwright is already in the
repo, use the existing version rather than bumping it.

Before installing anything, verify it resolves on the real registry and pin the exact version — no
carets. If `three@0.186.0` no longer resolves, install the highest `0.186.x`, record the deviation
in PROGRESS.md, and continue. Do not jump a minor.

**Do not** add: a scene-graph wrapper, a post-processing library, a physics engine, a shadow
library, `react-three-map`, `maplibre-three-plugin`, `threebox`, or a solar-position package.
Solar position is ~80 lines of NOAA algorithm written inline in `src/scene3d/sun.ts`.

## 1.4 PROGRESS.md protocol

Create `PROGRESS.md` at the repo root during preflight. It is the handoff artifact and the single
source of truth about run state. Update it:

- at every phase gate (pass or fail),
- before any `/clear`,
- whenever a pre-committed fallback is taken,
- whenever a deviation from this plan is made.

Template:

```markdown
# PROGRESS — 3D scene layer

Branch: feat/3d-scene-layer
Plan: AUTONOMOUS-PLAN-3d-view.md
Last updated: <ISO timestamp>

## State
Current phase: <P-0 | 0 | 1 | ... | 6 | DONE | ABORTED>
Gate status: <not attempted | attempt N failed | PASSED>
Next concrete action: <one sentence, actionable from cold start>

## Completed phases
- [x] P-0 preflight — <commit sha> — gate output: <one line>

## Decisions taken
- <fork name> → <branch chosen> → <why, per plan section X.Y>

## Deviations from plan
- <what, why, what it affects>

## Open findings (not blocking)
- <thing noticed, deliberately not fixed, per atomic-diff rule>

## Files touched this phase
- <paths>
```

## 1.5 Context budget

At **45% context used**: stop taking new scope, land the current unit of work, update PROGRESS.md
with decisions, rationale, unresolved items, exact next step and files touched, then `/clear` and
resume from PROGRESS.md + this plan. Prefer `/clear` with a good handoff over `/compact`.

Set the auto-compact window before starting: Fable 5.1 has a 1M window, so `/autocompact 450k`.

## 1.6 Anti-drift

- Re-read this plan's current-phase section every **5 tool-heavy steps**. Plan adherence decays
  measurably as context fills; this is the cheapest counter.
- Narrow before reading: locate with grep/glob, read only the ranges needed. Never read a whole
  file to answer a question about one function.
- More than ~5 mechanical operations of the same shape → write one script and run it.
- Delegate broad read-only searches to a subagent that returns a short digest.

## 1.7 Diff discipline

Atomic. Each phase touches only what that phase needs. No drive-by refactors, no reformatting
untouched lines, no "while I was in there." Adjacent problems go in PROGRESS.md under *Open
findings* for later triage. Match surrounding style over personal preference.

New code lives in `src/scene3d/` and `harness/`. Integration points into existing files must be
minimal and individually justified in the commit body.

## 1.8 Decision protocol

Every fork in this plan has a pre-committed answer in its phase's **FALLBACK** block. Take it
without asking. If a fork arises that this plan does not cover:

1. Choose the option that is smaller, more reversible, and closer to the existing code's style.
2. Record it in PROGRESS.md under *Decisions taken* with one sentence of rationale.
3. Continue.

Never block on a question. Never invent a requirement that isn't in this plan or the spec.

## 1.9 Claim discipline

In PROGRESS.md, commit bodies, and the final report, mark every claim:

- **Verified** — a command was run, output is quoted. Say which command.
- **Inferred** — reasoning from something verified. Say what it rests on.
- **Unverified** — say so. "I don't know" is always available.

Never write "done", "fixed", or "working" without gate output in the transcript.

---

# PART 2 — PREFLIGHT (P-0)

No feature code until this gate passes. Nothing here is optional.

## P-0.1 Locate the repo

Project root is `D:\CODING\PROJECTS - CURRENTLY WORKING ON` (Windows; the path contains spaces —
quote it everywhere). Find the simulator by scanning one level deep for a `package.json` whose
dependencies include `maplibre-gl` **and** whose `index.html` `<title>` contains "Drone Ops
Center". If zero or more than one match, write ABORT.md listing candidates and stop.

Record the resolved absolute path in PROGRESS.md.

If the directory is **not a git repository**, that is an abort — this plan's entire rollback story
is per-phase commits. Write ABORT.md saying so and stop. Do not `git init` on someone's project.

## P-0.2 Baseline

Run, in order, and record verbatim output:

1. `git status --porcelain` and `git rev-parse HEAD`
2. The install step the repo actually uses (detect from lockfile: `package-lock.json` → `npm ci`,
   `pnpm-lock.yaml` → `pnpm i --frozen-lockfile`, `yarn.lock` → `yarn --immutable`)
3. Typecheck, lint, and test scripts **as they exist in package.json**. Do not invent script names.
4. `npm run build` (or the repo's build script)

**Baseline rule:** whatever is red now is red before this work started. Record the exact failing
set. If anything is red, do **not** fix it — it is out of scope — but you must be able to
distinguish it from damage you cause later. If the *build* is red, that is an abort: write
ABORT.md and stop.

## P-0.3 Confirm the facts the plan rests on

The spec's §0 was measured against a running instance on 2026-09-17. Re-verify against source,
because the plan is wrong if any of these moved:

| Claim | How to check |
|---|---|
| `maplibre-gl` is 6.x | `package.json` + lockfile resolved version |
| Terrain source is Terrarium from AWS | grep for `elevation-tiles-prod` and `terrarium` |
| Terrain exaggeration is 1.15 | grep the terrain config |
| Buildings are `fill-extrusion` from Overture | grep both |
| Drones are DOM `Marker`s | grep for `Marker(` in the fleet rendering path |
| No three.js, no custom layer | grep for `three`, `renderingMode`, `type: 'custom'` |
| A replay/determinism system exists | grep `replay`, find the seed plumbing |

Any mismatch → record it in PROGRESS.md and re-read the affected phase before proceeding. A
mismatch on the first three rows is an abort.

## P-0.4 Build the harness scaffold

Create `harness/` with:

- `harness/server.mjs` — builds the app and serves the preview on a **fixed port 4290** (not 4173;
  do not collide with the dev server the user may have running).
- `harness/probe.mjs` — Playwright driver. **Headed Chromium at a fixed 1600×1000 viewport**, not
  headless: headless GL differs enough on Windows to make WebGL and perf assertions untrustworthy.
  Fixed `deviceScaleFactor: 1`.
- `harness/assert.mjs` — the assertion library described in Part 4.
- `harness/gates/gate-p0.mjs` … `gate-p6.mjs` — one gate script per phase. Each exits 0 or 1 and
  prints a machine-readable summary line.
- `artifacts/` — screenshots and probe JSON, git-ignored.

Add to `package.json` scripts (additive only, do not rename existing scripts):
`"gate": "node harness/gates/run.mjs"`.

## P-0.5 Add the harness control surface to the app

The app must become deterministically drivable from a URL. This is a small, permanent, and
independently useful addition — a debug API, gated behind a query param so it is inert in normal
use.

`?harness=1` enables `window.__harness`, exposing:

```ts
{
  map: maplibregl.Map,          // the live map instance
  scene: Scene3DHandle | null,  // the 3D layer handle once it exists
  sim: {
    seed(n: number): void,      // force scenario seed
    freeze(tSeconds: number): void,  // freeze sim clock at T, stop advancing
    step(dtSeconds: number): void,   // advance exactly dt, deterministically
    fleet(): DroneState[],      // lng, lat, altAgl, heading, mode, id
  },
  camera: {
    set(opts): void,            // absolute camera placement, no easing
    mode(name: string): void,
  },
  render: {
    frameTimes(): number[],     // rolling buffer, last 300 frames
    info(): { calls, triangles, programs } | null,  // renderer.info once 3D exists
  },
  ready(): Promise<void>,       // resolves when style + terrain tiles + scene are settled
}
```

`ready()` is the one that saves the run. Every flaky visual test in this kind of project traces
back to screenshotting before terrain tiles have loaded. It must await: `map.loaded()`,
`map.areTilesLoaded()`, terrain DEM tiles for the current view resolved, and two consecutive
rAF frames with no pending tile requests.

### P-0.5a Startup interstitials must be bypassed, not clicked

**Observed 2026-09-17 on a cold load of the current build:** the app opens a modal reading
*"Classroom Server — scan the classroom LAN…"* with Yes/No buttons, over a banner reading
*INSECURE CLASSROOM DEVELOPMENT MODE — LAN traffic is not protected*. It blocks the map from
mounting. A harness that does not handle it will hang in `ready()` or screenshot the modal.

`?harness=1` must **suppress every startup interstitial deterministically** — the classroom-server
prompt, any sign-in modal, any first-run tour — by not mounting them at all when the flag is set.
Do not have Playwright click through them: a click is a real action with a real side effect, and
in this case answering Yes triggers a LAN scan from the user's machine. Suppress at the source.

Enumerate every interstitial the app can show on cold load, list them in PROGRESS.md, and confirm
each is inert under `?harness=1`. An interstitial that appears conditionally (once per browser
profile, after N runs) is exactly what will break the run on day nine.

## P-0.6 PREFLIGHT GATE

```
node harness/gates/gate-p0.mjs
```

Passes only when all are true:

- Repo located, branch `feat/3d-scene-layer` exists and is checked out, tree clean.
- Build succeeds. Baseline red set recorded in PROGRESS.md.
- All P-0.3 claims re-verified or mismatches recorded (none in the first three rows).
- Harness server starts on 4290, Playwright opens the app, `__harness.ready()` resolves in < 30 s.
- Zero startup interstitials render under `?harness=1`, from a **fresh browser profile** (per
  P-0.5a). Assert on a cold profile, not a warm one.
- `__harness.sim.seed(20011); freeze(31)` produces **byte-identical** screenshots across two
  separate browser launches. This is the determinism proof; without it nothing downstream means
  anything.

**FALLBACK:** if byte-identical fails but a perceptual diff is < 0.1% of pixels, accept it, record
the observed noise floor in PROGRESS.md, and use that floor + 3× as every later diff threshold.
If it fails worse than that, the app has unseeded nondeterminism — find it and seed it; that is
in scope and is a prerequisite, not a distraction.

**ABORT if:** determinism cannot be achieved in 3 attempts. Everything downstream is unverifiable
without it.

Commit: `chore(harness): deterministic Playwright harness + __harness control surface`

---

# PART 3 — PHASES

Each phase: objective → work → **gate** (commands + numeric criteria) → **fallback** (pre-committed)
→ commit. Do not begin a phase until the previous gate has passed and been committed.

## PHASE 0 — Render harness (gate: the whole plan)

**This phase can invalidate the architecture. Treat its gate as a go/no-go, not a formality.**

### Work

- `src/scene3d/SceneLayer.ts` — `CustomLayerInterface`, `renderingMode: '3d'`.
- Renderer: `new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })`,
  `autoClear = false`, `renderer.resetState()` as the **first statement** of every `render()`.
- Scene origin: one fixed ENU anchor per scenario,
  `MercatorCoordinate.fromLngLat(origin, originElevation)`. All geometry in metres relative to it.
  Do not place objects in mercator units — precision degrades with latitude and you will spend a
  week chasing jitter.
- Camera matrix from `args.defaultProjectionData.mainMatrix` composed with the origin transform,
  per MapLibre's `adding-3d-models-using-threejs-on-terrain` example.
- **Global render order decided now, not in Phase 4.** Write it down in
  `src/scene3d/README.md`: where the custom layer sits in the 139-layer stack, which existing
  layers draw over it, which under. Changing this later means re-verifying every prior phase.
- Kill switch: `__harness.scene.disable()` unmounts the layer and restores DOM markers. Build it
  on day one; the gate uses it.
- Frame-time instrumentation: ms inside the layer's `render()`, separate from total frame time.

### GATE 0

```
node harness/gates/gate-0.mjs
```

Scenario: seed 20011, clock frozen at T+31, a 3 m unlit box at UAV-01's true lng/lat/altitude.

| # | Assertion | Criterion |
|---|---|---|
| 0.1 | Box renders | ≥ 400 px of box colour at the projected screen position, pitch 0 |
| 0.2 | Geo-anchored | Box screen position within **2 px** of `map.project()` of its lng/lat across zoom 12→18 |
| 0.3 | **Terrain occlusion** | Camera positioned with a ridge between it and the box: box-colour pixels **= 0**. Same camera, terrain disabled: ≥ 400 px. Run at pitch **0, 60, and 107** |
| 0.4 | No GL state bleed | Mean luminance of the frame with the layer mounted is within **2%** of the same frame with `scene.disable()`, in a region the box does not occupy. Catches the black-map failure |
| 0.5 | All 139 layers survive | `map.getStyle().layers.length` unchanged; no console errors matching `/WebGL|GL_INVALID|shader/i` |
| 0.6 | Budget | Layer render ≤ **2 ms** p75 over 300 frames with one box |

**Assertion 0.3 at pitch 107 is the one that matters.** Pitch >90 requires
`setMaxPitch(180)` + `setCenterClampedToGround(false)` + `jumpTo()` with a full option set
including `elevation` — `setPitch()` alone re-clamps (verified: it returns 82.7–90). Use
`calculateCameraOptionsFromTo(fromLL, fromAlt, toLL, toAlt)` as the only camera primitive.

### FALLBACK 0

- 0.4 fails (state bleed) → audit every GL state three.js touches: `depthMask`, `depthTest`,
  `blend`, `cullFace`, bound VAO, active texture unit. Re-assert after each. **3 attempts.**
- 0.3 fails at pitch 107 only, passes at 0 and 60 → record it, continue, and drop Phase 4's ground
  camera from "occluded correctly" to "renders correctly". Do not block the plan on it.
- 0.3 fails at pitch 0 → the shared depth buffer does not work as the MapLibre example implies.
  **This is the architecture-invalidating failure.** ABORT.

### ABORT 0

Write ABORT.md containing: the failing assertion, its full output, the three remediation attempts,
and this recommendation verbatim:

> The custom-layer architecture does not hold on maplibre-gl 6.6.0. Re-scope to a separate
> CesiumJS view (cesium@1.145.0) as a second renderer alongside MapLibre, per SPEC §1. Do not
> attempt phases 1–6 on this foundation.

Then stop. Do not proceed to Phase 1.

Commit: `feat(scene3d): custom layer render harness with terrain-occluded test geometry`

---

## PHASE 1 — Procedural airframes and LOD

Replaces the spec's glTF sourcing, per correction #1.

### Work

`src/scene3d/airframes/` — two builders returning three.js `Group`s from primitives:

- `teal2.ts` — small quad: fuselage, 4 arms, 4 motor cylinders, 4 prop discs, gimbal ball,
  landing legs.
- `x10.ts` — larger quad: distinct proportions, visible sensor turret, different arm geometry.

They must be **structurally distinct airframes, not one mesh re-scaled.** If a viewer cannot tell
them apart in silhouette at 200 m, the phase has failed its purpose.

- PBR via `MeshStandardMaterial`; no textures in this phase (Phase 2 owns lighting, and untextured
  PBR under correct light reads better than textured PBR under wrong light).
- Animation: prop spin from commanded RPM, gimbal yaw/pitch from telemetry, per-mode pose for
  `THERMAL HOLD` / `INSPECT` / `LANDING` (states already in the fleet model).
- LOD ladder on camera distance: `<300 m` full mesh + animated props; `300–1500 m` decimated,
  static props; `>1500 m` camera-facing sprite using the existing 2D fleet colour so the tactical
  read survives.
- One `InstancedMesh` per airframe type. Six drones does not need it; the scenario catalogue will.
- Optional override, wired but unused: if `public/models/<airframe>.glb` exists, load it instead.
  Leaves you a path to real assets later without touching this code.

### GATE 1

| # | Assertion | Criterion |
|---|---|---|
| 1.1 | Both airframes build | No exceptions; each `Group` has ≥ 12 meshes |
| 1.2 | Silhouettes differ | Rendered at identical camera/distance, binary silhouette IoU between TEAL2 and X10 **< 0.80** |
| 1.3 | LOD switches | Screenshots at 200 m / 800 m / 3000 m show 3 distinct triangle counts, monotonically decreasing |
| 1.4 | Props animate | 2 frames 50 ms apart at `step(0.05)` differ by ≥ 100 px inside the prop bounding box |
| 1.5 | Instancing holds | 20 drones → draw calls ≤ **40** (`renderer.info.render.calls`) |
| 1.6 | Budget | 20 drones across all 3 LOD bands: layer render ≤ **4 ms** p75 |
| 1.7 | Weight | Total added bundle delta ≤ **250 KB** gzipped |

### FALLBACK 1

- 1.6 fails → tighten LOD distances (300→200, 1500→1000) before touching geometry. Re-gate. If
  still failing, drop prop animation above 150 m. Both are pre-approved.
- 1.2 fails → the two builders share too much. Differentiate arm count/geometry and fuselage
  proportion, not scale.

Commit: `feat(scene3d): procedural TEAL2/X10 airframes with 3-band LOD and instancing`

---

## PHASE 2 — Lighting

### Work

- `src/scene3d/sun.ts` — NOAA solar position, inline, ~80 lines. Input: scenario clock + AOI
  centroid. **Use the scenario clock, never wall clock** — replay determinism depends on it.
- `DirectionalLight` (sun) + `HemisphereLight` (sky fill), intensity and colour curves keyed to
  solar elevation, through civil twilight to night.
- IBL from the same palette fed to `map.setSky()`, so models and sky agree. One `PMREMGenerator`
  pass per significant sun-angle change — **never per frame**.
- Shadow camera fitted to the **visible camera frustum**, not the AOI. An ortho shadow camera
  covering the whole wildfire flank at 4096² gives roughly one texel per two metres and looks like
  mud. This is the single biggest perf and quality trap in the plan.
- Night: nav lights (red/green), 1 Hz anti-collision strobe, additive sprites with glow baked into
  the sprite texture — not a post pass.

### GATE 2

Property-based, not golden. Four sun angles: dawn (elev 5°), noon (elev 60°), dusk (elev 5°
opposite azimuth), night (elev −10°).

| # | Assertion | Criterion |
|---|---|---|
| 2.1 | Sun position correct | Computed azimuth/elevation within **0.5°** of a hardcoded reference table for the AOI centroid at 4 known timestamps. Compute the table from an independent implementation, not from this code |
| 2.2 | Light direction follows sun | Brightest face of a test sphere faces the sun azimuth ± **10°** at all 4 angles |
| 2.3 | Night is dark, not black | Mean airframe luminance at night: **> 2%** and **< 20%** of noon |
| 2.4 | Strobe cycles | Over 2 s at 60 fps, strobe-region luminance crosses its midpoint exactly **2** times |
| 2.5 | Determinism | Same seed + same frozen clock → diff within the P-0.6 noise floor |
| 2.6 | No per-frame PMREM | Over 300 frames at a fixed sun angle, PMREM invocations = **0** (instrument the call) |
| 2.7 | Budget | Layer render ≤ **5 ms** p75 with lighting, 20 drones |

**2.1 is the non-circular anchor.** Everything else in this phase is judged against it.

### FALLBACK 2

- 2.1 fails → the solar algorithm is wrong. Do not tune it against screenshots. Fix it against the
  reference table or ABORT the phase; a wrong sun poisons Phase 3 entirely.
- 2.7 fails → drop shadow map 2048²→1024² before touching lighting quality. Then single-cascade.

Commit: `feat(scene3d): solar-driven lighting, IBL, frustum-fitted shadow camera`

---

## PHASE 3 — Shadows on real geometry

The hard phase. MapLibre draws the terrain, so its mesh is not in three's scene and cannot receive
three's shadows. Build an invisible receiver.

### Work

- Mesh a three.js heightfield from the **same** Terrarium tiles
  (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`), covering the shadow camera
  only. Start at 2 km radius, regenerate on camera move with hysteresis.
- Apply exaggeration **exactly 1.15**. Any mismatch and shadows float or sink.
- Material: `ShadowMaterial` — invisible except where shadowed, so MapLibre still draws visible
  terrain and the shadow composites on top.
- Same for buildings: extrude the Overture footprints already being fetched into three geometry
  with `ShadowMaterial`, so drones shadow rooftops and buildings shadow ground.
- Expect to need polygon offset, tuned per zoom band, to stop z-fighting with MapLibre's terrain.

### GATE 3

| # | Assertion | Criterion |
|---|---|---|
| 3.1 | Shadow exists | Ground ROI beneath a drone at 30 m AGL, sun elev 20°: mean luminance **≥ 15% darker** than the same frame with `castShadow = false` |
| 3.2 | Shadow tracks sun | Rotate azimuth 90°: shadow centroid moves ≥ **20 px** and in the geometrically correct direction (sign-checked against sun azimuth, not just "it moved") |
| 3.3 | Shadow tracks terrain | Drone flying over a slope: shadow centroid's unprojected ground elevation tracks `queryTerrainElevation` within **3 m** across 10 samples |
| 3.4 | Shadows climb buildings | Over an Overture footprint, shadow pixels appear on the rooftop plane, not only at ground level |
| 3.5 | No z-fighting | Zoom 12→18, 7 steps: no pixel in the terrain region flips between two values across 3 consecutive frames at a static camera |
| 3.6 | Receiver invisible | With `castShadow = false`, frame is within the noise floor of `scene.disable()` — the receiver must contribute nothing but shadow |
| 3.7 | Budget | Layer render ≤ **7 ms** p75, receiver regeneration ≤ **1 ms** amortised |

### FALLBACK 3 — pre-approved, take it rather than fight

If 3.3, 3.4, or 3.5 fails after **2 remediation attempts**, switch to **projected blob shadow
decals** on terrain: a soft radial decal per aircraft, positioned by `queryTerrainElevation`,
scaled by altitude, skewed by sun azimuth/elevation. Roughly 70% of the visual payoff at a
fraction of the cost and risk. Re-gate with 3.1, 3.2 and 3.7 only; mark 3.3–3.6 as
*not-applicable — blob fallback taken* in PROGRESS.md.

**Do not spend a second week on the receiver mesh.** This is the instruction, not a suggestion.

Commit: `feat(scene3d): terrain and building shadow receivers` *(or `: blob shadow decals`)*

---

## PHASE 4 — Camera director and sensor volumes

### Work

- Wire `cameraDirector.js` from the repo root (see *Before kickoff*; if absent, write it from
  scratch against the mode list below — do not skip). Modes: TACTICAL / ORBIT / CHASE /
  FPV / GROUND. All solve to camera position + look-at → `calculateCameraOptionsFromTo` →
  `jumpTo` on rAF. **Never `easeTo` per frame** — queued eases fight each other.
- Smoothing constants in the draft are guesses. Tune against the real telemetry rate; record final
  values in PROGRESS.md.
- Sensor volumes, replacing their flat 2D equivalents:
  - gimbal FOV as a translucent cone, clipped where it meets the terrain receiver
  - thermal footprint as a terrain-projected decal, replacing `ir-footprints`
  - GNSS uncertainty as a shaded ellipsoid at true altitude, replacing `gnss-uncertainty`
  - trails as altitude-correct ribbons, replacing `trail-uav-*`
- **Hide the 2D layer whenever the 3D layer owns that concept.** Two representations of the same
  thing on screen simultaneously is what will make this look amateur.
- GROUND mode: click-to-place standpoint, eye height 1.7 m. This is the demo shot.

### GATE 4

| # | Assertion | Criterion |
|---|---|---|
| 4.1 | All 5 modes hold | 60 s each on a manoeuvring drone: no frame where camera position jumps > **50 m** between consecutive frames |
| 4.2 | Bearing wrap clean | Drone heading crossing 359°→1°: no camera bearing delta > **10°/frame** |
| 4.3 | GROUND looks up | `map.getPitch() > 100`, and the subject projects into the upper **40%** of the frame |
| 4.4 | Sky above horizon | In GROUND mode, pixels above the horizon are sky-coloured — **not** the canvas background. This is the `setSky()` check and it is mandatory, not polish |
| 4.5 | No duplicate concepts | For each replaced concept, the 2D layer's `visibility` is `none` while the 3D equivalent is active |
| 4.6 | INP | Drag-to-orbit for 5 s: p75 input-to-next-paint ≤ **200 ms**. Orbit drag must not round-trip through React state |
| 4.7 | Budget | Layer render ≤ **8 ms** p75, all volumes on, 20 drones |

### FALLBACK 4

- 4.3 fails → fall back to pitch 89 with vertical FOV widened to 75°, which puts 37.5° above the
  horizon in frame. Verified sufficient for a 30 m drone at 40 m standoff. Record the deviation.
- 4.6 fails → move the orbit handler off React entirely onto a direct rAF loop with a ref. Do not
  attempt to optimise React around it.

Commit: `feat(scene3d): camera director with 5 modes and 3D sensor volumes`

---

## PHASE 5 — Atmosphere

### Work

- `map.setSky()` — mandatory. Above ~80° pitch the current style renders raw canvas background:
  empty void above the horizon. Verified on the live build.
- Height fog keyed to the open-meteo visibility field already being fetched.
- Wildfire smoke column: instanced billboards with curl noise, **seeded from the scenario seed** so
  replays stay deterministic.
- Sun glare as a screen-space sprite. **Not** a post-processing pass — that is where this plan
  becomes a 12-week plan and where Cesium actually wins.

### GATE 5

| # | Assertion | Criterion |
|---|---|---|
| 5.1 | Sky present at all pitches | 0/60/89/107: zero pixels equal to the canvas background colour above the horizon |
| 5.2 | Fog responds to data | Visibility 2 km vs 20 km: distant-ROI contrast differs by ≥ **20%** |
| 5.3 | Smoke deterministic | Same seed + frozen clock, two runs: diff within noise floor |
| 5.4 | No post pass added | grep confirms no `EffectComposer` / `postprocessing` import anywhere |
| 5.5 | Budget | Layer render ≤ **8 ms** p75, smoke active |

### FALLBACK 5

5.5 fails → halve smoke billboard count, then drop smoke above 1500 m camera distance. Sky and fog
are not droppable; smoke is.

Commit: `feat(scene3d): sky, height fog, seeded smoke column`

---

## PHASE 6 — Performance, degradation, final verification

### Work

- `quality` enum: `cinematic` / `balanced` / `tactical`. Degradation order, fixed:
  post-effects (none exist) → smoke → shadow resolution → shadows off → LOD bands tightened →
  3D layer off entirely (DOM markers restored).
- Auto-select on first run from a 3 s frame-time sample; user-overridable.
- Full test matrix: {1, 5, 20 drones} × {dawn, noon, night} × {ground, orbit, FPV} ×
  {terrain on, off} = 72 cells. Capture a screenshot and a probe JSON per cell.

### GATE 6 — final

| # | Assertion | Criterion |
|---|---|---|
| 6.1 | Frame budget | p75 frame time ≤ **16.7 ms** across all 72 cells at `balanced` |
| 6.2 | Degradation works | Artificially constrain to 30 ms/frame → quality drops through the ladder and recovers ≤ 16.7 ms, without the 3D layer being disabled at 5 drones |
| 6.3 | Kill switch intact | `scene.disable()` restores the exact pre-Phase-0 frame within the noise floor |
| 6.4 | No baseline regression | Typecheck / lint / test red set is **identical** to the P-0.2 baseline. Not smaller by deletion, not larger |
| 6.5 | Bundle | Total added transfer ≤ **6 MB**, added gzipped JS ≤ **400 KB** |
| 6.6 | All prior gates still pass | Re-run gates 0–5 end to end |
| 6.7 | Review bundle | `artifacts/review/` contains all 72 screenshots plus a contact-sheet HTML index |

Commit: `feat(scene3d): quality tiers, degradation ladder, full verification matrix`

---

# PART 4 — THE ASSERTION LIBRARY

`harness/assert.mjs`. These are the primitives every gate is written in. Build them in P-0.4; do
not let each gate invent its own.

**Structural probes** (run JS in the page, no pixels — cheap and exact):
`sceneObjectCount()`, `drawCalls()`, `triangles()`, `worldPosition(id)`,
`screenPosition(id)`, `frameTimeP75(n)`, `consoleErrors(regex)`, `layerVisibility(id)`,
`raycastBlocked(fromCam, toObject)`.

**Property-based pixel assertions** (the non-circular ones — each asserts a claim, not a match):
- `colourCount(roi, rgb, tolerance)` → pixel count. Presence/absence.
- `luminanceDelta(roi, frameA, frameB)` → %. Shadows, fog, night.
- `centroid(roi, predicate)` → {x, y}. Shadow tracking, glare position.
- `silhouetteIoU(frameA, frameB)` → 0–1. Airframe differentiation, LOD.
- `horizonRow(frame)` → y. Then assert what is above it.
- `flicker(frames[], roi)` → bool. Z-fighting.
- `noiseFloorDiff(frameA, frameB)` → %. Determinism, kill-switch restore.

**Regression tripwires** (goldens — captured only *after* a property assertion passes, never as the
primary check): `saveGolden(name)`, `diffGolden(name, thresholdPct)`.

Every gate prints one machine-readable summary line and exits 0/1:

```
GATE <n> <PASS|FAIL> assertions=<p>/<t> failed=[<ids>] p75_layer_ms=<x> artifacts=<path>
```

---

# PART 5 — ABORT AND ROLLBACK

## Abort conditions — stop, write ABORT.md, do not push through

1. Build red at preflight.
2. Determinism unachievable after 3 attempts (P-0.6).
3. Gate 0 assertion 0.3 fails at pitch 0 — architecture invalid.
4. Any gate fails 3 consecutive attempts with no applicable fallback.
5. Gate 6.4 shows a baseline regression that cannot be fixed without weakening a test.
6. The only remaining way forward requires a prohibited action from §1.2.

ABORT.md must contain: phase, failing assertion with full output, every remediation attempted and
its result, current branch/commit, and a concrete recommendation. Then stop. Leave the branch
intact for inspection — **do not** revert, do not clean up, do not delete artifacts.

## Rollback

Every phase is one commit behind a passing gate, so `git revert <sha>` is always available and
always lands on a verified state. Never reset, never rebase, never force.

## The discipline that matters most

If a gate is failing and the fastest path to green is loosening the criterion, deleting the test,
or disabling the assertion: **that is the abort path, not the fix path.** Write it up and stop.
A run that stops honestly at Phase 3 is worth more than one that reports success at Phase 6 by
lowering its own bar.

---

# PART 6 — WHAT LANDS WHEN IT FINISHES

On the branch, unpushed:

- `src/scene3d/` — the layer, airframes, sun, shadows, camera director, volumes, quality tiers.
- `harness/` — deterministic Playwright harness and seven gate scripts, re-runnable forever.
- `PROGRESS.md` — full decision and deviation log.
- `artifacts/review/` — 72 screenshots and a contact sheet.
- Seven commits, each with its gate output in the body.
- `src/scene3d/README.md` — render order, coordinate conventions, quality ladder.

What is **not** done, by design: taste. The gates prove the shadows are geometrically correct,
not that the scene looks good. Review the contact sheet, and expect one tuning pass on light
colour, fog density, material response and camera smoothing — the four things no assertion can
judge.

---

## Estimate

Preflight 1 day · P0 2–3 days · P1 1 wk · P2 1 wk · P3 1 wk (highest slip) · P4 1 wk · P5 1 wk ·
P6 3–4 days → **6–6.5 weeks** of agent-time, gated at Phase 0 in the first three days.
