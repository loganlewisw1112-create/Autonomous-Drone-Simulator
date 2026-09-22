# ABORT — Gate 6, assertion 6.1 (frame budget) — **RESOLVED**

> **RESOLUTION.** The owner reviewed this finding and adopted recommendation #2 below: the shipping frame
> budget is the **layer's own attributable cost**, not whole-frame time. Gate 6.1 was updated to gate that
> (layer `render()` p75 ≤ 8 ms per cell, median added frame time ≤ 4 ms — measured worst **1.1 ms** / median
> added **0.2 ms**) while still measuring and printing the whole-frame numbers, and **Gate 6 now passes
> (`GATE 6 PASS assertions=11/11`)**. This was a dated owner decision, not a silent loosening: the as-written
> whole-frame result is still reported (0/72), and new assertion 6.1b proves the layer is never the reason a
> frame misses the 16.7 ms whole-frame budget. The original finding is preserved below as the evidence.

Written per `AUTONOMOUS-PLAN-3d-view.md` Part 5. **Nothing was reverted, cleaned up or loosened.**
Everything else in the plan — preflight and Gates 0–5, and every other assertion of Gate 6 — passes.

| | |
|---|---|
| Phase | 6 — performance, degradation, final verification |
| Branch | `feat/3d-scene-layer` (local only, never pushed) |
| Failing assertion (original) | **6.1** — "p75 frame time ≤ 16.7 ms across all 72 cells at `balanced`" |
| Why it was an abort, not a fix | The only ways to turn 6.1 green were to lower the criterion or change what it measures. Plan Part 5: *"that is the abort path, not the fix path."* So it was left to the owner — who has now decided (see RESOLUTION). |

## The failing assertion, original output

```
[FAIL] 6.1 frame budget AS WRITTEN: p75 whole-frame time ≤ 16.7 ms in all 72 cells at "balanced" —
       0/72 cells within budget; worst = 83 ms. Of the 72 cells over budget, 72 are ALSO over budget
       with the 3D layer removed (the map alone).
[PASS] 6.1b (diagnostic) what the LAYER costs: its own render() p75 ≤ 8 ms in every cell, and the median
       frame time it adds over the map alone ≤ 4 ms — worst layer render 1.1 ms; added median 0.2 ms
```

## What the 72 cells say (each cell measured twice at the same camera: layer mounted, layer removed)

| terrain | camera | frame p75, median | **map alone** p75, median | added by the layer | layer `render()` |
|---|---|---|---|---|---|
| on | GROUND | 44.6 ms | **36.4 ms** | +8.3 ms | 0.7 ms |
| on | ORBIT | 67.8 ms | **64.9 ms** | +3.4 ms | 0.7 ms |
| on | FPV | 79.7 ms | **78.2 ms** | +1.1 ms | 0.7 ms |
| off | any | 17.6–17.8 ms | **17.6–17.8 ms** | ≈ 0 ms | 0.5–0.7 ms |

- **The pre-existing map fails 6.1 by itself in all 72 cells.** With the 3D layer *removed*, a pitched view
  over terrain costs 36–90 ms per frame on this machine. No work inside the layer can bring a frame under a
  budget the map has already spent 2–5× over.
- The layer's own CPU cost is 0.5–1.1 ms in every cell and does not grow with fleet size. Median added frame
  time across the matrix: **0.2 ms**.
- **This machine is not the spec's target.** `SPEC-3d-view.md` §5 assumes "desktop Chrome on a discrete GPU".
  The harness browser reports `ANGLE (AMD, AMD Radeon(TM) Graphics, Direct3D11)` — an integrated GPU.

## Recommendation (as offered; #2 was adopted)

1. Run `npm run gate -- 6` on a discrete-GPU machine — the hardware SPEC §5 names. If the map alone meets
   16.7 ms there, the layer's +0.2 ms median will not be what breaks it.
2. **[ADOPTED]** If this integrated-GPU machine *is* a target, own the budget the layer can own: `render()`
   ≤ 8 ms p75 (measured 1.1 worst) and added frame time ≤ 4 ms median (measured 0.2) — assertion 6.1b, now
   the gated 6.1.
3. Independent of the 3D layer: a pitched terrain view costs this app 36–90 ms per frame today. That is the
   real performance finding; it predates this branch and limits any animated 3D content.
