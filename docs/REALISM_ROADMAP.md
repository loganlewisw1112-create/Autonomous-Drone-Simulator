# Realism Roadmap — research findings and execution plan (v4)

**Autonomous Drone Mission Simulator · 21 July 2026**

Applies to **all three builds**: Mobile, Windows, Coordinator/classroom.
Grounded in 16 external research passes and cross-referenced against the codebase
(`src/sim/`, `src/account/`, `src/scenarios/`, README "Known Limitations").

**v4 is re-grounded against the actual code**, not the code v3 assumed. Two things changed
the map: the **Coordinator/classroom build shipped** (E2EE LAN screen wall — `src/classroom/`,
`server/classroom.mjs`), so WP-9's auto-scored lane now has a real consumer; and a read of
`src/sim/drone/platformCatalog.ts` showed **WP-1's platform physics were already sourced**,
not invented — v3 overstated that gap. The remaining WP-1 work (the thermal *sensor* specs
WP-5 needs) is now **done**, and WP-5's detection geometry now exists as tested code.

**Changes in v4:**
- WP-1 re-scoped: mass, endurance, wind/gust, speed already sourced per airframe. Added the
  missing piece — **integrated thermal sensor specs** (`ThermalSensorSpec`: sensor, resolution,
  12 µm FLIR pitch, focal length, NETD) for all six platforms, `null` where unpublished.
- WP-5 partially executed: **`src/sim/sensors/thermalRange.ts`** implements the Johnson §18.1
  geometry as pure, tested functions (anchor reproduces: 12 µm, 13 mm, 100 m, 0.5 m → 5.42 px).
  It changes no live detection yet — that wiring is gated on WP-4 LOS, as designed.
- Everything else unchanged from v3 and still gated on **WP-0 (the fixture pipeline)**, which
  this environment cannot run (it fetches USGS/Overture/Open-Meteo/FAA at authoring time and
  freezes to committed fixtures). WP-0 is the true blocker for WP-2/3/4/7/8/9.

**Changes from v2 (retained):** GNSS Tier 2 confirmed and fully specified (WP-7) · everything
restructured into 12 dependency-ordered work packages · WP-0 fixture pipeline added as the
unlock nobody accounts for · technical reference appendix with verified formulas · fixture
formats and byte budgets closed.

---

## 0. v4 execution status (what is now true in the code)

| WP | Status | Note |
|---|---|---|
| WP-1 platform specs | **DONE** | Physics were already sourced; thermal sensor specs added this pass (`platformCatalog.ts`). |
| WP-5 thermal geometry | **PARTIAL** | Johnson §18.1 math shipped + tested (`thermalRange.ts`); LOS/contrast gating awaits WP-4. |
| WP-0 fixture pipeline | **BLOCKED here** | Needs live network authoring (dev CLI hitting USGS/Overture/Open-Meteo/FAA). Not runnable in this environment. |
| WP-2/3/4/7/8/9 | **GATED on WP-0/WP-4** | Real geodata + the terrain keystone; no honest offline path. |
| WP-6/10/11 | **MODULE DONE** | Pure, tested, deterministic modules shipped: `sensors/sweepWidth.ts` (POD), `weather/dryden.ts` (turbulence), `drone/battery.ts` (discharge curve). Change no live behaviour yet — live wiring into the loop is the deferred, determinism-sensitive step (WP-5 pattern). |
| Coordinator consumer for WP-9 | **LANDED** | Classroom build ships; a NIST-scored lane now has a comparison table to report into. |

**The offline frontier WP-6/10/11 now exists as tested math.** They need no fixtures. Each shipped
as a pure module with its own spec (the WP-5 pattern) so the 480→501 suite stays green and the sim
tick's determinism is untouched. What remains for each is the *live wiring* — swapping the linear
battery drain, injecting Dryden gusts into the loop, and reporting POD on the READY tab — each a
deliberate, separately-verified step because it touches deterministic behaviour.

---

# Part I — Principles

## 1. Cognitive fidelity is the target

Fidelity splits three ways: **physical** (looks real), **functional** (behaves real),
**cognitive** (the decisions are real). The literature is consistent that beyond a threshold
of essential realism, more *physical* fidelity gives diminishing and sometimes negative
returns, while cognitive fidelity drives training transfer. Low-physical-fidelity simulation
carefully designed to elicit the right responses beats elaborate realism in details
irrelevant to the taught skill.

You train a **console operator**, not a pilot. The task is: allocate aircraft, notice
degradation, decide, justify afterwards. Every package below is scored on whether it changes
what the operator must **decide**.

## 2. Simulation fidelity is uniform across builds; rendering fidelity is not

**The physics runs on geometry, not pixels.** A ray-cast against a polygon costs the same on
a phone as a workstation — arithmetic, not rasterisation. So **all three builds get identical
simulation fidelity**: same occlusion, same GNSS masking, same RF path loss, same detection
model, same deterministic result from the same seed. Only how much geometry gets *drawn*
differs. See §16.

This also protects determinism: if fidelity varied by device, a seed would not reproduce
across builds and the project's central claim collapses.

## 3. The determinism rule — and how it is enforced

**Real-world data is fetched at authoring time, frozen into committed fixtures, and never
fetched at runtime.**

Enforcement is mechanical, not a convention:

- All network access lives in `tools/fixtures/` (WP-0), a dev-time CLI that is **not part of
  any build**.
- `src/` keeps its current property of **zero `fetch` / `XHR` / `WebSocket`** calls.
- Add an ESLint `no-restricted-globals` rule banning `fetch`/`XMLHttpRequest` under `src/sim/`
  and `src/scenarios/`, plus the existing CI bundle assertion.

If an upgrade cannot be built this way, it does not get built.

---

# Part II — The plan

## 4. Dependency graph

```
WP-0  Fixture pipeline ─────┬──> WP-2  Weather fixtures
   (build tool, no runtime) │
                            ├──> WP-3  Airspace fixtures
                            │
                            └──> WP-4  Terrain + buildings + OcclusionService  ★ KEYSTONE
                                          │
                                          ├──> WP-5  Thermal (Johnson + LOS)
                                          │       └──> WP-6  SAR sweep width / POD
                                          ├──> WP-7  GNSS occlusion → DOP
                                          ├──> WP-8  RF link budget
                                          └──> WP-9  NIST scored lanes

WP-1  Platform specs        (independent, trivial)
WP-10 Dryden wind           (needs WP-2 for the altitude gradient)
WP-11 Battery curve         (independent)
WP-12 Public air traffic    (needs WP-0; shares WP-2's realDate; complements WP-3/WP-7)
```

**Critical path is WP-0 → WP-4 → {5,7,8,9}.** WP-4 is the single most expensive package and
four others are blocked behind it.

## 5. Execution order

| Tranche | Packages | Character |
|---|---|---|
| **A** | WP-1, WP-0, WP-2, WP-3 | ~1 week. Invented numbers become sourced numbers. No structural change. |
| **B** | WP-4 | The keystone. Largest single piece of work in the document. |
| **C** | WP-5 → WP-6, WP-7, WP-8, WP-9 | Where the simulator stops being plausible and starts being defensible. |
| **D** | WP-10, WP-11 | Independent polish. Parallelisable, deferrable. |

---

## WP-0 · Fixture pipeline `[Tranche A]` `[blocks 2,3,4]`

The unlock nobody budgets for. Every other package needs real data frozen into the repo, and
there is currently no tool that does it.

**Deliverable.** `tools/fixtures/` — a Node CLI, run manually by a maintainer, never in CI,
never bundled.

```
npm run fixtures -- --scenario demo_sar_coastal
npm run fixtures -- --all --only terrain,buildings
```

Per scenario it reads the AO bbox from `src/scenarios/catalog.ts` and emits into
`src/scenarios/fixtures/<scenarioId>/`:

| File | Source | Package |
|---|---|---|
| `terrain.png` | USGS 3DEP 1 m / S1M, fallback Copernicus GLO-30 | WP-4 |
| `buildings.json` | Overture Maps buildings theme | WP-4 |
| `weather.json` | Open-Meteo ERA5 historical | WP-2 |
| `airspace.json` | FAA UDDS UASFM | WP-3 |
| `constellation.json` | GNSS almanac for scenario date/time | WP-7 |
| `manifest.json` | source URLs, fetch date, licence, checksums | all |

