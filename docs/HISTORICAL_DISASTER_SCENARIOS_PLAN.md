# Historical Disaster Scenarios — research findings and feasibility plan (v1)

**Autonomous Drone Mission Simulator · 22 July 2026 · PLAN ONLY, no code written**

Proposal under assessment: add **10 scenarios modelled on real, past US natural or public
disasters**, in which the operator learns what drone capability *would have* contributed —
backtesting the fleet against a documented historical response, and in doing so rehearsing the
same decisions for the next event of that type.

Applies to all three builds: **Mobile, Windows, Coordinator/classroom**.

---

## 0. Verdict up front

**Plausible, and it fits the architecture better than any other content expansion available —
but it is not "10 more data blobs." It is one refactor, one new feature, and 10 authoring
passes.** Roughly a third of the cost is scenario data; two thirds is (a) generalising the
catalog's derivation heuristics beyond law-enforcement vocabulary and (b) building the
historical after-action/debrief layer that makes these scenarios *teach* rather than merely
*run*.

Three things make it unusually tractable here:

1. **The precedent already shipped.** `extreme_fema_fort_myers` is already a documented real
   event — Hurricane Ian, Fort Myers Beach, 2022-09-28 — with real ERA5 weather frozen for
   that exact day, and `tools/fixtures/scenarios.json` already distinguishes
   `dateKind: "documented"` from `"representative"`. The proposal is a 10× of a pattern that
   exists, is tested, and is documented in the realism roadmap.
2. **Scenario content is written once and appears in all three builds.** Scenarios are plain
   `ScenarioConfig` data consumed through `catalog.ts` → `registry.ts`. The per-build
   difference is *rendering* only (`scenarioBuildingLayers.{mobile,windows,target}.ts`), and
   the roadmap's §2 already commits to identical simulation fidelity across builds. There is
   no per-build scenario authoring cost.
3. **Real dates unlock real data at zero runtime cost.** Every disaster below has an exact
   date and place, so `npm run fixtures` can freeze genuinely observed ERA5 weather, real FAA
   UASFM ceilings, real USGS terrain, and real Overture footprints for each one. The
   determinism rule (§3 of the roadmap: fetch at authoring time, never at runtime) is
   untouched.

The honest counterweight: **the catalog grows 21 → 31 (+48%)**, and much of what the catalog
"knows" about a scenario is inferred by regex over its name and description. Those regexes were
written for police, border, and fire vocabulary. Ten civil-disaster scenarios will silently
mislabel unless that inference layer is generalised *first*.

---

## Part I — What is actually built today

### 1.1 Scenario shape

`ScenarioConfig` (`src/types/index.ts:641`) is a plain data object: id, seed, drone count,
per-drone waypoints, geofences, heat sources, battery model, comms-loss windows, sorties,
platform assignments. The 14 "extreme" scenarios are hand-authored TS literals in
`src/scenarios/extremeScenarios.ts` (1,216 lines ≈ **85 lines per scenario**).

### 1.2 What is authored vs. what is derived — the load-bearing detail

`enhanceScenarioForOperations` (`src/scenarios/catalog.ts:58`) runs at module-eval time and
**derives** the entire briefing layer from the scenario's free text:

