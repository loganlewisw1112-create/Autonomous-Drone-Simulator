# Realism Walkthrough — Demo Script

**Purpose.** The [investor demo script](../INVESTOR_DEMO_SCRIPT.md) shows the *operator workflow*.
This one shows the *fidelity underneath it*: every environmental layer in the simulator is frozen
from real, cited public data — never invented — and each one changes an operator decision. The
whole point is that you can answer "where did this number come from?" for anything on screen.

> **The claim, stated precisely:** **real data, simulated authorisation.** The terrain, weather,
> satellite geometry, FAA ceilings and building footprints are real and sourced. The *authorisation*
> to fly (LAANC, incident command) is simulated and labelled as such. Keep that distinction — it is
> what keeps the demo honest in front of anyone who knows the domain.

---

## Flagship scenario: **Marshall Fire — No-Launch Decision (2021)**

`hist_marshall_fire_2021` is the only scenario that carries **all five realism layers at once**, and
its lesson is the most sophisticated one the simulator teaches: **the correct answer includes
refusing to launch.** Superior / Louisville, Colorado, 30 December 2021 — a wind-driven urban
conflagration that destroyed 1,000+ structures on a day when the wind itself largely precluded safe
UAS flight.

Everything below is the *recorded* environment of that AO, frozen to committed fixtures.

### The five layers, and the decision each one drives

| # | Layer | What is real | What to show | The decision it changes |
|---|---|---|---|---|
| 1 | **Weather** (WP-2) | ERA5 reanalysis for that place & date: **24.6 kt sustained, 56 kt gusts, 34 °F, 99 % cloud** | The wind readout / weather state; launch bays closing | 56 kt is nearly 2× the ~30 kt gust that closes a launch bay. **The fleet should stay on the ground.** This is the lesson. |
| 2 | **Terrain** (WP-4) | USGS 3DEP bare-earth DTM, **1,631–1,763 m MSL** (Boulder foothills) | 3D terrain relief on the map (desktop); AGL vs MSL on a drone | Altitude is now *above ground*, not a bare number; ridgelines mask sightlines and satellites. |
| 3 | **GNSS** (WP-7) | Real CelesTrak GPS almanac → propagated satellite geometry, masked by the terrain above | FleetPanel GPS readout; the uncertainty ring on the map; a GPS DEGRADED / LOST warning where relief occludes the sky | The reported track drifts from truth as the aircraft descends between rises — the operator must decide whether to trust the position. |
| 4 | **Airspace** (WP-3) | FAA UASFM ceiling grid, **Rocky Mountain Metro (KBJC)**, 46 cells, **ceilings 0–400 ft AGL** (eff. 10/6/2022) | The ceiling layer; the **0-ft surface cells** near the field; the Part 107 attention flag if a route exceeds a published ceiling | Parts of the AO are **not auto-authorisable at all** (0 ft) — a real operational constraint, not a game rule. |
| 5 | **Buildings** (WP-4) | Overture footprints, **4,965 structures** (the Superior/Louisville suburbs), extruded to measured/inferred height | The 3D building extrusion layer (desktop); contacts hidden behind structures | Urban-canyon LOS: you must fly the street, not orbit above it — and structures further mask GNSS. |

### Suggested spoken flow (~4 minutes)

> **Verified 2026-09-17** against the desktop (`VITE_APP_TARGET=windows`) build at commit `8355dc0`,
> Marshall Fire loaded: the UI elements named below are the ones that actually render. Load the app
> on a **desktop/Windows** target — 3D terrain and building extrusions are desktop-only.

1. **Open** `HIST — Marshall Fire No-Launch Decision (2021)` from the scenario dropdown. The briefing
   frames it: Superior/Louisville, 30 Dec 2021, 1,000+ structures lost, "correct answer partly
   includes refusing to launch."
2. **Terrain is real — point at the telemetry.** The right-hand TELEM panel shows **GROUND MSL
   ≈ 5,491 ft** and **SURFACE CLR** for a drone sitting on the Boulder foothills: *"altitude here is
   height above real ground, from a USGS 3DEP elevation model — not a flat plane."*
