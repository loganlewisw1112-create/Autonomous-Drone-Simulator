# scene3d — three.js scene inside the MapLibre map

A three.js scene rendered as a MapLibre **custom layer** (`renderingMode: '3d'`) that shares
MapLibre's WebGL context. MapLibre stays the renderer of record: the 139-layer tactical style is
untouched, and the scene tests against MapLibre's own depth buffer, so terrain hides scene geometry
with no extra work. Proven by `npm run gate -- 0` (buried box, and natural ridges at pitch 60 and
107 — camera below the subject, looking up).

Status: **default OFF.** Until the quality tiers land (plan Phase 6) the layer is reachable only
through `window.__harness.scene` in a harness build. No public bundle imports this directory yet.

## Coordinate conventions

- **Scene space = ENU metres about one fixed anchor per scenario** (`scenario.startPosition`):
  `+X` east, `+Y` north, `+Z` up. Never place geometry in raw mercator units — at this latitude they
  need ~1e-9 resolution and float32 vertex data does not have it.
- **`Z` is *rendered* elevation in metres MSL = DEM × terrain exaggeration (1.15)** — the number
  `map.queryTerrainElevation()` returns. An aircraft at `h` m AGL sits at `ground + h`: the ground is
  exaggerated, the height above it is not.
- `SceneLayer.toScene(lng, lat, elevationM)` is exact by construction (lng/lat → mercator → linear
  inverse of the transform the layer renders with). Gate 0.2: ≤ 0.71 px error, zoom 12→18 and pitched.
- **Vertical scale is recomputed every frame from the map-centre latitude.** MapLibre scales all
  elevation in a frame by pixels-per-metre at the *centre*, not at each object's latitude; using the
  anchor's latitude instead lets geometry drift ~0.5 m against the terrain across the AO.
- Camera: `args.defaultProjectionData.mainMatrix × originTransform` is assigned straight to
  `camera.projectionMatrix` (world and view matrices stay identity), per MapLibre's
  `adding-3d-models-using-threejs-on-terrain` example.

## Render order (decided in Phase 0 — changing it means re-running every gate)

| Order | What | Relation to the scene |
|---|---|---|
| 1 | Terrain mesh + every fill/line/circle layer | With terrain on, MapLibre renders these *into the terrain texture*, so they are always beneath scene geometry and occlude it only through terrain depth |
| 2 | `fill-extrusion` buildings | Earlier in the stack; write depth; occlude scene geometry (verified, Gate 3.8) |
| 3 | Symbol layers (labels) | Earlier in the stack, no depth — scene geometry draws over labels behind it |
| 4 | **`scene3d` custom layer — last in the GL stack** (`map.addLayer(layer)`, no `beforeId`) | |
| 5 | DOM markers, HUD, panels | HTML above the canvas — always on top |

## GL-state contract

- `renderer.resetState()` is the **first statement** of `render()`; `autoClear = false`.
- `renderer.setSize()` is never called — it reassigns `canvas.width` and wipes MapLibre's frame. Only
  the viewport rectangle is tracked.
- The renderer is created once per GL context and survives `disable()`/`enable()`.
- Gate 0.4: with the layer mounted, pixels away from scene geometry differ from the unmounted frame
  by 0.0006 %; `disable()` restores the never-mounted frame exactly (0.0000 %).

## Kill switch

`handle.disable()` removes the custom layer and repaints. `handle.enable()` re-adds it, and re-adds
it again after any style swap (`style.load`), which drops custom layers.

## Fleet

- Airframes are **authored** as a `Group` of named meshes (`airframes/teal2.ts`, `airframes/x10.ts`;
  airframe-local `+Y` nose, `+X` right, `+Z` up, true metres) and **rendered** as InstancedMeshes
  (`fleet.ts`): per type hull + props + gimbal (< 300 m), one decimated mesh (300-1500 m), and one
  shared camera-facing sprite in the 2D fleet colour (> 1500 m). 9 draw calls at any fleet size.
- Drawn at `AIRFRAME_VISUAL_SCALE` (6x): true scale is sub-pixel beyond ~60 m.
- Height = the ground MapLibre **draws** + true AGL (`fleetBinding.ts`), so an aircraft never floats
  above flat map where the app serves no relief.
- Prop phase is a function of **sim** time only. No wall clock anywhere in this directory.
- While the layer owns the fleet the DOM markers are `opacity:0` (still clickable); `disable()` and
  `dispose()` give them back.

## Light and time

- **Time source = the scenario clock, never the wall clock** (`sceneClock.ts`): scenario date +
  `scenarioVariant.timeOfDay` (resolved to a real solar event at the AOI) + sim elapsed seconds.
- `sun.ts` is the NOAA solar-position algorithm, inline (no dependency), held by Gate 2.1 to an
  independent PSA/Python reference and to NREL SPA's published example (0.003 deg).