| Derived artifact | Derived how | Risk for disaster scenarios |
|---|---|---|
| `missionBrief.agencies` | regex over a fixed `KNOWN_AGENCIES` list (`catalog.ts:39`) | **NWS, NTSB, EPA, USGS, NCEM, MDTA, county SO, Cajun Navy are all absent.** Falls back to `'UAS OPERATIONS'`. |
| `missionClassFor` | keyword scan → SAR / pursuit / wildfire / hazmat / perimeter | **No branch for flood, structural collapse, tornado, volcanic, landslide, derailment.** |
| `primaryObjectiveFor` | switch on mission class | Falls to a generic string for every new hazard family. |
| `featureTypeFor` | keyword → bridge / shoreline / fireline / perimeter / street | Same gap. |
| `localDispatchSourcesFor`, `supportDispatchSourceFor`, `leadFieldUnitFor` | keyword | Same gap. |
| `launchSites` / `recoverySites` / assignments | geometric derivation + `isCityScenario` | Works, but `isCityScenario` is a hard-coded city list (Oakland/Hollywood/Times Square/SF/Seattle). New cities need adding or the metadata test's "no generic/water launch labels in cities" rule won't apply where it should. |
| `missionObjectives` | **not authored by any of the 21 scenarios** — all use `resolveMissionObjectives`'s deterministic fallback (`missionObjectives.ts:49`) | Opportunity: disaster scenarios are the first good reason to author objectives explicitly. |
| `weatherProfile` | `deriveWeatherProfile`, perturbed around the frozen observed baseline | Works as-is. |

**Conclusion: adding a scenario is not just adding a literal.** Half its briefing is produced by
inference tuned to the existing vocabulary. This is the single biggest hidden cost and the
thing to fix before authoring, not after.

### 1.3 Fixture pipeline (the asset that makes this proposal strong)

`tools/fixtures/` — a dev-time CLI, not part of any build — with fetchers for Open-Meteo ERA5
(`openMeteo.mjs`), FAA UAS Facility Maps (`faaUasfm.mjs`), USGS terrain (`terrain.mjs`), and
Overture buildings (`buildings.mjs`), driven by `scenarios.json` and frozen to
`src/scenarios/fixtures/<id>/` with a provenance manifest (source URL, date, licence, SHA-256).

Current coverage: **weather 15/21**, **airspace 10/21**, **terrain 1/21**, **buildings 1/21**
(both `demo_wildfire` only).

### 1.4 Constraints new scenarios must satisfy

- `ALL_SCENARIOS` length is asserted as **`21` in six spec files**
  (`doctrineAssignment`, `missionAssessment`, `missionObjectives`, `observedWeather`,
  `routeAudit`, `scenarioMetadata`). Every one becomes `31`.
- `scenarioMetadata.spec.ts` requires, per scenario: ≥1 agency, `"SIMULATION ONLY"` in the
  command intent, ≥3 dispatch entries, ≥3 operational features, and per drone a role, a
  recovery plan containing `"RTB"`, and explicit launch + recovery sites with
  label/agency/surfaceNote/exposure. City scenarios additionally must launch from
  rooftop/police_rooftop/mobile_command with non-generic, non-water labels.
- `scenarioBounds`, `scenarioRouteSanity`, `scenarioVariant`, `routeAudit`, `airspaceCeilings`,
  `observedWeather` all iterate the whole catalog — new scenarios are auto-covered, and will
  auto-fail if geometry is sloppy.
- **Determinism** (per project memory: no persistent RNG state, no snapshot files) — a new
  scenario only needs a unique `seed`. Safe. Reserve `seed: 30001–30010`.
- **Bundle budget.** Terrain fixtures are inlined base64 (~387 KB of module text each). Ten
  terrain fixtures ≈ 4 MB. This must be rationed, and matters most for the mobile build and
  the separate classroom Vercel client.

---

## Part II — Research: the ten disasters

Selection criteria: (1) US, (2) real and well documented, (3) an *identifiable drone decision*
the operator can make, (4) hazard-family diversity, (5) at least half with a documented real
drone response to backtest against, and the rest genuine counterfactuals.

### Tier A — drones were actually used (backtest against a documented outcome)

**1. Kīlauea lower East Rift Zone — Leilani Estates, Hawai'i · 2018-05-27**
DOI/USGS UAS team spotted a fast-moving pāhoehoe breakout heading north down Luana Street,
then flew a drone to a trapped resident who followed it out on foot, signalling with a phone
flashlight. Live video fed the county EOC for evacuation decisions.
*Teaches:* single-aircraft precision guidance, night ops, lava-front tracking as a moving
geofence. *Best documented micro-success in the set — an exact outcome to score against.*