**`manifest.json` is not optional.** It records provenance for every fixture — source URL,
retrieval date, licence string, SHA-256. That is what lets you answer "where did this number
come from" in a diligence conversation, and it is required for the Open-Meteo CC BY 4.0 and
Overture attribution obligations.

**Files:** `tools/fixtures/index.mjs` · `terrain.mjs` · `buildings.mjs` · `weather.mjs` ·
`airspace.mjs` · `constellation.mjs` · `manifest.mjs` (~600 lines total)

**Accept:** running `--all` regenerates every fixture byte-identically from a clean checkout
(given unchanged upstream), and `npm test && npm run build` passes with fixtures present.

**Test:** golden-fixture test — one small AO committed with its manifest; the tool re-runs
against a recorded HTTP cassette and produces an identical file.

---

## WP-1 · Real platform specs `[Tranche A]` `[independent]` — **DONE (v4)**

**Status:** the physics half was already in the code. `platformCatalog.ts` ships six real
airframes — Skydio X10 / X10D, Parrot Anafi USA, Teal 2, Freefly Astro Max, BRINC Lemur 2
(not the DJI/Skydio/BRINC-Responder trio the v3 table sketched) — each already carrying
sourced mass, endurance, wind/gust tolerance and speeds. This pass added the one missing
piece the acceptance criteria demanded: the **integrated thermal sensor spec**. Sourced,
this pass: Skydio X10/X10D → FLIR Boson+ 640×512 @ ≤30 mK; Anafi USA → FLIR Boson 320×256
@ <60 mK; Teal 2 → FLIR Hadron 640R 640×512; Lemur 2 → FLIR Lepton 160×120; Astro Max →
`null` (modular payload, no single sensor). Pitch 12 µm across the FLIR family (published);
focal length left `null` everywhere (manufacturers cite FOV, not focal length — never guessed).

One afternoon, outsized credibility. Operators know these figures by heart.

| Platform | Flight time | Wind / gust limit | Thermal | Mass | Max speed |
|---|---|---|---|---|---|
| DJI Matrice 4T | 49 min (46 low-noise) | 12 m/s takeoff/landing | up to 1280×1024 | 1,219 g | 21 m/s |
| Skydio X10 | 40 min | 12.8 m/s gust (28.6 mph) | FLIR Boson+ 640×512, ≤30 mK | 2,110 g | ~20 m/s |
| BRINC Responder | 42 min | not published | 640 px | — | 2 lb payload |

**Files:** `src/sim/drone/platformCatalog.ts`

**Accept:** every `PlatformId` carries a sourced endurance, wind limit, thermal sensor spec
(resolution, pixel pitch, focal length, NETD — WP-5 needs these) and mass. Unpublished values
are explicitly `null`, never guessed.

**Test:** extend existing platform tests to assert no `null` endurance and that wind limits
are within a sane band.

---

## WP-2 · Real weather fixtures `[Tranche A]` `[needs WP-0]`

**Current state.** `src/sim/weather/weatherEngine.ts` builds state from `mulberry32` seeded
RNG across six location profiles, with severity / time-of-day / comms dials in
`ScenarioVariantConfig`. **The architecture is right. The numbers are invented.**

