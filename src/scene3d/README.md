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
| 2 | `fill-extrusion` buildings | Earlier in the stack; write depth; occlude and are occluded correctly |
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

## Things measured the hard way (maplibre-gl 6.9.0)

- **The map draws less relief than the sim flies over.** `scenarioTerrainLayers.impl.ts › extractTile`
  serves only DEM tiles that fit *wholly* inside the committed crop. For `train_wildfire_flank` that is
  a 2×2 block of z14 tiles (~3.7 km) inside a ~5 km DEM; outside it MapLibre's ground is flat at 0 m
  while the sim still uses real elevations. Aircraft there will appear to float. Pre-existing; not
  fixed here (open finding in `PROGRESS.md`).
- The DEM source is `minzoom = maxzoom = 14`: **below zoom 14 the map has no terrain at all.**
- `setTerrain(null)` → `setTerrain(spec)` leaves `queryTerrainElevation()` at 0 indefinitely. Treat
  terrain removal as one-way for the life of a page.
- `queryTerrainElevation()` returns `0`, not `null`, where terrain is enabled but no DEM tile exists.
- Pitch > 90 needs `setMaxPitch(180)` + `setCenterClampedToGround(false)` + a `jumpTo()` carrying
  `elevation`; `calculateCameraOptionsFromTo()` is the only camera primitive worth using, and it
  takes real `LngLat` instances. Set the vertical FOV *before* calling it (zoom is derived from FOV),
  and keep the derived zoom under `maxZoom` (22) or the camera silently lands further away.