**2. Oso / SR-530 landslide, Washington · 2014-03-22**
CRASAR deployed three sUAS; the AirRobot AR100B covered 30–40 acres from 140 ft in 48 minutes
and produced 2D/3D reconstructions in ~3 h on a field laptop, letting geologists judge the
risk of a second slide *to the responders themselves*. Deadliest US landslide on record.
*Teaches:* responder-safety hazard monitoring, endurance-vs-area budgeting, terrain occlusion
in a debris field. **Directly exercises the WP-4 occlusion service.**

**3. Hurricane Harvey — Houston / Buffalo Bayou, Texas · 2017-08-28**
The turning point for FAA UAS policy: 43 authorizations by 31 Aug, 137 by mid-September, all
under active TFRs alongside manned rescue helicopters.
*Teaches:* **airspace deconfliction under a TFR while manned rescue is airborne** — the single
best fit for the existing UTM/compliance engine and the LAANC/authorization surface.

**4. Camp Fire — Paradise, California · 2018-11-08 (evac) / 2018-11-12+ (mapping)**
518 mapping flights by 16 agencies, 70,000 images over 17,000 acres, 1.4 trillion pixels —
believed the largest coordinated drone disaster response in US history at the time. 85 dead,
18,000+ structures.
*Teaches:* two distinct phases — day-of evacuation-corridor overwatch (Skyway gridlock) vs.
systematic post-fire grid mapping. *Reuses the existing wildfire terrain/thermal work most
directly.*

**5. Champlain Towers South collapse — Surfside, Florida · 2021-06-24**
300+ flights across nine drone models over the 24 Jun – 7 Jul response phase; FSU's DIRT team
produced orthomosaics **every 2–4 hours** in daylight for the first two weeks; a TFR was
requested immediately and drone/FAA coordination ran through an MDFR-managed channel.
*Teaches:* multi-operator deconfliction over one small site, structured revisit cadence,
void-space thermal search. **Only scenario in the set needing building footprints.**

**6. Hurricane Helene — Asheville / Swannanoa, North Carolina · 2024-09-27 →**
Asheville PD flew a thermal Mavic 3M for night SAR into terrain ground teams could not reach;
cellular, fiber, and radio all failed, leaving SD cards as the only data path; private and
agricultural heavy-lift operators delivered food, water, medicine, and formula to cut-off
communities.
*Teaches:* **total comms denial and relay placement** — this scenario is almost a written
specification for the existing `commsLossWindows`, relay-drone, and recharge-station
mechanics, plus mountain terrain masking.

### Tier B — counterfactual (no meaningful drone capability existed; the operator supplies it)

**7. Hurricane Katrina — 17th Street Canal breach / Lower Ninth Ward, New Orleans · 2005-08-29**
Levee breach characterisation and rooftop survivor triage took days across a flooded city with
collapsed comms.
*Teaches:* large-area triage prioritisation under a hard endurance budget; the operator
discovers that *coverage rate*, not sensor quality, is the binding constraint. The most
emotionally weighty entry — handle per §4.4.

**8. Joplin EF-5 tornado, Missouri · 2011-05-22**
161 fatalities, ~7,500 residences and 553 businesses damaged along a defined damage path; NIST
ran a full technical investigation (SP-1139).
*Teaches:* damage-path grid search with a linear AO, structured sector assignment, and
triage-by-damage-severity. Good `sector_coverage` / POD scenario.

**9. Marshall Fire — Boulder County, Colorado · 2021-12-30**
A wind-driven urban conflagration in which the wind itself largely precluded flight.
*Teaches:* **the limits.** The correct operator answer is partly "don't launch." Mirrors the
Fort Myers/Ian precedent, where documented ERA5 winds correctly ground the fleet and the
refusal *is* the realism.