**Upgrade.** [Open-Meteo](https://open-meteo.com/) serves **ERA5 / ERA5-Land reanalysis from
ECMWF, hourly, January 1940 to present, 9–25 km resolution, no API key, plain HTTP GET
returning JSON, CC BY 4.0 including commercial use with attribution**, and exposes **wind at
multiple altitudes from 10 m to 300 m+** — exactly your operating band, and the source of the
altitude gradient WP-10 needs.

**Design.** The sim kernel does not change. `buildWeatherState()` gains an optional
`observed` input: when a scenario has `weather.json`, the observed values become the baseline
and the seeded variant dials perturb *around* them rather than generating from nothing. A
scenario with no fixture behaves exactly as today.

**Why it is disproportionately valuable:** it lets you say *this is the weather that was
actually over Estero Island during Ian, and over Ocean Beach the night of the callout.* Your
catalog is already modelled on real incidents; sourcing weather to the real date and place
converts a plausible scenario into a documented one.

**Files:** `tools/fixtures/weather.mjs` · `src/sim/weather/weatherEngine.ts` ·
`src/scenarios/catalog.ts` (add `realDate` per scenario)

**Accept:** ≥12 of 21 scenarios carry observed weather; determinism tests still pass; a
scenario without a fixture is bit-identical to current behaviour.

**Test:** `weatherEngine.spec` gains a case asserting observed-baseline + seed produces a
stable, snapshot-matched state; existing tests unchanged.

---

## WP-3 · Real airspace ceilings `[Tranche A]` `[needs WP-0]`

**Current state:** simulated LAANC / incident-command authorisation, deterministic and
clearly labelled simulation-only. **Correct posture — keep the labelling exactly.**

**Upgrade.** The FAA publishes **UAS Facility Maps** — maximum altitudes at which Part 107
operations may be authorised without further safety analysis — via the **UAS Data Delivery
System** (`udds-faa.opendata.arcgis.com`; legacy `uas-faa.opendata.arcgis.com`). Grid is
**30 × 30 arc-seconds**, ~0.25 sq mi / ~160 acres per cell in the lower 48. Fields include
`CEILING`, `UNIT`, `ARPT_Name`, `AIRSPACE`, `MAP_EFF_DT`. Available as **JSON, GeoJSON, PBF**.

Clip to each AO, freeze, render as the ceiling layer. The SFO-approach corridor in the Golden
Gate Park SAR scenario stops being an approximation and becomes the published grid.

**Real *data*, simulated *authorisation*.** Those are different claims and the distinction is
what keeps the project credible. Keep the disclaimer at full strength.

**Files:** `tools/fixtures/airspace.mjs` · `src/sim/mission/airspace.ts` ·
`src/components/tacticalMapGeoJson.ts`

**Accept:** ceiling grid renders per scenario; `MAP_EFF_DT` surfaced in the UI so a stale
fixture is visible rather than silently wrong.

**Test:** a route that exceeds the real published ceiling raises the existing Part 107
attention flag.

---

## WP-4 · Terrain, buildings, OcclusionService `[Tranche B]` `★ KEYSTONE`

Current state: **flat earth, no structures.** Altitude is a number with no relationship to
ground. This is the largest realism gap and it is load-bearing for WP-5, WP-7, WP-8, WP-9.

### 4.1 Build it as a service, not a rendering feature

```ts
// src/sim/terrain/OcclusionService.ts
interface OcclusionService {
  groundElevation(lat: number, lng: number): number        // m MSL, bare earth
  surfaceHeight(lat: number, lng: number): number          // m MSL, incl. structures
  hasLineOfSight(a: Point3D, b: Point3D): LosResult        // { clear, blockedBy, blockHeight }
  skyVisibility(from: Point3D, azDeg: number, elDeg: number): boolean
}
```

Four consumers, all currently scripted or absent:

| Consumer | What it gains |
|---|---|
| **Thermal (WP-5)** | Can the camera *see* the contact, or is a building in the way? |
| **GNSS (WP-7)** | Which satellites are visible from this position? |
| **RF (WP-8)** | LOS vs NLOS path; terrain diffraction |
| **Flight safety** | Obstacle clearance, AGL floors, rooftop landing viability |

Build the geometry once; four subsystems stop being scripted. That is the largest single
cognitive-fidelity gain available anywhere in this document.

### 4.2 DTM vs DSM — get this right or everything downstream is wrong

- **DTM / bare-earth DEM** — ground with vegetation and structures removed.
- **DSM** — highest surface including canopy and rooftops.

**Use the DTM as terrain.** With a DSM your AGL reference becomes roof height and every
altitude computation over a city is wrong. Structures enter separately as extruded footprints
so they are testable as discrete obstacles rather than smeared into the ground.

### 4.3 Terrain data and fixture format

**Source, US** (all 21 scenarios are US-located): **USGS 3DEP 1-metre DEM**, produced
exclusively from lidar at 1 m or better, representing **the topographic bare-earth surface** —
exactly the DTM required. Metres, NAVD88, UTM/NAD83 in the conterminous US. Prefer the newer
**Seamless 1-Metre DEM (S1M)**, which merges lidar-derived terrain into a surface seamless
*across* project boundaries — standard 1 m tiles are seamless only *within* a collection
project, and Dixie Fire's 8 km flank, the 25-mile CBP Laredo corridor and the SF→Albany Hills
pursuit all cross boundaries.

**Fallback:** Copernicus DEM GLO-30, or AWS Open Data **Terrain Tiles** — Terrarium-encoded,
standard z/x/y, **no authentication**, consumable by MapLibre directly as a `raster-dem`
source.

**Fixture format: Terrarium-encoded PNG.** This is the decision that makes the package
tractable — **one artifact serves both physics and rendering.** MapLibre consumes Terrarium
natively as `raster-dem`; the sim decodes the same PNG once into a `Float32Array` via canvas.
No second pipeline, no divergence between what is drawn and what is computed.

**Resolution: 10 m default, with an optional 2 m inset around launch/recovery sites.**
Justification: AGL decisions resolve at ±3 m and terrain slope matters over tens of metres, so
10 m carries every operator decision. Launch-site slope is the one place finer detail earns
its cost.

**Byte budget** (5 km × 5 km AO):

| Resolution | Samples | Raw | Terrarium PNG (typical) |
|---|---|---|---|
| 1 m | 25 M | 75 MB | far too large |
| 10 m | 250 k | 750 KB | **~90–150 KB** |
| 2 m inset (500 m box) | 62 k | 190 KB | ~25 KB |

Across 21 scenarios: **roughly 2–4 MB committed.** Acceptable. Shipping 1 m rasters would be
~1.5 GB and is the failure mode to avoid.

### 4.4 Building data and fixture format

**Overture Maps Foundation buildings theme.** Over **780 M footprints worldwide**, conflated
from OpenStreetMap, Microsoft AI-generated footprints and Esri — community data first, ML
filling the remainder. Critically: **heights were extracted from open lidar by comparison
against USGS 3DEP, adding over six million 2.5D buildings**, and **height completeness is
substantially better in the United States than elsewhere.** All 21 scenarios sit in the
best-covered region. Microsoft replaced its own buildings layer with Overture in July 2024 —
a reasonable proxy for production readiness.

**Fixture:** GeoJSON `FeatureCollection`, polygons simplified to **≤10 vertices**, properties:

```json
{ "h": 34.5, "hSrc": "measured" | "inferred", "base": 12.1 }
```

`hSrc` matters: `inferred` means levels × 3 m rather than lidar-measured, and the UI should
be able to say so. Typical urban AO is 2,000–5,000 buildings → ~400 KB–1 MB raw,
**~100–250 KB gzipped.**

**2.5D is the correct level.** Extruded prisms, not architectural models. Every decision this
supports — can I see the target, will I lose GNSS in this canyon, is that roof landable — is
answered by a prism. None is answered by a facade.

### 4.5 Algorithms and performance budget

**Spatial index.** Uniform grid, 100 m cells, bucketing building IDs. Rays march cells by DDA
and test only buildings in traversed cells.

**Terrain LOS.** Sample the ray at terrain resolution; compare ray height against terrain
height at each step. O(distance / 10 m).

**Building LOS.** For each candidate building whose footprint the ray's ground projection
crosses, test whether ray height at the crossing is below `base + h`.

**Budget at 8 drones:**

| Consumer | Rate | LOS tests/sec |
|---|---|---|
| GNSS (31 satellites) | 1 Hz | 248 |
| Thermal (≤10 contacts) | 1 Hz | 80 |
| RF (GCS + relays) | 1 Hz | ~16 |
| **Total** | | **~350** |

At ~50–200 cell visits per test that is ~50 k cell visits/sec — trivial in JS.

**The key performance decision: run occlusion at 1 Hz, not on the 50 ms sim tick.** Satellite
geometry, building shadows and RF paths all change slowly relative to 20 Hz. Cache results and
interpolate. This is a 20× saving for zero fidelity loss.

### 4.6 What it unlocks, by scenario

- **Financial District, Times Square MCI, Skid Row welfare** — genuine urban canyon problems.
  Contacts hide behind buildings; you must fly the street, not orbit above it. GNSS degrades
  where the operator flew into the canyon. **The single biggest behavioural change in the
  catalog.**
- **Grizzly Peak, Dixie Fire** — terrain masking makes relay aircraft placement a real decision.
- **Big Bend, CBP Laredo** — AGL over varying terrain becomes the actual constraint.
- **Hollywood Bowl, Port of LA, FBI compound** — rooftop and structure overwatch gain meaning;
  standoff-observe has a real sightline.

### 4.7 Package

**Files:** `tools/fixtures/terrain.mjs` · `tools/fixtures/buildings.mjs` ·
`src/sim/terrain/OcclusionService.ts` · `terrainRaster.ts` (Terrarium decode) ·
`buildingIndex.ts` (grid + DDA) · `los.ts` · `src/sim/safety/SafetyManager.ts` (AGL floors) ·
`src/components/TacticalMap.tsx` (render, per §16) · `src/components/tacticalMapGeoJson.ts`

**Accept:**
1. `groundElevation()` at 20 known survey points matches the source DEM within 1 m.
2. `hasLineOfSight()` returns correct results for 12 hand-authored geometry cases.
3. AGL is displayed and enforced; a route below terrain raises a safety warning.
4. Determinism tests pass with terrain active — identical seed, identical output.
5. Mobile bundle renders 2D footprints only (§16.1); simulation output identical to desktop.

**Test:** new `occlusionService.spec.ts` (elevation lookup, LOS geometry cases, index
correctness) · extend `determinism.spec.ts` with a terrain-active scenario · extend
`scenarioRouteSanity.spec.ts` to assert no scenario route passes below terrain.

**Cost, honestly.** Every altitude computation, geofence check and route audit gains an
elevation lookup; determinism tests need fixtures pinned in-repo; and the fixture pipeline is
a build tool you do not have. **Budget this as the largest single piece of work here.** It is
still item 1 because WP-5/7/8/9 are collectively worth more than it costs.

---

## WP-5 · Thermal — Johnson criteria + LOS `[Tranche C]` `[needs WP-4]` — **GEOMETRY DONE (v4)**

**Status:** the detection *geometry* now exists as pure, tested code —
`src/sim/sensors/thermalRange.ts` (`pixelsAcrossTarget`, `rangeForPixels`, `platformTaskRanges`,
`focalLengthFromHfov`). The §18.1 anchor reproduces exactly (12 µm, 13 mm, 100 m, 0.5 m →
5.42 px), and `platformTaskRanges` returns `null` — not a fabricated range — for any platform
whose focal length is unpublished, which is currently all of them. What remains, and is
correctly gated on WP-4: threading the platform sensor into `ThermalSim.checkThermalDetections`,
the **LOS gate**, the thermal-contrast (NETD) gate, and the atmospheric τ multiplier — plus the
`thermalContact.spec` rewrite. Live detection behaviour is unchanged until that lands, so
determinism is intact. Rest of this section is the unchanged v3 target.

**Current state**, per README and the comment in `src/sim/sensors/ThermalSim.ts`: detection
range is intentionally short to force close-approach behaviour, and contacts carry seeded
localisation error. An honest placeholder. Replace it.

**Model.** Johnson criteria — detection, recognition and identification each require a
threshold number of resolved elements across the target's critical dimension. Thermal
detection additionally requires an object-to-background difference of **≈2 °C**.

Governing relation (derived and verified in §18.1):

```
pixels_across_target = target_size × focal_length / (range × pixel_pitch)
```

| Parameter | Professional UAV thermal | Consumer |
|---|---|---|
| NETD | 30–50 mK | 100–200 mK |
| Skydio X10 | FLIR Boson+ 640×512, ≤30 mK | — |
| DJI M4T | up to 1280×1024 (High-Res Mode) | — |

**Atmospherics.** Johnson criteria contain no weather term, and no simple model fully captures
fog, rain and smoke; the standard fix is an atmospheric transmission multiplier or empirical
visibility model. Grounded number worth teaching: **LWIR retains 50–70 % of range in light fog
where visible-band cameras can lose function entirely** — exactly the lesson your coastal SAR
and wildfire scenarios exist to teach.

**New: gate detection on line of sight.** Range alone is not detection. A contact behind a
building is invisible at any range. This converts the urban scenarios from "lawnmower above
the city" to "work the street canyons."

**Decision impact.** Altitude stops being cosmetic: climb for coverage and lose resolution,
descend for identification and lose coverage — now with buildings deciding what is visible at
all.

**Files:** `src/sim/sensors/ThermalSim.ts` · `src/sim/drone/platformCatalog.ts` (sensor specs
from WP-1)

**Accept:** detection range for a given platform/target/weather matches §18.1 within 5 %; the
worked anchor reproduces (12 µm pitch, 13 mm lens, 100 m, 0.5 m human → **5.4 px**); a contact
with no LOS is never detected.

**Test:** rewrite `thermalContact.spec` against computed ranges; add LOS-occlusion cases; add
a fog case asserting LWIR degrades to 50–70 % rather than to zero.

---

## WP-6 · SAR sweep width and POD `[Tranche C]` `[needs WP-5]` — **MODULE DONE**

**Status:** the R_d → W → coverage → POD math ships as pure, tested functions in
`src/sim/sensors/sweepWidth.ts` (`sweepWidthM`, `coverage`, `podFromCoverage`,
`probabilityOfDetection`, `cumulativePod`). Anchor reproduces: 10 km track, W=164.5 m, 1 km² →
coverage 1.645 → POD ≈ 0.807. Remaining: feed it a real R_d from WP-5 and surface per-sector +
cumulative POD on the READY tab. Rest of this section is the unchanged target.

**Current state.** Detection fires on proximity. READY-tab coverage is a geometric area figure.

**What the profession uses.** Ground and maritime SAR run on **effective sweep width (W)** and
**probability of detection (POD)**. ESW reduces every factor affecting detectability — sensor,
environment, search object — to one number. Coverage is a function of effort expended, area
size and ESW; POD derives from coverage. The field relationship from the detection experiments
is **W ≈ 1.645 × R_d**, **R² = 0.827** across ten North American experiments. NASAR's
*Fundamentals of Search and Rescue* teaches searcher spacing directly from detection radius.

Full chain in §18.2. It closes cleanly: WP-5 gives R_d → W → coverage → POD.

**Why it matters.** Today a student flies a pattern and either stumbles onto the contact or
does not. With POD they face the real tradeoff every SAR incident commander faces: *re-sweep
this sector at higher POD, or move to the next at lower POD, with finite battery.* That is the
actual cognitive task, and it is the metric a real SAR planner recognises instantly — which
makes the READY tab credible to exactly the people you want as design partners.

**Files:** `src/sim/sensors/sweepWidth.ts` (new) · `src/sim/mission/missionOutcome.ts` ·
`src/components/TelemetryPanel.tsx` (READY tab)

**Accept:** per-sector and cumulative POD shown in READY; a second sweep of the same sector
raises POD along the documented curve; POD is 0 where LOS was never achieved.

**Test:** `sweepWidth.spec.ts` — known track length + area + W reproduces textbook coverage
and POD values.

**Bonus.** This is also the honest replacement for the fabricated "TIME SAVED" KPI flagged in
the 2026-07-02 audit as a diligence risk. POD is defensible; that KPI was not.

---

## WP-7 · GNSS occlusion → computed DOP `[Tranche C]` `[needs WP-4]` **CONFIRMED**

**Why this matters.** The Damman article anchoring the project's positioning names *"lost
link, GPS degradation, communication failure"* as the three abnormal scenarios that define
operational readiness. **GPS degradation is currently not simulated at all** — the largest gap
between what the simulator claims to rehearse and what it does.

Grounding: multipath and NLOS from buildings falsify pseudoranges and produce **position
errors exceeding 10 m in dense urban canyons**; visible satellite count can fall below the
minimum, worsening geometry, raising DOP and compounding error.

### 7.1 The tier decision, recorded

| Tier | Verdict | Reason |
|---|---|---|
| 1 — seeded HDOP curve | **Superseded** | WP-4 makes Tier 2 available for little more |
| **2 — occlusion → DOP → error** | **BUILD** | Emergent, deterministic, ~150 lines on WP-4 |
| 2.5 — NLOS flagging | Optional | Nearly free if it falls out |
| 3 — multipath ray tracing | **No** | Output has no consumer without a receiver model |
| 4 — shadow matching | **No** | *Improves* accuracy; not in real receivers |

**On Tier 3.** Ray tracing's output is a **pseudorange bias per satellite, and nothing in the
simulator consumes a pseudorange.** Turning that bias into a *reported position error* — the
only GNSS quantity an operator observes — requires simulating the receiver's position
solution: weighted least squares over corrupted pseudoranges, RAIM fault detection and
exclusion, and the Kalman filter every autopilot runs on top. **None of that exists in the
codebase.** You do not simulate a GNSS receiver; you simulate an aircraft that reports a
position. Tier 2 already delivers the observable output. *Reconsider only if you later add a
simulated receiver with RAIM behaviour the operator can act on.*

**On Tier 4.** Shadow matching is a positioning *technique* that uses the predicted
satellite-shadow pattern to **improve** a fix — the opposite of the training value. And no
receiver you would be modelling runs it: the literature is real-time research prototypes from
UCL and PolyU, published as research achievements, not products. The research itself explains
why it stays hard in consumer hardware — high-sensitivity receivers track weak NLOS signals,
and linearly-polarised antennas do not distinguish direct from reflected. Simulating it would
make the simulator **less faithful to the hardware operators actually fly.**

### 7.2 Implementation

1. **Constellation fixture** (WP-0). Compute satellite azimuth/elevation from a GNSS almanac
   for the scenario's date, time and location. Satellites move ~0.5°/min, so sample every
   **5 minutes** across the mission window and interpolate. ~12 epochs × 31 satellites ≈ a few
   KB.
2. **Visibility.** For each drone position, `skyVisibility()` against buildings and terrain per
   satellite. Elevation mask 5° minimum regardless of geometry.
3. **DOP.** Build the geometry matrix from visible satellites; invert; extract HDOP/VDOP/PDOP.
   Formulas in §18.3.
4. **Error injection.** `σ_H = HDOP × σ_UERE` with `σ_UERE = 4 m` default. Perturb the
   **reported** position with seeded noise; **the sim retains truth internally.**
5. **Fix loss.** Fewer than 4 visible satellites → no fix. Surface it as a real degraded mode:
   position hold, dead reckoning, operator decision.

**~150 lines** on top of a service WP-4 already provides. Fully deterministic.

**What the operator experiences:** reported position drifting from actual, a widening
uncertainty circle, DOP degrading as they descend between buildings, and a genuine decision
about whether to trust the track. That is the training content.

**Files:** `tools/fixtures/constellation.mjs` · `src/sim/nav/gnss.ts` (new) ·
`src/sim/nav/dop.ts` (new) · `src/types/index.ts` (add `reportedPosition`, `hdop`,
`satsVisible`, `fixQuality` to `DroneState`) · `FleetPanel.tsx` · `TacticalMap.tsx`
(uncertainty circle)

**Accept:** HDOP in open sky is 0.8–1.5; in a modelled dense canyon it exceeds 4 and horizontal
error exceeds 10 m, matching the literature; `<4` satellites **or HDOP > 20** produces a visible
loss-of-fix state rather than a wild position; reported position never jumps more than σ_H × 3
between consecutive fixes; determinism holds.

**Test:** `dop.spec.ts` — the six geometries in §18.3 reproduce their tabulated HDOP within
1 % · `gnss.spec.ts` — open-sky and canyon positions produce expected error bands, and the
degenerate geometry produces loss-of-fix rather than a 9 km error · determinism test with GNSS
active.

---

## WP-8 · RF link budget `[Tranche C]` `[needs WP-4]`

**Current state:** seeded comms-loss windows plus a weather reliability factor. Scripted — the
operator cannot influence it, so it teaches endurance rather than decision-making.

**Model selection, stated precisely — most write-ups get this wrong.** Okumura-Hata is valid
**150 MHz – 1.5 GHz**; COST-231 Hata extends to **~2 GHz**. Drone C2 and video typically run at
**2.4 / 5.8 GHz**, **outside both**. Do not reach for Hata because it is the famous name.

Defensible for your band: **ITU-R P.1411** (short-range outdoor urban, 300 MHz–100 GHz), or
**log-distance with an environment-specific path-loss exponent** per scenario clutter class.

**Recommendation: log-distance with per-scenario exponent plus true LOS/NLOS from WP-4**,
feeding link margin → packet loss → control latency. Exponents and NLOS penalties in §18.4.

Comms loss stops being a timer and becomes a consequence of aircraft placement — which is the
entire reason relay drones exist in your CBP and multi-agency scenarios, and what finally makes
the OPS HUB relay-reposition suggestion mean something.

**Files:** `src/sim/safety/commsModel.ts` (new) · `src/sim/safety/SafetyManager.ts` ·
`src/scenarios/catalog.ts` (clutter class per scenario)

**Accept:** moving a relay drone measurably changes downstream link margin; a drone behind a
ridge or building loses link without any scripted event; existing comms-loss tests are rewritten
against the physical model.

**Test:** `commsModel.spec.ts` — known geometry reproduces expected path loss; NLOS transition
produces the expected step; relay repositioning restores margin.

---

## WP-9 · NIST standard test-method scenarios `[Tranche C]` `[needs WP-4]`

The strongest cross-cutting finding, and the bridge to the Coordinator dashboard.

**NIST publishes Standard Test Methods for small Unmanned Aircraft Systems**, developed with
DHS Science & Technology support: basic proficiency for remote pilots, plus **open**,
**obstructed** and **confined** test lanes. The open lane evaluates five flight paths for
identifying objects from safe altitudes.

**The scoring rubric is fully specified:** **20 targets, each with 5 increasingly small
features to identify, up to 100 points per trial**, with a **15–20 minute limit** set so a
trial fits one battery charge.

They are **referenced as Job Performance Requirements in NFPA 2400** (sUAS for Public Safety
Operations) **and ASTM F38.03** (Training for Remote Pilot in Command endorsement).

**What that gives you in one move:**

1. **The one legitimately auto-scorable number for the Coordinator dashboard.** Auto-grading
   operator *judgment* would be torn apart by a real training officer. A NIST-derived lane
   score is not a judgment call — it is published, standardised and agency-recognised.
2. **Two standards bodies already cite it.** "Our scenarios implement the NIST sUAS standard
   test methods, referenced in NFPA 2400 and ASTM F38.03" is a procurement-grade sentence.
3. **A ready-made scenario template** — targets, features, scoring and time limit specified.
4. **Direct alignment with the training-hours play** — a standards-referenced scored trial is
   far easier for a training officer to accept as documented recurrent training.

**Obstructed and confined lanes are only buildable properly once WP-4 lands** — another reason
terrain and structures are the keystone.

**Files:** `src/scenarios/nistLanes.ts` (new) · `src/sim/mission/laneScoring.ts` (new) ·
`src/scenarios/catalog.ts`

**Accept:** an open-lane scenario scores 0–100 against the published rubric; the score appears
in the after-action package and in the Coordinator comparison table; time limit enforced.

**Test:** `laneScoring.spec.ts` — a scripted perfect run scores 100; a run identifying 3 of 5
features on 20 targets scores as specified.

---

## WP-10 · Dryden turbulence and wind gradient `[Tranche D]` `[needs WP-2]` — **MODULE DONE**

**Status:** the seeded gust generator ships as pure, tested functions in `src/sim/weather/dryden.ts`
(`drydenCoefficients`, `drydenSeries`, `lowAltitudeDryden`, `exceedsGustLimit`) — deterministic
(same seed → identical series), steady-state variance → σ², MIL-F-8785C low-altitude intensity/scale
vs altitude. Remaining: the altitude wind gradient from WP-2 and the live loop couplings (battery
burn, station-keeping, wind-limit abort). Rest of this section is the unchanged target.

**Current state:** wind is a scalar with speed-cap and battery-drain multipliers.

**Standard models.** Dryden and von Kármán continuous gust models are defined by their power
spectral densities in **MIL-F-8785C** and **MIL-HDBK-1797/1797B**. Von Kármán matches observed
gusts better and is the **US DoD preferred model for most aircraft design and simulation** —
but its PSD is irrational and harder to realise as a filter, and the survey literature notes it
**has not yet been applied to quadrotor studies**, while Dryden has been used across multiple
multirotor sUAS investigations.

**Recommendation: Dryden.** Generated by passing band-limited white noise through rational
linear filters — small code, deterministic when the noise is seeded, and the model with actual
multirotor precedent. Skip von Kármán: the more "correct" answer to a question your operators
are not asked.

Pair with the altitude wind gradient Open-Meteo provides free (WP-2) and per-platform wind
limits (WP-1).

**Honest caveat.** Turbulence primarily affects *aircraft handling*, which your console operator
does not perform. It earns its place through second-order effects the operator **does** manage:
battery burn, station-keeping failure, sensor stability degrading detection (feeding WP-5/6),
and wind-limit aborts. **Model those couplings, not the ride quality.**

**Files:** `src/sim/weather/dryden.ts` (new) · `weatherEngine.ts` · `SimulationLoop.ts`

**Accept:** seeded turbulence is reproducible; gust magnitude scales with altitude per the
fixture gradient; exceeding a platform wind limit triggers an abort.

**Test:** `dryden.spec.ts` — same seed produces an identical gust series; PSD of a long series
approximates the Dryden spectrum.

---

## WP-11 · Battery discharge curve `[Tranche D]` `[independent]` — **MODULE DONE**

**Status:** the discharge model ships as pure, tested functions in `src/sim/drone/battery.ts`
(`ocvFromSoc` with the low-SoC knee, `terminalVoltage`, `capacityTempMultiplier`, `enduranceMinutes`,
`reserveSocForVoltage`) — Peukert omitted by design; reproduces published endurance within 5% at
20 °C for every platform; cold reduces endurance; the voltage-aware reserve fires earlier than a
linear gate. Remaining: swap it into `DroneEntity`'s live drain. Rest of this section is unchanged.

**Current state:** linear drain with multipliers.

**What's real.** Voltage sags under load from internal resistance and recovers when load is
removed; temperature, discharge rate and sag all degrade endurance. **Peukert-type rate
dependency only appears above roughly 20C — not where an aircraft flying for endurance or range
operates.** So model the discharge curve and temperature derate; **skip Peukert.** It is the
famous term and it does not apply to your flight regime.

**Accuracy target.** A properly parameterised LiPo model reaches maximum relative error of
**0.0086** on discharged-capacity-to-terminal-voltage and **0.0195** on rotorcraft endurance.
Roughly 2 % endurance error is achievable and defensible.

**Files:** `src/sim/drone/battery.ts` (new) · `SimulationLoop.ts` · `platformCatalog.ts`

**Accept:** modelled endurance for each platform lands within 5 % of the published figure at
20 °C in still air; cold-weather scenarios show reduced endurance; the voltage knee triggers RTB
earlier than linear drain does.

**Test:** `battery.spec.ts` — endurance per platform within tolerance of WP-1 specs; temperature
derate monotonic.

---

## WP-12 · Recorded public air traffic `[Tranche C]` `[needs WP-0]`

**Current state:** the map shows only the sim's own fleet. Real airspace is never crowded —
the operator practises in an empty sky, which is the least realistic thing about it after the
flat earth (WP-4). Every real DFR mission shares the AO with medevac helos, news aircraft, GA
traffic and other agencies' flights that **the operator neither commands nor deconflicts on
their behalf** — they observe and stay clear.

**Upgrade.** Replay *recorded historical* ADS-B for each scenario's real date/time/AO as a
semitransparent, non-interactive awareness layer. Fetched at authoring time (WP-0), frozen to a
fixture, replayed on the sim clock. **This is the same determinism pattern as WP-2/WP-3, and
the same honesty posture: real *data*, no live *feed*.** Your note said *"realtime"* — the only
faithful version of that is *replayed-on-mission-clock from a recording*, never a runtime fetch
(§3). A live feed would break determinism, the project's most defensible claim.

**Source.** [OpenSky Network](https://opensky-network.org/) historical state-vector API — free
for research/non-commercial use, REST, returns `icao24`, `callsign`, `lat`, `lon`,
`baro_altitude`, `velocity`, `true_track`, `on_ground` per epoch. Account + rate limits apply at
*authoring* time only, which fits WP-0's "manual maintainer run, never in CI" model. Fallback:
ADSB-Exchange historical. Record source URL, retrieval date, licence and SHA-256 in
`manifest.json` — the OpenSky terms make provenance non-optional exactly as Open-Meteo's CC BY
does for WP-2.

**Fixture format** (`traffic.json`): aircraft tracks over the mission window, positions sampled
every **5–10 s** and interpolated at render — aircraft move fast but a 200 px overview does not
need per-second fidelity. Callsigns hashed/rounded if any privacy concern; commercial and public
traffic is public data but keep the manifest honest. Typical urban AO over a 20-minute window is
a few dozen tracks → **~30–80 KB gzipped**, well inside the §21 budget.

```json
{ "icao24": "a1b2c3", "callsign": "N911LA", "kind": "helo|ga|jet|unknown",
  "samples": [[t, lat, lng, altFt, headingDeg], ...] }
```

**Design.** A pure `externalTraffic.ts` service reads the fixture and, given `elapsedSec`,
returns the interpolated set of active aircraft. `tacticalMapGeoJson.ts` emits a
semitransparent aircraft layer, wired into the existing **LAYERS** control (per the
operational-realism pass) so it toggles like every other overlay. Labelled on-map exactly as the
regulatory surfaces are: **"recorded public traffic — not under sim control."** The sim kernel
does not change; a scenario with no `traffic.json` behaves as today.

**The hard boundary — awareness, never control.** This layer feeds the *operator's eyes only*.
It must **never** enter the deconfliction engine's command path: the sim does not route, warn, or
maneuver these aircraft, and they never count as sim-controlled conflicts. They may drive a
*passive* proximity cue ("manned aircraft within 0.5 nm / 500 ft") — which is real airspace
awareness and pairs with WP-3 ceilings and WP-7 degraded-nav — but the decision and the staying-
clear are the operator's, which is precisely the trained task (§1).

**Decision impact.** The sky stops being empty. "A medevac is transiting your search box, descend
and hold" and "a news helo is orbiting the incident, keep your sector clear" become live operator
decisions grounded in traffic that *actually flew there that day*. That is cognitive fidelity, not
decoration.

**Files:** `tools/fixtures/traffic.mjs` · `src/sim/airspace/externalTraffic.ts` (new) ·
`src/components/tacticalMapGeoJson.ts` · `src/components/TacticalMap.tsx` ·
`src/scenarios/catalog.ts` (reuse WP-2's `realDate`; add `realTimeWindow`)

**Accept:** ≥6 scenarios carry recorded traffic; the layer toggles via the existing LAYERS
control; **zero runtime fetch** (CI bundle assertion still green); determinism holds with traffic
active; external aircraft never appear in the deconfliction engine's conflict set or command path.

**Test:** `externalTraffic.spec.ts` — fixture replay reproduces positions at a given sim-time;
interpolation is monotonic between samples; the GeoJSON builder emits the expected
semitransparent layer; a determinism case with traffic active; a guard asserting external
aircraft ids never reach `DeconflictEngine`.

---

# Part III — Technical reference

## 18. Closed formulas

### 18.1 Thermal detection (WP-5)

Angular size of one pixel: `IFOV = pixel_pitch / focal_length` (radians).
Ground sample at range R: `GSD = IFOV × R`.
Resolved elements across a target of critical dimension `S`:

```
pixels_across = S / (R × pixel_pitch / focal_length)
              = S × focal_length / (R × pixel_pitch)
```

**Verification against the published anchor.** 12 µm pitch, 13 mm lens, R = 100 m, human
S = 0.5 m:

```
IFOV = 12e-6 / 13e-3        = 9.23e-4 rad
GSD  = 9.23e-4 × 100        = 0.0923 m/px
px   = 0.5 / 0.0923         = 5.4 px      ✓ matches the source exactly
```

Thresholds (cycles-across-target conventions vary by source — calibrate against the anchor
above, where 5.4 px is described as comfortable detection and insufficient identification):

| Task | Approx. pixels across target |
|---|---|
| Detection | ~2 |
| Recognition | ~8 |
| Identification | ~13 |

Gates applied in order:
1. **LOS** — `hasLineOfSight(drone, contact)` must be clear (WP-4).
2. **Thermal contrast** — `|T_object − T_background| ≥ 2 °C`, scaled by sensor NETD.
3. **Resolution** — `pixels_across ≥ threshold`.
4. **Atmosphere** — multiply effective range by transmission τ. In light fog LWIR retains
   **0.5–0.7**; visible-band may go to ~0.

Detection radius `R_d` = the range at which gates 2–4 are simultaneously satisfied. Feeds WP-6.

### 18.2 Sweep width and POD (WP-6)

```
W        = 1.645 × R_d                     (R² = 0.827, ten detection experiments)
effort   = Σ track_length over the sector
coverage = (effort × W) / sector_area
POD      = 1 − exp(−coverage)              (random-search curve; conservative)
```

Use the random-search curve as the baseline. Well-executed parallel-track sweeps outperform
it, so reporting it is the defensible direction to err.

### 18.3 Dilution of precision (WP-7)

For each visible satellite *i*, with unit line-of-sight vector `(eᵢ, nᵢ, uᵢ)` in local
east-north-up from the receiver, build the geometry matrix:

```
G = [ −e₁  −n₁  −u₁  1 ]
    [ −e₂  −n₂  −u₂  1 ]
    [  …    …    …   … ]

Q = (Gᵀ G)⁻¹
```

```
HDOP = √(Q₁₁ + Q₂₂)
VDOP = √(Q₃₃)
PDOP = √(Q₁₁ + Q₂₂ + Q₃₃)
GDOP = √(trace Q)
```

Error injection:

```
σ_H = HDOP × σ_UERE          σ_UERE = 4 m default (tunable per platform)
σ_V = VDOP × σ_UERE
```

Requires ≥4 visible satellites; below that, no fix. Apply a 5° elevation mask regardless of
geometry. If Tier 2.5 is taken, inflate σ_UERE for satellites tracked but flagged NLOS.

**Verified reference values.** Computed from the formulas above with σ_UERE = 4 m — use these
as the test fixtures for `dop.spec.ts`:

| Geometry | HDOP | σ_H |
|---|---:|---:|
| Open sky, 8 satellites | 0.94 | 3.8 m |
| Open sky, 6 satellites | 1.24 | 5.0 m |
| Street canyon N–S, 6 satellites | 5.23 | 20.9 m |
| Street canyon N–S, 5 satellites | 6.61 | 26.4 m |
| Deep canyon, 4 satellites | 106.85 | 427 m |
| Near-degenerate (2 azimuth clusters) | 2448.27 | 9,793 m |

The first four rows match the literature: open sky a few metres, dense canyon **>10 m**.

**⚠ Implementation trap — clamp DOP, do not trust it.** The bottom two rows are
*mathematically correct* and would be *catastrophic* in the simulator: a drone teleporting
400 m or 10 km because the geometry matrix went near-singular. Real receivers do not report a
400 m position — they refuse the fix. Autopilots carry a DOP threshold above which they
degrade to position-hold.

**Rule:** `HDOP > 20` → treat as **loss of fix**, not as a valid position with huge error.
Same handling as `<4` satellites: position hold, dead reckoning, operator decision. This is
both more faithful to real hardware and far better training content than a wildly jumping
marker. Clamp before the error injection, never after.

### 18.4 RF path loss (WP-8)

```
PL(d) = PL(d₀) + 10 · n · log₁₀(d / d₀) + X_σ + NLOS_penalty
```

with `d₀ = 1 m`, `PL(d₀)` from free-space at the operating frequency.

| Clutter class | Exponent *n* | Shadow fading σ | Example scenarios |
|---|---|---|---|
| Open / water | 2.0–2.2 | 3 dB | Cape Cod SAR, Ocean Beach |
| Rural / desert | 2.5–2.8 | 4 dB | Big Bend, Laredo corridor |
| Suburban | 2.8–3.2 | 5 dB | Fort Myers Beach, East Bay |
| Urban | 3.2–3.6 | 7 dB | Oakland, Skid Row |
| Dense urban | 3.6–4.5 | 8 dB | Financial District, Times Square |

`NLOS_penalty` when `hasLineOfSight()` is false: **+15 to 25 dB**, scaled by blocker height
above the ray. `X_σ` is log-normal shadow fading, seeded.

Link margin → packet loss → control latency → the existing comms-degraded / comms-lost states.

## 19. Fixture formats

| Fixture | Format | Typical size | Notes |
|---|---|---|---|
| `terrain.png` | Terrarium RGB PNG, 10 m | 90–150 KB | One artifact for MapLibre *and* physics |
| `terrain-inset.png` | Terrarium RGB PNG, 2 m | ~25 KB | Optional, launch/recovery boxes |
| `buildings.json` | GeoJSON, ≤10 verts, `{h,hSrc,base}` | 100–250 KB gz | 2–5 k features typical |
| `weather.json` | Open-Meteo hourly slice | ~10 KB | Multi-altitude wind included |
| `airspace.json` | UASFM GeoJSON clip | ~20 KB | Carries `MAP_EFF_DT` |
| `constellation.json` | az/el per satellite, 5-min epochs | ~5 KB | ~12 epochs × 31 sats |
| `manifest.json` | provenance + SHA-256 | ~2 KB | **Required** — licence and attribution |

**Total per scenario ≈ 250–450 KB; across 21 scenarios ≈ 5–9 MB committed.**

---

# Part IV — Constraints and boundaries

## 16. Per-version fidelity matrix

Per §2: **simulation identical everywhere; only rendering varies.**

| Capability | Windows | Mobile | Coordinator tiles | Coordinator focus |
|---|---|---|---|---|
| Terrain elevation *math* | full | **full** | full | full |
| Building occlusion *math* | full | **full** | full | full |
| GNSS / RF / thermal LOS | full | **full** | full | full |
| Deterministic from seed | identical | **identical** | identical | identical |
| 3D terrain *render* | hillshade + relief | 2D hillshade raster | baked into backdrop | yes |
| 3D building *render* | `fill-extrusion` | **2D footprints only** | footprint mask in backdrop | `fill-extrusion` |

### 16.1 The mobile constraint is real and specific

MapLibre's `fill-extrusion` pipeline tessellates every building polygon into full 3D vertex
and index buffers held on the GPU. Measured consequence: **900 MB to 1.6 GB+ of memory on iOS
at zoom 17 with 3D buildings enabled**, to the point that **production applications disabled
3D buildings during navigation entirely because the OS killed the app under memory pressure.**

**The mobile build must not render extruded buildings.** It renders 2D footprint polygons with
height-shaded fill — visually flatter, simulation byte-identical, because the occlusion math
never touched the renderer. Desktop should still apply frustum culling and distance-based LOD;
on mobile, do not enable extrusion at all.

This is §2 doing exactly the job it exists to do.

### 16.2 Coordinator tiles

Tiles are Canvas 2D over a shared static backdrop bitmap. Terrain hillshade and building
footprint masks **bake into that backdrop once per class**, so 24 live tiles carry zero
incremental terrain cost. The focused single-student view uses a real MapLibre map and gets the
desktop treatment.

## 17. Known limitations, re-read

| Stated limitation | Verdict |
|---|---|
| Thermal range "intentionally simplified" | **Fix — WP-5.** Caps WP-6 until resolved. |
| Seeded localisation error on contacts | **Keep, reframe.** Correct behaviour, not a limitation — real sensors report imprecise positions. Rename it a feature and cite the basis. |
| Replay ~10 min rolling window | **Keep.** Bounded memory is right. An instructor debriefing a 40-min mission should get frames streamed off-device (Coordinator plan), not a raised `MAX_FRAMES`. |
| No real drones / FAA / LAANC / UTM | **Keep permanently.** The one upgrade with *negative* value. |
| Map tiles from OpenFreeMap; fallback not geographic | **Low priority.** Physical fidelity only. |
| Regulatory surfaces simulation-only | **Keep the wording exactly.** Real data + simulated authorisation is the defensible position. |

Gaps **not** on that list that should be: no terrain or building geometry (WP-4) · no GNSS
error model (WP-7) · comms loss scripted rather than physical (WP-8) · the fabricated
"TIME SAVED" KPI, which WP-6 replaces with POD.

## 20. What not to build

- **GNSS multipath ray tracing** — output has no consumer without a full receiver model (WP-7.1).
- **GNSS shadow matching** — improves accuracy and is not in real receivers (WP-7.1).
- **Full 6-DOF flight dynamics** — stick response is not the trained task.
- **Photorealistic 3D / camera-feed rendering** — pure physical fidelity, enormous cost, and it
  would demolish the "runs in a browser tab, no install" advantage.
- **Extruded 3D buildings on mobile** — 900 MB–1.6 GB iOS memory (§16.1). Math still runs.
- **DSM as the terrain surface** — makes AGL reference roof height (WP-4.2).
- **1 m terrain rasters shipped as fixtures** — ~1.5 GB across the catalog. 10 m carries every
  decision (WP-4.3).
- **Live FAA / LAANC / UTM integration** — negative value; use frozen fixtures.
- **Von Kármán turbulence** — Dryden is the multirotor-precedented, seedable choice (WP-10).
- **Peukert battery effects** — wrong discharge regime (WP-11).
- **ML-driven anything** — breaks determinism, the most defensible claim the project has.

## 21. Risks and cut lines

| Risk | Mitigation / cut line |
|---|---|
| WP-4 overruns | It is the keystone; **do not start Tranche C until its acceptance criteria pass.** If it slips, ship Tranche A alone — it is independently valuable. |
| Fixture size creep | Hard budget: **≤500 KB per scenario.** Enforce in CI. If a scenario exceeds it, coarsen terrain before dropping buildings. |
| Terrain breaks determinism tests | Pin fixtures in-repo and add a terrain-active determinism case *in WP-4*, not later. |
| Overture height coverage gaps | `hSrc: "inferred"` is surfaced in the UI. Non-US scenarios would need a different answer — all 21 are US. |
| 3DEP 1 m coverage gaps | Fallback chain: S1M → 3DEP 1 m → Copernicus GLO-30 → AWS Terrain Tiles. Recorded per scenario in `manifest.json`. |
| Mobile regression | §16.1 is a hard rule. Add a CI assertion that the mobile bundle contains no `fill-extrusion` layer. |
| Scope drift into Tier 3/4 GNSS | The decision is recorded in WP-7.1 with reasons. Revisit only on the stated trigger. |

## 22. Definition of success

The roadmap has succeeded when all of the following hold:

1. Every scenario's weather, airspace ceiling and terrain trace to a cited source in
   `manifest.json`.
2. Thermal detection range is computed from published sensor physics and gated on line of
   sight — not tuned by hand.
3. READY reports POD per sector instead of a geometric area figure, and the fabricated
   "TIME SAVED" KPI is gone.
4. GPS degradation is a rehearsable failure mode driven by where the operator flew.
5. Comms loss is caused by aircraft placement, not a timer.
6. At least one NIST-referenced scored lane exists and reports 0–100 into the Coordinator
   comparison table.
7. The same seed produces identical output on Mobile, Windows and Coordinator builds.
8. `src/` still contains zero network calls, and `npm test && npm run lint && npm run build &&
   npm audit` is green.

Point 7 and point 8 are the ones to protect. Everything else is negotiable.

---

## Sources

**Fidelity and training transfer**
- [Does Simulation Fidelity Affect Training? (Penn State ACS)](https://acs.ist.psu.edu/papers/doozandehR19a-paper.pdf)
- [A Psychological Fidelity Approach to Simulation-Based Training](https://www.researchgate.net/publication/267562279_A_Psychological_Fidelity_Approach_to_Simulation-Based_Training_Theory_Research_and_Principles)
- [The Point of Diminishing Immersive Return](https://www.researchgate.net/publication/242360849_THE_POINT_OF_DIMINISHING_IMMERSIVE_RETURN_IMPLICATIONS_FOR_SIMULATION-BASED_TRAINING)
- [NASA — The Relationship Between Fidelity and Learning in Aviation Training](https://ntrs.nasa.gov/api/citations/20020074981/downloads/20020074981.pdf)
- [Realism in Medical Simulation: Physical, Functional, Psychological Fidelity](https://www.decentsimulators.com/post/realism-in-medical-simulation-physical-functional-and-psychological-fidelity)

**Terrain and buildings**
- [USGS — About 3DEP Products & Services](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
- [USGS 3DEP 1-metre DEM (ScienceBase)](https://www.sciencebase.gov/catalog/item/543e6b86e4b0fd76af69cf4c)
- [USGS — Seamless 1 Metre DEM (S1M)](https://www.usgs.gov/3d-elevation-program/new-product-3d-elevation-program-seamless-1-meter-digital-elevation-model-s1m)
- [OpenTopography — USGS 1 metre DEM](https://portal.opentopography.org/datasetMetadata?otCollectionID=OT.012021.4269.3)
- [Overture Maps — Buildings Guide](https://docs.overturemaps.org/guides/buildings/)
- [Overture Maps — Buildings schema concepts](https://docs.overturemaps.org/schema/concepts/by-theme/buildings/)
- [Overture Maps — Powering Microsoft Maps with Overture (2026)](https://overturemaps.org/case-study/2026/powering-microsoft-maps-with-overture-faster-releases-better-data/)
- [AWS Registry of Open Data — Terrain Tiles (Terrarium)](https://registry.opendata.aws/terrain-tiles/)
- [AWS Registry of Open Data — Copernicus DEM](https://registry.opendata.aws/copernicus-dem/)
- [MapLibre GL JS — 3D Terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/)
- [MapLibre GL JS — Display buildings in 3D](https://maplibre.org/maplibre-gl-js/docs/examples/display-buildings-in-3d/)
- [maplibre-native #4107 — fill-extrusion memory on mobile](https://github.com/maplibre/maplibre-native/issues/4107)

**GNSS**
- [Simulation-based Analysis of Multipath Delay Distributions in Urban Canyons](https://arxiv.org/pdf/2006.14873)
- [Simulation Study of Multi-GNSS Positioning in Urban Canyon Environments (MDPI)](https://www.mdpi.com/2079-9292/14/17/3485)
- [Simulating GNSS multipath in urban environments using 3D ray tracing](https://www.sciencedirect.com/science/article/pii/S1574119226000799)
- [3D LiDAR Aided GNSS NLOS Mitigation in Urban Canyons](https://arxiv.org/pdf/2112.06108)
- [Shadow Matching: A New GNSS Positioning Technique for Urban Canyons (UCL)](https://discovery.ucl.ac.uk/1308009/1/1308009_JNav%20Shadow%202011.pdf)
- [Urban Positioning on a Smartphone: Real-time Shadow Matching (UCL Discovery)](https://discovery.ucl.ac.uk/id/eprint/1394970/)
- [Robust GNSS Shadow Matching for Smartphones in Urban Canyons (PolyU)](https://www.polyu.edu.hk/aae/ipn-lab/us/publications/Fullpaper/Robust%20GNSS%20Shadow%20Matching%20for%20Smartphones%20in%20Urban%20Canyons.pdf)
- [Smartphone Shadow Matching for Better Cross-street GNSS Positioning (J. Navigation)](https://www.cambridge.org/core/journals/journal-of-navigation/article/smartphone-shadow-matching-for-better-crossstreet-gnss-positioning-in-urban-environments/A146E3A7E0F01D777C31B4D93291ECF2)

**Search theory**
- [USCG — A Method for Determining Effective Sweep Widths For Land Searches](https://www.dco.uscg.mil/Portals/9/CG-5R/nsarc/LandSweepWidthDemoReportFinal.pdf)
- [Sweep Width Estimation for Ground Search and Rescue](https://www.dco.uscg.mil/Portals/9/CG-5R/nsarc/DetExpReport_2004_final_s.pdf)
- [Koester et al. — Visual Range of Detection to Estimate Effective Sweep Width](https://journals.sagepub.com/doi/full/10.1016/j.wem.2013.09.016)
- [Critical Separation Versus Effective Sweep Width](https://pubmed.ncbi.nlm.nih.gov/32044212/)
- [Journal of Search & Rescue — Koester, POD and Syrotuck](https://journalofsar.com/wp-content/uploads/2020/04/v4-7-Koester-POD-Syrotuck.pdf.pdf)

**Thermal / IR**
- [Johnson's Criteria for Thermal Imaging Detection Range](https://www.hzsoar.com/news/johnson-s-criteria-for-thermal-imaging-detection-range/)
- [Johnson Criteria for Thermal Imaging — IRmodules](https://www.irmodules.com/information/news/johnson-criteria-for-thermal-imaging/)
- [UAV Thermal Imaging: Complete Guide to Drone Infrared Cameras](https://aerialaccuracy.com/resources/uav-thermal-imaging-guide)
- [Axis — Thermal Cameras white paper](https://www.axis.com/dam/public/1c/66/25/thermal-cameras-en-US-350481.pdf)
- [Refining Atmosphere Profiles for Aerial Target Detection Models](https://pmc.ncbi.nlm.nih.gov/articles/PMC8588161/)

**Weather and airspace data**
- [Open-Meteo — Historical Weather API (ERA5, 1940–present, no key, CC BY 4.0)](https://open-meteo.com/en/docs/historical-weather-api)
- [Open-Meteo — Features](https://open-meteo.com/en/features)
- [FAA — UAS Facility Maps](https://www.faa.gov/uas/commercial_operators/uas_facility_maps)
- [FAA UAS Data Delivery System](https://udds-faa.opendata.arcgis.com/)
- [FAA UAS FacilityMap Data — ArcGIS Hub](https://hub.arcgis.com/datasets/faa::faa-uas-facilitymap-data/about)

**Wind and turbulence**
- [Von Kármán wind turbulence model](https://en.wikipedia.org/wiki/Von_K%C3%A1rm%C3%A1n_wind_turbulence_model)
- [Digital simulation of atmospheric turbulence for Dryden and von Kármán models (AIAA JGCD)](https://arc.aiaa.org/doi/10.2514/3.11437)
- [A Survey of Wind Measurement and Simulation Techniques in Multi-Rotor sUAVs](https://www.researchgate.net/publication/339637553_A_Survey_of_Wind_Measurement_and_Simulation_Techniques_in_Multi-Rotor_Small_Unmanned_Aerial_Vehicles)
- [Verifying Implementation of the Dryden Turbulence Model and MIL-F-8785 Gust Gradient](https://www.researchgate.net/publication/325962928_Verifying_Implementation_of_the_Dryden_Turbulence_Model_and_MIL-F-8785_Gust_Gradient)
- [Improvement of a multi-rotor UAV flight response simulation influenced by gust](https://www.sciencedirect.com/science/article/pii/S1270963823000536)

**RF propagation**
- [Hata model](https://en.wikipedia.org/wiki/Hata_model)
- [COST Hata model](https://en.wikipedia.org/wiki/COST_Hata_model)
- [Okumura-Hata Model basics — RF Wireless World](https://www.rfwireless-world.com/Terminology/Okumura-Hata-Model-basics.html)

**Battery**
- [Measuring battery discharge characteristics for accurate UAV endurance estimation](https://www.researchgate.net/publication/339337607_Measuring_battery_discharge_characteristics_for_accurate_UAV_endurance_estimation)
- [Calculation of Constant Power Lithium Battery Discharge Curves (MDPI Batteries)](https://www.mdpi.com/2313-0105/2/2/17)
- [LiPo Battery Voltage, Discharge Rate and Cycle Life — Grepow](https://www.grepow.com/blog/basis-of-lipo-battery-specifications.html)

**Standards and platform specs**
- [NIST — Standard Test Methods for sUAS (Forms Book)](https://www.nist.gov/system/files/documents/2022/04/12/NIST%20sUAS%20Open%20Tests%20-%20Forms%20Book%20(2020B13).pdf)
- [NIST — Level 1-3 Open Test Lane and Scenarios](https://www.nist.gov/el/intelligent-systems-division-73500/standard-test-methods-response-robots/aerial-systems/open-test)
- [NIST — Aerial Drone Tests FAQ](https://www.nist.gov/el/intelligent-systems-division-73500/standard-test-methods-response-robots/aerial-drone-tests-3)
- [Vertical Mag — A standard proficiency test for small drone pilots](https://verticalmag.com/features/small-drone-pilot-proficiency-test/)
- [DJI Matrice 4 Series — Specs](https://enterprise.dji.com/matrice-4-series/specs)
- [Skydio X10 — Technical Specs](https://www.skydio.com/x10/technical-specs)
- [BRINC Responder](https://brincdrones.com/responder/)
