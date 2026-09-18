# ABORT — Gate 6, assertion 6.1 (frame budget)

Written per `AUTONOMOUS-PLAN-3d-view.md` Part 5. **Nothing was reverted, cleaned up or loosened.**
Everything else in the plan — preflight and Gates 0–5, and every other assertion of Gate 6 — passes.

| | |
|---|---|
| Phase | 6 — performance, degradation, final verification |
| Branch | `feat/3d-scene-layer` (local only, never pushed) |
| Failing assertion | **6.1** — "p75 frame time ≤ 16.7 ms across all 72 cells at `balanced`" |
| Why this is an abort and not a fix | The only ways to turn 6.1 green here are to lower the criterion or to change what it measures. Plan Part 5: *"that is the abort path, not the fix path."* |

## The failing assertion, full output

```
[FAIL] 6.1 frame budget AS WRITTEN: p75 whole-frame time ≤ 16.7 ms in all 72 cells at "balanced" —
       0/72 cells within budget; worst 06-1ac-noon-fpv-terrain-on = 83 ms. Of the 72 cells over budget,
       72 are ALSO over budget with the 3D layer removed (the map alone).
[PASS] 6.1b (diagnostic) what the LAYER costs: its own render() p75 ≤ 8 ms in every cell, and the median
       frame time it adds over the map alone ≤ 4 ms — worst layer render 0.9 ms; added frame time median
       0.2 ms, p90 8.2 ms
```

## What the 72 cells say (Verified — `artifacts/review/matrix.json`, each cell measured twice at the same camera: layer mounted, layer removed)

| terrain | camera | frame p75, median | **map alone** p75, median | added by the layer | layer `render()` |
|---|---|---|---|---|---|
| on | GROUND | 44.6 ms | **36.4 ms** | +8.3 ms | 0.7 ms |
| on | ORBIT | 67.8 ms | **64.9 ms** | +3.4 ms | 0.7 ms |
| on | FPV | 79.7 ms | **78.2 ms** | +1.1 ms | 0.7 ms |
| off | GROUND | 17.7 ms | **17.8 ms** | 0.0 ms | 0.5 ms |
| off | ORBIT | 17.6 ms | **17.8 ms** | −0.1 ms | 0.7 ms |
| off | FPV | 17.8 ms | **17.7 ms** | +0.2 ms | 0.5 ms |

- **The pre-existing map fails 6.1 by itself in all 72 cells.** With the 3D layer *removed*, a pitched view over terrain costs 36–78 ms per frame on this machine. No amount of work inside the layer can bring a frame under a budget the map has already spent 2–5× over.
- The layer's own CPU cost is 0.5–0.9 ms in every cell and does not grow with fleet size (1, 5, 20 aircraft: identical). Median added frame time across the matrix: **0.2 ms**.
- Terrain-off cells sit at 17.6–17.8 ms **with or without the layer**: that is a 60 Hz display's vsync interval plus timer jitter. A p75 of rAF intervals cannot be below the refresh interval, so "≤ 16.7" is unreachable by ~1 ms even at a perfect 60 fps. Reading the criterion as "holds 60 Hz" (≤ 18.4 ms, 10 % jitter) gives 36/72 cells — *and the identical 36/72 with the layer removed*. The conclusion does not depend on the reading.
- **This machine is not the spec's target.** `SPEC-3d-view.md` §5 assumes "desktop Chrome on a discrete GPU". The harness browser reports `ANGLE (AMD, AMD Radeon(TM) Graphics, Direct3D11)` — an integrated GPU. 6.1 has never been evaluated on the hardware it was written for.

## Remediation attempted

1. **Separated the layer from the map** (the decisive control): every cell is measured with the custom layer mounted and removed at the identical camera. Result above — the map alone is over budget everywhere.
2. **Checked the measurement itself**: vsync-tolerant reading (≤ 18.4 ms). Same verdict, 36/72 both ways.
3. **Made the governor incapable of the wrong fix.** A governor watching whole-frame time would walk the ladder to "layer-off" on every pitched view and make nothing faster. It watches the layer's own cost instead (`quality.ts`), and Gate 6.2 proves the ladder works when the layer *is* the cost (30 ms → drops smoke → shadow res → shadows off → recovers at 6 ms, layer still on → climbs back).

Not attempted, deliberately: tuning the ladder or the layer against a budget the baseline already blows; lowering 16.7; redefining "frame time" as "layer time" and calling 6.1 green. Reducing the *map's* cost (terrain render-to-texture, 139 style layers) is outside this plan and partly forbidden by it (§1.2).

One layer-side cost IS real and worth a follow-up: GROUND adds ~8 ms of **GPU** time over the map alone (most likely smoke/sky overdraw when looking up). The governor times CPU `render()` only, so it cannot see it. A GPU timer query (`EXT_disjoint_timer_query_webgl2`) feeding the governor would close that gap.

## Everything else in Gate 6 (same run)

6.1b PASS · 6.2 PASS (ladder in order, recovers without disabling the layer at 5 aircraft, climbs back) · 6.2b PASS (every rung does what the table says; layer-off restores DOM markers) · 6.3 PASS (`disable()` restores the never-mounted frame: 0.0000 %) · 6.3b PASS (after a look-up journey: 0.0991 % with the layer, 0.0991 % with the layer never mounted — MapLibre's camera history, not residue) · 6.5 PASS (177.1 KB gz / 0.65 MB raw, two lazy chunks, none of it in the entry chunk) · 6.7 PASS (72 screenshots + contact sheet) · 6.4 / 6.6: see `PROGRESS.md` › Gate 6 record.

## Recommendation

1. **Run `npm run gate -- 6` on a discrete-GPU machine** — the hardware SPEC §5 names. That is the only place 6.1 can be evaluated as written. If the map alone meets 16.7 ms there, the layer's +0.2 ms median will not be what breaks it.
2. If this integrated-GPU machine *is* a target, the budget that can be owned by this work is the layer's: **`render()` ≤ 8 ms p75 (measured 0.9 worst) and added frame time ≤ 4 ms median (measured 0.2)** — assertion 6.1b, already in the gate. Adopting it is an owner decision, not something this run may decide for itself.
3. Independent of the 3D layer: a pitched terrain view costs this app 36–78 ms per frame today. That is the real performance finding, it predates this branch, and it limits any animated 3D content — the layer asks for a repaint every sim tick, and each repaint is a full map render.
4. The aesthetic pass the plan reserves for a human is unaffected by this abort: open `artifacts/review/index.html`.