- `skyPalette.ts` is the single source of colour and intensity for the sun light, sky fill, IBL
  environment and (Phase 5) `map.setSky()`. If models and sky disagree, fix it there.
- `lighting.ts`: shadow box fitted to the VIEW (never the AOI); the environment map is rebuilt only
  when the sun moves > 1 deg elevation / 3 deg azimuth (`pmremPasses` is the instrumented count).
- Nav lights and the 1 Hz strobe are additive billboards with the glow baked into the texture - no
  post-processing pass exists, by design.

## Shadows

- MapLibre owns the terrain and building meshes, so shadows land on invisible `ShadowMaterial`
  stand-ins (`shadowReceivers.ts`) laid over what MapLibre drew. With nothing casting they change
  0.0002 % of the frame.
- The terrain stand-in covers the view-fitted shadow box only, takes its heights from
  `terrainModel.ts` (the ground as DRAWN), and is rebuilt on camera moves with hysteresis
  (0.08 ms/frame amortised over a 900 m pan). Shadow position error vs the analytic sun-ray hit:
  0.05 m in elevation across 50 m of relief.
- **Building stand-ins are OFF by default - known defect** (they shadow themselves; Gate 3.4
  skipped under the plan's fallback). See the header of `shadowReceivers.ts`.

## Camera and sensor volumes

- `cameraDirector.ts`: TACTICAL (hands off) / ORBIT / CHASE / FPV / GROUND. Every mode solves camera
  position + look-at -> `calculateCameraOptionsFromTo` -> `jumpTo`. `update(dt)` is the whole rig:
  a rAF loop feeds it live, the gates feed it fixed steps. Drag-to-orbit never touches React.
- Unlocking the camera installs a sky from `skyPalette.ts`, disables MapLibre's own pan/rotate/zoom
  handlers (they would fight the rig) and lifts the pitch cap; TACTICAL and `disable()` put it all back.
- `volumes.ts`: thermal footprint (ground-draped), gimbal cone, GNSS ellipsoid, altitude-correct
  trail ribbon. They are fed by the APP'S OWN feature builders, and `createLayerOwnership` hides the
  flat twin every frame while the 3D one is drawn. One picture per concept.

## Atmosphere

- `atmosphere.ts` owns `map.setSky()` whenever the layer is on (a style with no sky shows raw canvas
  above ~80 deg pitch) and restores the style's own sky on `disable()`. The sky is rewritten only when
  its key changes - every `setSky()` dirties the style.
- Fog is keyed to the sim's `weatherState.visibilityMi` and applied twice: MapLibre's fog terms for
  the map, a matching `FogExp2` for the scene. Distance fog, not height fog.
- Smoke: instanced billboards over heat sources >= 300 C, seeded from `scenario.seed`, animated on
  SIM time only. Smoke and haze are lit by the palette's daylight - they do not glow at night.
- Glare: one clip-space sprite at the sun, depth-tested at the far plane. **There is no
  post-processing pass in this directory and Gate 5.4 keeps it that way.**
- `handle.setAtmosphere(false)` turns all four off; the isolation checks of Gates 0-3 use it.

## Things measured the hard way (maplibre-gl 6.9.0)

- **The map draws less relief than the sim flies over.** `scenarioTerrainLayers.impl.ts › extractTile`
  serves only DEM tiles that fit *wholly* inside the committed crop. For `train_wildfire_flank` that is
  a 2×2 block of z14 tiles (~3.7 km) inside a ~5 km DEM; outside it MapLibre's ground is flat at 0 m
  while the sim still uses real elevations. The fleet therefore takes its height from the DRAWN
  ground (see Fleet), which hides the mismatch; terrain-dependent volumes in later phases still
  need it fixed at the source. Pre-existing (open finding in `PROGRESS.md`).
- **The map draws relief only at zoom >= 15** (measured: none at z14, present at z15), whatever the
  source's `minzoom` says. `terrainModel.ts` asks MapLibre once per frame instead of modelling the rule.
- `setTerrain(null)` → `setTerrain(spec)` leaves `queryTerrainElevation()` at 0 indefinitely. Treat
  terrain removal as one-way for the life of a page.
- `queryTerrainElevation()` returns `0`, not `null`, where terrain is enabled but no DEM tile exists.
- Do not jump straight to an unlocked, pitched camera at a place the map has not shown: the near field
  stays unloaded for a long time. Arrive with an ordinary camera first.
- Pitch > 90 needs `setMaxPitch(180)` + `setCenterClampedToGround(false)` + a `jumpTo()` carrying
  `elevation`; `calculateCameraOptionsFromTo()` is the only camera primitive worth using, and it
  takes real `LngLat` instances. Set the vertical FOV *before* calling it (zoom is derived from FOV),
  and keep the derived zoom under `maxZoom` (22) or the camera silently lands further away.