**10. East Palestine derailment, Ohio · 2023-02-03**
Vinyl chloride release and the vent-and-burn decision; EPA ran daily drone mapping and used
drones/robots to survey culverts through the long tail of the response.
*Teaches:* hazmat plume standoff, evacuation-radius support, persistent monitoring across
days. Complements the existing `extreme_dhs_port_la_chemical` without duplicating it.

**Alternates considered and held in reserve:** Lahaina/Maui (2023-08-08), Baltimore Key Bridge
(2024-03-26, drones + underwater assets, strong but narrow), Hurricane Maria/Puerto Rico
(2017), Moore OK tornado (2013), Winter Storm Uri (2021), Iowa derecho (2020).

### 2.1 Portfolio coverage this adds

The existing 21 skew heavily to law enforcement and border operations. These 10 add six hazard
families the catalog has none of — flood/swiftwater, structural collapse, tornado, volcanic,
landslide, rail hazmat — and shift the centre of gravity toward civil disaster response, which
is where the drone-industry story actually is.

---

## Part III — Design decisions that must be made before authoring

### 3.1 The T+N convention (blocking, decide first)

Fort Myers/Ian established that **real weather on the real day can correctly ground the
fleet.** That lesson is valuable exactly once. Katrina landfall, Marshall Fire peak, and Helene
peak would all reproduce it.

**Recommendation:** every scenario pins *the response window*, not the peak — an explicit
`T+N hours` offset from the event, recorded in `scenarios.json` alongside `realDate`, with the
frozen ERA5 hour matching that offset. Marshall Fire is the deliberate exception: it keeps
peak-wind conditions *because teaching the no-launch decision is its whole point.* Document
this in the fixture manifest so a response-window date is never mistaken for a landfall date.

### 3.2 The debrief layer (this is the actual feature)

Nothing in the current model carries *what really happened*. A new optional field —
`historicalCase?: HistoricalCase` on `ScenarioConfig` — would carry:

- the real event: date, place, human cost, one-paragraph situation;
- the real timeline (what was known when, and how long it took);
- the capability gap: what the responders did not have;
- the documented drone contribution, where there was one, with numbers (Camp Fire's 518
  flights, Surfside's 2–4 h orthomosaic cadence, Oso's 30–40 acres in 48 min);
- **sources with URLs** — non-negotiable for a portfolio project making historical claims;
- **backtest anchors**: 2–4 measurable figures the operator's run is scored against (area
  mapped per hour, time-to-first-contact, sector POD at T+2 h, fraction of the damage path
  covered before dark).

Then one debrief surface per shell, reusing the existing after-action/scorecard components
(`missionScorecard`, `afterActionSnapshot`, `missionAssessment`) rather than inventing a new
one. In the classroom build this becomes the instructor's discussion artifact.

**Without this layer the scenarios are just 10 more missions with sadder names.** With it,
they are the differentiating feature of the whole project.

### 3.3 Fixture rationing

| Fixture | Scope | Rationale |
|---|---|---|
| Weather (ERA5) | **all 10** | Cheap, small, and the entire "real day" claim rests on it. Takes weather coverage 15/21 → 25/31. |
| Airspace (FAA UASFM) | wherever published — expect ~5–6 | Houston, Baltimore-class urban AOs are covered; Oso/Paradise likely are not. "No published ceiling" is already a valid answer in `observedAirspace.ts`. |
| Terrain (USGS) | **3 only — Oso, Helene/Swannanoa, Camp Fire** | Terrain is load-bearing in exactly these three; ~387 KB each inlined. Anything more needs dynamic import first. |
| Buildings (Overture) | **1–2 — Surfside, possibly Joplin** | Surfside is meaningless without footprints; nothing else in the set needs them. |

### 3.4 Doctrine for depicting real disasters (write this down before authoring)

These are events in which real, named people died. Proposed rules, to sit in the plan doc and
be enforced by a spec:

- No real victim names, no synthetic casualties placed at real residential addresses.
- Heat sources stay generic classes, as they already are (`generic-person`, `vehicle`).
- `"SIMULATION ONLY"` stays mandatory in every command intent (already enforced).
- Every historical claim in a `historicalCase` carries a source URL.
- Framing is *capability analysis*, never "how the responders failed" — the after-action
  literature is the source, and it is about missing capability, not blame.

