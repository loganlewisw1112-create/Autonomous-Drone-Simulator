# SPEC — 3D scene layer for Drone Ops Center

Status: draft for review. Execute in a fresh session, not this one.
Author context: written 2026-09-17 against the build served at `127.0.0.1:4173`.

---

## 0. What is actually there today

Verified by live inspection of the running map instance and by reading the served bundles
(`index-Bi5p9tgF.js`, `catalog-BlRmqTdR.js`, `maplibre-DU7twhDu.js`):

| Fact | Value |
|---|---|
| Renderer | `maplibre-gl` **6.6.0**, mercator projection |
| Style | 139 layers, 23 sources |
| Terrain | `raster-dem`, **Terrarium** encoding, `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, exaggeration **1.15** |
| Basemap tiles | OpenFreeMap |
| Buildings | Overture, drawn as `fill-extrusion` (7 references) |
| Weather | open-meteo archive API (63 references) |
| Drones | **DOM `Marker`s** — flat, ground-pinned, cannot hold an altitude |
| three.js | **not present** |
| Custom layers | **none** |
| Camera | `pitch 0`, `maxPitch` left at default 60 |

Camera behaviour, probed directly on the live instance:

- `setMaxPitch(180)` is accepted.
- `setPitch(>90)` is **not** — it re-clamps (observed 82.7 and 90).
- `jumpTo()` with a full option set including `elevation`, plus `setCenterClampedToGround(false)`,
  **holds pitch 123.6° and 107.87°**. Camera below subject, looking up, works.
- `calculateCameraOptionsFromTo(fromLL, fromAlt, toLL, toAlt)` returns pitch 107–177° for an
  upward look and derives zoom/bearing. Use it as the only camera primitive.
- `setRoll`, `setVerticalFieldOfView` (default 36.87°), `setSky`, `setCenterElevation` all work.
- `FreeCameraOptions` does not exist in MapLibre. It is a Mapbox API. Stop looking for it.

**The camera is already solved. The missing piece is that there is nothing in the scene worth
pointing it at.** Six DOM markers pinned to the ground is why the view reads as flat.

---

## 1. Decision

**Add a three.js scene as a MapLibre custom layer (`renderingMode: '3d'`) sharing MapLibre's
WebGL context.** Do not replace MapLibre.

Rationale: the 139-layer tactical stack is the product. A renderer swap throws it away. Sharing
the GL context means the three.js scene writes into MapLibre's depth buffer, so terrain and
`fill-extrusion` buildings occlude drones for free — this is what MapLibre's own
`adding-3d-models-using-threejs-on-terrain` example relies on.

### The alternative, and why not

**CesiumJS** (1.145.0, 79 MB unpacked) gives sun-accurate shadows, PBR + IBL, post-processing
(AO, bloom, DOF, silhouettes), terrain collision, glTF animation and 3D Tiles out of the box —
genuinely more than this plan delivers. It is the right answer *if* the goal becomes
photogrammetry, 3D Tiles ingest, or a globe. It is the wrong answer now because it is a second
styling system, a second tile stack, and none of the 139 layers come with it. Revisit at the
point you want 3D Tiles; the scene graph built here ports to it.

**`react-three-map`** (1.0.1) looks like a shortcut and is not one: it peer-depends on
`react-map-gl >= 7.1`, which this app does not use — the map is constructed directly. Adopting it
means restructuring the map mount. Hand-roll the custom layer instead; the matrix pipeline is
~60 lines and MapLibre publishes it as an official example.

### What this architecture cannot do

Be honest about the ceiling up front:

- MapLibre draws the terrain. Its mesh is not in the three.js scene, so it **cannot receive**
  three.js shadows without the workaround in Phase 3.
- No unified PBR — map tiles are unlit raster/vector, models are lit. They will never perfectly
  agree. Match them by eye via the sky/fog palette.
- Post-processing (`EffectComposer`) fights MapLibre's draw order and framebuffer. Treat bloom
  and AO as out of scope unless Phase 5 proves otherwise.
- Globe projection changes the matrix pipeline. Stay on mercator.

---

## 2. Dependencies

Pin exactly. Versions confirmed on registry.npmjs.org 2026-09-17:

```
three            0.186.0
suncalc          (verify version + last publish before adding; used only for solar position —
                  if it looks unmaintained, inline the NOAA solar position algorithm, ~80 lines)