3. **Weather.** The bottom-left **`OBSERVED WEATHER`** strip carries the recorded ERA5 conditions for
   that day — **24.6 kt sustained, 56 kt gusts.** *"This is the weather that was actually over this AO
   on 30 Dec 2021, not a dice roll."* The preflight briefing shows the sustained wind; the **56 kt
   gust** is what closes a launch bay.
4. **The teaching point:** *"The right answer here partly includes not flying — the simulator grades
   refusal discipline, and the documented gusts close the bays by design."* (Backtest anchors:
   peak-gust 30 kt threshold, fleet-held-on-ground = correct.)
5. **Airspace — this is the flagship new layer.** The preflight **AUTHORIZATION** panel has a real
   **"Airspace authorization request"** and **"Altitude / published ceiling check"** step, and the
   right-side **FAA PART 107** panel enforces **ALT ≤ 400 ft**. Turn on the ceiling layer to show the
   **46-cell KBJC grid, 0–400 ft**, and call out a **0-ft cell**: *"real FAA facility-map data — this
   cell can't be auto-authorised at all."* A route over a published ceiling trips the Part 107 flag.
6. **If you launch** (to show the rest of the stack), tilt/rotate the map to show **3D terrain relief**
   and **building extrusions** over the suburbs, then descend a drone toward a rise or structure to
   show the **GPS uncertainty ring widen / GPS DEGRADED** as satellites get masked — *"the reported
   track drifts from where the aircraft actually is; that gap is the training content."*
7. **Close on provenance:** *"Everything you just saw — terrain, weather, satellites, ceilings,
   buildings — is frozen from a cited public source with a SHA-256 in the fixture manifest. Real
   data, simulated authorisation."* (The footer even reads "agency training simulator only.")

---

## Alternate: urban-canyon emphasis

If the audience cares most about the **urban-canyon / GNSS-denial** story rather than the no-launch
lesson, use one of these instead of (or after) Marshall:

- **`hist_katrina_lower_ninth_2005`** — New Orleans Lower Ninth Ward. Terrain **at/below sea level**
  (−0.25 to 7.75 m MSL), New Orleans Lakefront (KNEW) ceilings 300–400 ft, and dense residential
  building footprints. The below-sea-level terrain is a striking, true detail.
- **`hist_surfside_cts_2021`** — the Champlain Towers collapse AO: the original committed
  building/terrain fixture, tightest urban canyon. (No FAA facility map here — a good moment to show
  the honest *absence* of a ceiling layer.)

---

## The honesty beats (say these, they land with domain experts)

- **"Real data, simulated authorisation."** The ceilings and geometry are real; the clearance to fly
  is a training simulation and is labelled so.
- **The empty answer is a real answer.** Nine of the terrain AOs (Oso, the Camp Fire flank, Kīlauea)
  have **no** published FAA facility map, so they carry **no** ceiling layer — the simulator shows
  the real gap rather than inventing a grid.
- **Representative vs documented.** Weather and satellite geometry are labelled `documented` (the real
  incident date) or `representative` (a real day at the real place) in every manifest — no fixture
  pretends to be something it isn't.
- **Determinism.** Same seed → identical run, because nothing is fetched at runtime; every real value
  was frozen at authoring time. That is why an after-action replay is byte-identical.

---

## Preflight (same as the investor script)

```bash
npm test
npm run build
npm run dev
```

Open the dev URL, switch the build to a **desktop/Windows** target (3D terrain and building
extrusions are desktop-only; mobile keeps identical *simulation* fidelity but draws 2D). Load the
Marshall Fire scenario and run the flow above.

> **Note on coverage.** This walkthrough demos what is *committed on `main`*. The public web beta is
> pinned at an earlier SHA and does not yet include the terrain/weather/GNSS/airspace/buildings
> coverage — promote `main` through the release workflow before demoing the realism on the hosted site.