---

## Part IV — Execution plan

Dependency-ordered, in the roadmap's WP style. Nothing here is code yet.

**WP-D0 · Guardrails and shape** — write the doctrine of §3.4; add the `HistoricalCase` type;
replace the six hard-coded `toHaveLength(21)` assertions with a derived expectation plus one
explicit catalog-manifest test, so the count stops being a merge conflict in six files.

**WP-D1 · Generalise the derivation layer** *(do this before authoring anything)* — extend
`KNOWN_AGENCIES`, `missionClassFor`, `primaryObjectiveFor`, `featureTypeFor`,
`localDispatchSourcesFor`, `supportDispatchSourceFor`, `leadFieldUnitFor`, and
`isCityScenario` to cover the six new hazard families and the new agencies/cities. Add a spec
that asserts **no scenario falls through to a generic fallback** — the current failure mode is
silent, and this is what makes it loud.

**WP-D2 · Fixture pass** — add 10 entries to `tools/fixtures/scenarios.json` with `realDate`,
`dateKind: "documented"`, the §3.1 response-window offset, and AO bboxes; run `npm run
fixtures`; verify each frozen result is launchable (or deliberately not, for Marshall Fire).
*This is the step that must run in an environment with network egress.*

**WP-D3–D5 · Authoring, in three batches** — sequenced so each batch validates something
different before the next starts:

- *Batch 1 (proof):* Kīlauea, Surfside, Helene — one precision-guidance, one collapse, one
  comms-denied. Covers the widest span of new mechanics with the fewest scenarios. **Stop and
  review after this batch.**
- *Batch 2:* Camp Fire, Harvey, Oso, Marshall Fire.
- *Batch 3:* Katrina, Joplin, East Palestine.

New file `src/scenarios/historicalScenarios.ts`, exporting `HISTORICAL_SCENARIOS`, spread into
`RAW_SCENARIOS` — mirroring how `EXTREME_SCENARIOS` is wired, and keeping
`extremeScenarios.ts` from becoming a 2,100-line file.

**WP-D6 · Debrief / backtest surface** — the §3.2 feature, across all three shells, reusing the
existing scorecard components.

**WP-D7 · Terrain + buildings** — the rationed set from §3.3, plus a decision on dynamic import
if the bundle budget bites.

**WP-D8 · Classroom instructor pack** — per-scenario facilitation notes, discussion prompts,
and a comparison table for the coordinator build. These scenarios are the strongest classroom
content the project will have.

### 4.1 Scope, stated honestly

| Work | Weight | Notes |
|---|---|---|
| WP-D0 | small | Mechanical. |
| WP-D1 | **medium-large** | The under-appreciated one. Touches the file every scenario depends on, and every existing scenario re-derives through it — regression risk across all 21. |
| WP-D2 | medium | Mostly waiting on fetches; needs network egress. |
| WP-D3–D5 | **large** | ~85 lines of authored geometry per scenario × 10, plus per-scenario research to get waypoints onto real streets and real terrain. This is careful work, not bulk work. |
| WP-D6 | **large** | A genuine new feature: type, module, three shell surfaces, scoring, tests. |
| WP-D7 | medium | Bundle-budget decision may force a dynamic-import refactor. |
| WP-D8 | small-medium | Documentation and one comparison view. |

**Scope-reduction option, and the one I'd recommend if the whole set looks too big:** ship
**Batch 1 (Kīlauea, Surfside, Helene) plus WP-D0/D1/D2/D6** as a complete vertical slice —
three scenarios *with* a working debrief layer. That proves the concept end to end and is
worth far more than ten scenarios with no debrief. The remaining seven then become pure
authoring against a proven pattern.

### 4.2 Principal risks