```

Everything else — glTF loading, Draco, KTX2, shadow maps — ships inside `three`. Do not add a
scene-graph wrapper, a physics engine, or a post-processing library in this project.

Asset tooling (devDependencies, build-time only): `gltf-transform` CLI for Draco/meshopt
compression and KTX2 texture conversion.

---

## 3. Phases

Each phase ends with a demonstrable artifact and a test that can go red. Do not start a phase
before the previous phase's test passes.

### Phase 0 — Render harness (2–3 days)

The riskiest part is not the models, it is sharing a GL context with MapLibre without corrupting
its state. Prove that first, with a box.

- `SceneLayer` implementing `CustomLayerInterface`, `renderingMode: '3d'`.
- `new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true })`,
  `autoClear = false`, `renderer.resetState()` at the top of every `render()`.
- Scene origin: one fixed ENU anchor per scenario (`MercatorCoordinate.fromLngLat(origin, originElevation)`).
  All scene geometry is metres relative to that anchor. Do **not** place objects in mercator units —
  precision degrades with latitude and you will chase jitter for a week.
- Camera matrix from `args.defaultProjectionData.mainMatrix` composed with the origin transform,
  exactly as the MapLibre example does.
- Frame-time HUD: ms spent inside the layer's `render()`, separate from total frame time.
- Kill switch: a flag that unmounts the layer and restores the DOM markers. Ship this on day one;
  you will need it.

**Exit test:** an untextured 3 m box at UAV-01's true lng/lat/altitude, which *disappears when a
ridge is between it and the camera*, at pitch 0, 60, and 107. Occlusion at pitch >90 is the one
that matters and the one most likely to surprise you.

**Unverified going in:** that three.js shadow rendering composites cleanly into MapLibre 6.6.0's
framebuffer. MapLibre publishes a shadow example, but I have not executed it against 6.6.0. If
Phase 0 shows state bleed (black map, missing layers), that is the signal to re-scope toward
Cesium before spending five more weeks.

### Phase 1 — Models and LOD (1 week)

- Two airframes to match the fleet: TEAL2 and X10. Source or model as glTF 2.0.
- `gltf-transform`: Draco geometry, KTX2/Basis textures. Budget **≤ 2 MB total** for all airframes.
- Animation: prop spin driven by commanded RPM, gimbal yaw/pitch driven by telemetry, gear/payload
  state from the mode field (`THERMAL HOLD`, `INSPECT`, `LANDING` are already in the fleet model).
- LOD ladder, switched on camera distance:
  - `< 300 m` — full mesh, animated props
  - `300–1500 m` — decimated mesh, static props
  - `> 1500 m` — camera-facing sprite with the existing 2D fleet colour, so the tactical read survives
- One `InstancedMesh` per airframe type. Six drones does not need it; the scenario catalogue will.

**Exit test:** 20 synthetic drones, all three LOD bands on screen simultaneously, layer render
time ≤ 4 ms, draw calls ≤ 40.

### Phase 2 — Lighting (1 week)

- Solar position from the scenario clock + AOI centroid. The scenario already carries a time; use
  it, do not use wall clock.
- `DirectionalLight` as sun, `HemisphereLight` as sky fill, intensity curves keyed to solar
  elevation (including below-horizon → civil twilight → night).
- IBL: generate the environment map from the same colours fed to `map.setSky()`, so models and
  sky agree. One `PMREMGenerator` pass per significant sun-angle change, not per frame.
- Shadow camera fitted to the **visible camera frustum**, not the AOI. This is the single biggest
  perf trap in the plan: an ortho shadow camera covering the whole wildfire flank at 4096² gives
  you shadows roughly one texel per two metres, which looks like mud.
- Night mode: nav lights (red/green), anti-collision strobe on a 1 Hz schedule, additive sprites
  with distance-attenuated bloom faked in the sprite texture rather than a post pass.

**Exit test:** golden-image comparison at a fixed seed and fixed camera for four sun angles
(dawn / noon / dusk / night). Diff threshold tuned once, then held in CI.

### Phase 3 — Shadows on real geometry (1 week)

The hard phase. MapLibre's terrain cannot receive three.js shadows, so build an invisible receiver.

- Mesh a three.js heightfield from the **same** Terrarium tiles, over a radius that covers the
  shadow camera only (start at 2 km), regenerated on camera move with hysteresis.
- Apply exaggeration **1.15** exactly. Any mismatch and shadows float or sink.
- Material: `ShadowMaterial` — invisible except where shadowed, so MapLibre still draws the
  visible terrain and the shadow composites on top.
- Same treatment for buildings: extrude the Overture footprints already being fetched into
  three.js geometry with `ShadowMaterial`, so drones shadow onto rooftops and buildings shadow
  the ground.
- Depth: the receiver must not z-fight with MapLibre's terrain. Expect to need a polygon offset
  and to tune it per zoom band.

**Exit test:** a drone at 30 m AGL casts a shadow that tracks across real terrain and up the side
of a building as it flies over, at three sun elevations, with no visible z-fighting at zoom 12–18.

**This phase is the most likely to slip.** If the receiver mesh proves unworkable, the fallback is
a projected blob shadow decal on terrain — much cheaper, visually 70% of the way there, and worth
taking rather than burning a second week.

### Phase 4 — Camera director + sensor volumes (1 week)

- Wire `cameraDirector.js` (already drafted) to the scene. Modes: TACTICAL / ORBIT / CHASE / FPV /
  GROUND. All solve to camera position + look-at, then `calculateCameraOptionsFromTo`, then
  `jumpTo` on rAF. Never `easeTo` per frame — queued eases fight each other.
- Smoothing constants need tuning against the real telemetry rate; the drafted values are guesses.
- Sensor volumes, now that there is a 3D scene to hold them:
  - gimbal FOV as a translucent cone, clipped where it intersects the terrain receiver
  - thermal footprint as a decal projected onto terrain, replacing the flat `ir-footprints` layer
  - GNSS uncertainty as a shaded ellipsoid at true altitude, replacing the flat `gnss-uncertainty` circle
  - trails as altitude-correct ribbons, replacing the flat `trail-uav-*` lines
- Hide the corresponding 2D layers when the 3D layer owns that concept. Two representations of the
  same thing on screen at once is the thing that will make it look amateur.
- Ground observer: click-to-place the standpoint, eye height 1.7 m. This is the shot that needs
  pitch >90 and it is the demo shot.

**Exit test:** each mode holds a stable frame on a manoeuvring drone for 60 s with no camera
snap, no gimbal lock at bearing wrap, and INP under 200 ms while dragging to orbit. Orbit drag
must not round-trip through React state.

### Phase 5 — Atmosphere (1 week)

- `map.setSky()` is **mandatory**, not polish. Above ~80° pitch the current style renders raw
  canvas background — empty void above the horizon. Verified.
- Height fog keyed to the open-meteo visibility field already being fetched.
- Wildfire smoke column: instanced billboards with curl noise, seeded from the scenario seed so
  replays are deterministic.
- Sun glare as a screen-space sprite, not a post-process bloom pass.

### Phase 6 — Perf and verification (3–4 days)

Budgets, asserted in CI, not eyeballed:

- 60 fps p75 on the target machine; layer `render()` ≤ 8 ms
- ≤ 2 MB model assets, ≤ 6 MB total added transfer
- Shadow map ≤ 2048² with frustum-fitted camera
- Graceful degradation: a `quality` enum (`cinematic` / `balanced` / `tactical`) that drops
  shadows, then LOD bands, then the whole 3D layer

Test matrix: {1, 5, 20 drones} × {dawn, noon, night} × {ground, orbit, FPV camera} ×
{terrain on, off}. Golden images at fixed seed for each cell.

---

## 4. Risks, ranked

1. **GL state bleed between MapLibre and three.js.** Classic failure is the map going black or
   layers vanishing intermittently. Mitigated by `resetState()` discipline and the Phase 0 kill
   switch. This is why Phase 0 exists as its own gate.
2. **Shadow receiver terrain (Phase 3).** Highest chance of slipping a week. Blob-shadow fallback
   defined above — take it rather than fighting.
3. **`defaultProjectionData.mainMatrix` API stability.** The official example uses it; confirm it
   is public and stable in 6.6.0 rather than an internal that moves in 6.7.
4. **Shadow acne on 1.15× exaggerated terrain.** Budget a day for bias tuning.
5. **Z-fighting between 139 existing layers and 3D geometry.** Decide a global render order in
   Phase 0, not Phase 4.
6. **Scope creep into post-processing.** Bloom/AO/DOF are where this plan turns into a 12-week
   plan. They are Cesium's territory. Say no.

---

## 5. Assumptions made without asking

Stated so they can be corrected rather than silently inherited:

- Target is desktop Chrome on a discrete GPU. If mobile is in scope
  (`autonomous-drone-simulator-mobile.vercel.app` appears in the bundle), Phases 2–3 need a
  separate low-end path and the estimate grows by ~1.5 weeks.
- Fleet stays under ~25 concurrent aircraft.
- Scenarios remain fixed-AOI. Global free-roam would change the terrain-receiver strategy.
- Determinism matters — replay exists in the bundle (61 references), so every visual system added
  here must be seeded, not `Math.random()`.

---

## 6. Estimate

| Phase | Duration |
|---|---|
| 0 — Render harness | 2–3 days |
| 1 — Models and LOD | 1 week |
| 2 — Lighting | 1 week |
| 3 — Shadows on real geometry | 1 week (highest slip risk) |
| 4 — Camera director + sensor volumes | 1 week |
| 5 — Atmosphere | 1 week |
| 6 — Perf and verification | 3–4 days |

**5.5–6 weeks** at a steady pace, assuming Phase 0 passes its gate in the first three days. If it
does not, stop and re-scope to Cesium rather than pushing through.