1. **Silent mislabeling from the regex derivation layer** — mitigated by WP-D1's no-fallback
   spec. This is the highest-probability failure and the cheapest to prevent.
2. **Bundle growth in the mobile and classroom clients** — mitigated by §3.3 rationing.
3. **Weather that grounds the fleet where it shouldn't** — mitigated by §3.1's T+N convention.
4. **Tone and accuracy on real fatal events** — mitigated by §3.4 doctrine + mandatory sources.
5. **Catalog-wide test churn** — 21 → 31 touches six spec files at minimum; WP-D0 first.
6. **Route-geometry realism** — waypoints must sit on real streets, real ridgelines, real
   riverbanks. `scenarioRouteSanity` and `routeAudit` catch geometric nonsense but not
   *geographic* nonsense. Budget real map time per scenario.

---

## Sources

- [Champlain Towers South Collapse — NIST](https://www.nist.gov/disaster-and-failure-studies/champlain-towers-south-collapse)
- [Champlain Towers South Collapse: Drones' Value Soars — Firehouse](https://www.firehouse.com/technology/drones/article/21260858/fire-technology-champlain-towers-south-collapse-drones-value-soars)
- [Drones Flew Night And Day To Survey Surfside Condo Collapse — DroneXL](https://dronexl.co/2021/08/10/drones-survey-surfside-condo-collapse/)
- [Mapping "Camp Fire" with drones, lessons learnt — sUAS News](https://www.suasnews.com/2019/01/mapping-camp-fire-with-drones-lessons-learnt/)
- [How a Squadron of Drones Mapped the Entire Paradise Camp Fire Zone in Two Days — NBC Bay Area](https://www.nbcbayarea.com/news/local/how-a-squadron-of-drones-mapped-the-entire-paradise-camp-fire-zone-in-two-days/201896/)
- [Drone Authorizations Soar Through Hurricanes, Wildfires — FAA](https://medium.com/faa/drone-authorizations-soar-through-hurricanes-wildfires-8548ea4a2c75)
- [Flying into the hurricane: UAV use in damage assessment during the 2017 hurricanes — PLOS One](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0227808)
- [Lessons from Hurricane Helene: How UAVs Supported Emergency Response in Western North Carolina — DroneLife](https://dronelife.com/2025/03/11/lessons-from-hurricane-helene-how-uavs-supported-emergency-response-in-western-north-carolina/)
- [Private Drone Operators Rescue Ops Hurricane Helene — DroneLife](https://dronelife.com/2024/10/11/private-drone-operators-deliver-aid-after-hurricane-helene/)
- [Use of a Small Unmanned Aerial System for the SR-530 Mudslide Incident near Oso, Washington — Murphy et al., Journal of Field Robotics](https://onlinelibrary.wiley.com/doi/abs/10.1002/rob.21586)
- [Five Years Later — The Oso (SR 530) Landslide in Washington — USGS](https://www.usgs.gov/news/featured-story/five-years-later-oso-sr-530-landslide-washington)
- [Kīlauea Volcano — UAS Mission Aid in Rescue — USGS](https://www.usgs.gov/media/videos/kilauea-volcano-uas-mission-aid-rescue)
- [How the USGS Used a Drone to Save Someone from Kīlauea's Lava — Discover](https://www.discovermagazine.com/the-sciences/how-the-usgs-used-a-drone-to-save-someone-from-klaueas-lava)
- [NIST Technical Investigation of the May 22, 2011 Joplin, Missouri Tornado (SP-1139)](https://nvlpubs.nist.gov/nistpubs/specialpublications/nist.sp.1139.pdf)
- [East Palestine Train Derailment Response — Operational Updates — US EPA](https://www.epa.gov/east-palestine-oh-train-derailment/operational-updates)
- [Drones Deployed for Baltimore Bridge Collapse Search and Rescue — Commercial UAV News](https://www.commercialuavnews.com/public-safety/drones-deployed-for-baltimore-bridge-collapse-search-and-rescue-and-data-collection)
