# Portfolio & Investor-Readiness Audit — Autonomous Drone Mission Simulator

**Audit date:** 2026-07-02 · **Version audited:** v1.0.0 (commit `68da937` + uncommitted README/media working-tree changes)
**Method:** Full source read of all architecturally central modules, independent re-run of the verification suite (`tsc -b`, `eslint src`, `vitest run`, `vite build`, `npm audit`), and a live end-to-end walkthrough of the README "Investor Demo Script" in a running instance (scenario load → preflight → launch bays → mission → retask → thermal dispatch → replay → after-action export), including live execution of the shipped chain verifier against a real mission's event log.

Findings are tagged **[PORTFOLIO]** (hiring-manager lens), **[INVESTOR]** (dual-use seed-fund lens), or both, with severity and `file:line` evidence.

---

## 1. Executive Summary

**Portfolio verdict.** This is a top-decile portfolio project by volume, scope, and polish — a working 21-scenario multi-drone operations simulator with a real deterministic sim kernel, a geofence-aware route planner that runs Dijkstra over detour graphs, schema-versioned persistence with full runtime validation of untrusted input, 178 passing tests, and an unusually disciplined honesty layer (simulation disclaimers in the UI, exports, and marketing manifest). But it does not yet survive a staff-level interview at its own headline claims: the chain-of-custody hash chain — the project's flagship "evidence integrity" feature — **fails its own shipped verifier on an ordinary demo run** (verified live in this audit: `verifyChain()` returned `false` after 29 events), that verifier is dead code never called anywhere, the Launch Bay Planner's assignments are silently disconnected from the simulation, and there is not a single test that renders a component or exercises the production simulation loop. The gap between "impressive demo" and "defensible craft" is concentrated in about six findable defects; fixing them is one to two weeks of work and would change the interview outcome materially.

**Investor verdict.** As evidence of founder execution — velocity, product sense, ability to ship a coherent, demoable, honestly-labeled artifact solo — this is a genuinely positive signal. As evidence toward a fundable company, it is weak on its own, and no amount of polish on this repo changes that: there is no technical moat (a competent two-person team could rebuild the simulator's core in weeks; the parts that are hard — hardware, agency trust, CJIS-grade evidence handling, real FAA/UTM integration, certification — are all ahead of you and unrepresented here), the DFR market is already occupied by heavily-funded incumbents (Skydio, Flock Safety/Aerodome, BRINC, Axon, Motorola), and the in-app "investor ROI" panel fabricates a "TIME SAVED" metric from an arithmetic formula, which is precisely the kind of thing that detonates diligence trust — ironically violating the spirit of the project's own excellent `launch_claims.json` banned-claims list. The credible investor story is not "this is the product"; it is "this is what I build in N weeks alone — and here is the wedge (most plausibly: mission rehearsal/training and after-action tooling for DFR programs, a real and underserved niche) I'd attack with funding."

---

## 2. Scorecard

| Dimension | Score | One-line justification |
|---|---:|---|
| Engineering craftsmanship | **6.5/10** | Real architecture (deterministic kernel, sim/render decoupling, validated persistence, route planner) dragged down by a broken flagship invariant, dead code, unselected 20 Hz store subscriptions, and zero UI/integration test coverage. |
| Domain credibility | **6/10** | Far above cosplay — altitude-band deconfliction, reserve-based RTB, sortie/recharge relay logic, honest LAANC/Remote ID framing — but pressure-testing exposes decorative seams: Remote ID conflated with C2 link, checklist contradicts actual lost-link behavior, deconfliction never acts, regex-generated ops text leaks into the operator UI. |
| Product/UX completeness | **7/10** | The golden path demonstrably works end to end with zero console errors (verified live), replay and exports are real; friction is real too — map occlusion at narrow widths, verbose generated labels, a suggestion engine that can silently degrade the search plan. |
| Investor narrative strength | **4/10** | Strong demo mechanics and claims discipline, but a fabricated ROI KPI on the "READY" panel, no articulated wedge/market, and nothing that answers "why is this a company and not a feature of Skydio's stack?" |
| Presentation/packaging | **6.5/10** | Hero GIF + 8 workflow screenshots + honest Known Limitations is top-decile README work; undermined by no LICENSE in the repo, a 4 MB unignored GTM kit sitting one `git add -A` from publication, and zero architecture/engineering narrative for the technical reviewer. |

---

## 3. Critical Findings

### C1. The chain-of-custody hash chain is broken in practice — and never verified [PORTFOLIO][INVESTOR] — **Critical**

The single most-marketed technical property of this project ("chain-of-custody," "evidence export," SHA-256 hash chain) does not hold at runtime.

- **Mechanism:** `buildEvent()` is async (`crypto.subtle.digest`, [chainOfCustody.ts:6-35](../src/utils/chainOfCustody.ts)). Every emission site captures `prevHash` synchronously via `useDroneStore.getState().lastHash` and appends the event later in a `.then()` — e.g. [SimulationLoop.ts:157](../src/sim/SimulationLoop.ts), :218, :271-279, :288, :303, :319, :335, :370, :379, :398, :427, and `recordOperatorCommand` at [droneStore.ts:191-197](../src/store/droneStore.ts). All events created within one synchronous tick pass (guaranteed multiple per pass at 5×/10× speed, common at 1×) capture the **same** `prevHash`, so the chain forks.
- **Live proof (this audit):** after ~3 minutes of the flagship `demo_sar_coastal` scenario, the store held 29 events with **2 duplicate `prevHash` values**, and the shipped `verifyChain(events)` returned **`false`**. Any recipient of the exported JSONL custody log who runs the verifier will conclude the log was tampered with or the implementation is wrong.
- **Compounding:** `verifyChain` ([chainOfCustody.ts:42](../src/utils/chainOfCustody.ts:42)) is **never called anywhere** — not in the UI, not in a single test (grep: one hit, the definition). Meanwhile the event log UI renders a green `✓` next to every event hash ([TelemetryPanel.tsx:456](../src/components/TelemetryPanel.tsx:456)), implying verification that never happens.
- **Failure scenario:** an investor's technical advisor (or interview panel) exports the custody log, writes ten lines of verification code — or finds `verifyChain` in the repo — and the project's central integrity claim collapses. This is worse than not having the feature.
- **Fix (effort M):** serialize event creation through a single promise queue (`chain = chain.then(() => buildEvent(...))`) or hash synchronously (e.g., a small sync SHA-256, or compute hashes in insertion order inside `addEvent`); then (a) call `verifyChain` in a vitest integration test that runs the *production* loop, (b) verify on export and stamp the result into the file, (c) make the UI `✓` real.

### C2. The in-app investor panel fabricates an ROI metric [INVESTOR] — **Critical**

`responseTimeSavedMin = max(1, detections×3 + groundDispatches×2 + coverage/25)` ([missionOutcome.ts:36](../src/sim/demo/missionOutcome.ts:36)) is displayed as **"TIME SAVED: 5.3 min"** on the READY tab ([TelemetryPanel.tsx:397](../src/components/TelemetryPanel.tsx:397)) and embedded in the exported after-action package. It is not derived from any model — it is arithmetic dressed as an outcome. `routeRiskReductionPct = 100 − breaches×35 − conflicts×8` ([missionOutcome.ts:27](../src/sim/demo/missionOutcome.ts:27)) has the same problem (and in the live run it clamped to 0%, which also *reads* terribly). Your own `launch_claims.json` bans "benchmark metrics" ([outputs/launch/.../launch_claims.json:14](../outputs/launch/autonomous-drone-simulator/manifests/launch_claims.json)); the app violates that rule on-screen. In diligence, one invented number contaminates every real one.
**Fix (effort S):** delete "TIME SAVED" or relabel the whole block as "simulated illustrative KPIs (formula-based)" with the formula shown; keep only measurable quantities (coverage %, contacts, events, distance).

---

## 4. High-Priority Findings

### H1. Launch Bay Planner assignments are a dead wire [PORTFOLIO] — **High**
The planner stores assignments keyed by drone/site ids like `uav-01` ([LaunchBayPlanner.tsx:15-21](../src/components/LaunchBayPlanner.tsx:15)), but `initFleet` resolves them by matching `` `site-${index}` `` against `Object.values(scenario.launchSites)` ([SimulationLoop.ts:514-517](../src/sim/SimulationLoop.ts:514)) — a pattern that can never match. Every reassignment silently falls back to the drone's default site. The gate ("BAY PLAN REQUIRED") works; the planning doesn't. *Failure scenario:* a demo viewer says "put UAV-01 on the other pad," you do, and nothing changes. Also `capacityDrones: 2` is hardcoded ([LaunchBayPlanner.tsx:30](../src/components/LaunchBayPlanner.tsx:30)). **Fix (S/M):** key sites consistently (use the launchSites record keys end-to-end) and add a test asserting spawn position follows assignment.

### H2. The sim clock is a wall-clock hostage [PORTFOLIO] — **High**
The loop is `setInterval(tick, 50)` with `stepsPerFrame = simSpeed` ([SimulationLoop.ts:41-47, 486-489](../src/sim/SimulationLoop.ts:486)) — no drift correction, no accumulator. **Measured live:** in a hidden tab the browser throttled the interval and the sim advanced **45 ticks in 5 s at 5× speed (expected 500)** — an 11× silent slowdown; "T+" time diverges from wall time with no indication. Any backgrounded demo tab, laptop sleep, or heavy GC does this. Physics itself stays fixed-step (good), but pacing and event timestamps (`Date.now()` in [chainOfCustody.ts:26](../src/utils/chainOfCustody.ts:26)) are wall-clock contaminated. **Fix (M):** drive steps from an accumulator over `performance.now()` deltas (cap catch-up), or a Worker-based timer; derive event timestamps from sim time.

### H3. The determinism test doesn't test the production loop — and nothing tests the UI [PORTFOLIO] — **High**
[determinism.spec.ts:33-83](../src/tests/determinism.spec.ts:33) re-implements a *simplified* headless loop (no weather, comms, safety passes, recovery, or event emission) and proves *that* is deterministic. The production `tick()` in SimulationLoop.ts — with its async event races (C1), `Date.now()` ids ([droneStore.ts:412](../src/store/droneStore.ts:412)), and store-order dependencies — is imported by **zero** tests (grep: only the spec's own kernel imports). Additionally: `environment: 'node'`, no jsdom, no @testing-library — 0 of 178 tests render a component; TacticalMap (1,057 lines, the most complex module) is untested; there are no error-boundary tests (and no error boundary — a render throw white-screens the app). The 178 tests that exist are genuinely good unit tests (public-API level, injectable storage, in-memory stubs) — the gap is the layer above. *Interview question you will get:* "your determinism test tests a copy of the sim — why?" **Fix (L):** one SimulationLoop integration test with fake timers asserting (a) chain verifies, (b) two runs at same seed produce identical replay frames; plus a handful of component smoke tests and an error boundary.

### H4. Every panel subscribes to the entire store at 20 Hz [PORTFOLIO] — **High**
`const { ... } = useDroneStore()` with no selector in App ([App.tsx:16](../src/App.tsx:16)), TacticalMap ([TacticalMap.tsx:100](../src/components/TacticalMap.tsx:100)), FleetPanel, TelemetryPanel, ControlBar, OperatorCommandPanel, MissionStatusFeed. `incrementTick()` fires 20-200×/s, so the entire React tree re-renders at tick rate; TelemetryPanel additionally rebuilds outcome/compliance/UTM objects every render regardless of active tab ([TelemetryPanel.tsx:91-100](../src/components/TelemetryPanel.tsx:91)), and TacticalMap's `useMemo` on `elapsedSec` recomputes UTM state every tick ([TacticalMap.tsx:110](../src/components/TacticalMap.tsx:110)). The irony: TacticalMap contains a genuinely sophisticated ref/rAF/10-fps-interval architecture to avoid exactly this class of problem ([TacticalMap.tsx:102-185](../src/components/TacticalMap.tsx:102)) — then opts out of Zustand's selector mechanism one line above it. It works because the DOM is small, but it's the first thing a React-literate reviewer will flag. **Fix (M):** selectors (`useDroneStore(s => s.drones)`) or `useShallow`; split the header clock into its own subscriber.

### H5. Repo has no LICENSE, and the 4 MB GTM kit is one command from being published [PORTFOLIO][INVESTOR] — **High**
- No `LICENSE` at repo root — while the Windows zip ships a **proprietary** license ([outputs/windows-release/staging/.../LICENSE.txt](../outputs/windows-release/staging/autonomous-drone-simulator-v1.0.0-windows/LICENSE.txt)). Legally "all rights reserved" either way, but a recruiter/associate reads "unfinished hygiene," and the proprietary/confidential framing sits oddly on a public portfolio repo.
- `outputs/` (~4 MB: pitch SVGs, Remotion scaffold, launch brief, **three** copies of the production bundle across `staging/`, `verify-extract/`, and the zip) is untracked but **not** in `.gitignore` — `git status` shows it as `??`. One `git add -A` publishes your internal marketing kit and stale `server.pid`/`server-url.txt` runtime droppings into the portfolio repo.
**Fix (S):** add a LICENSE (even "source-available, all rights reserved" stated explicitly), add `outputs/` to `.gitignore`, move the GTM kit to a sibling private folder.

### H6. Domain seams a DFR practitioner will catch [PORTFOLIO][INVESTOR] — **High (credibility)**
1. **Remote ID conflated with the C2 link:** Remote ID status is derived from `signalDbm` ([complianceEngine.ts:20-25](../src/sim/demo/complianceEngine.ts:20)); in reality Remote ID broadcast is an independent onboard transmitter — losing C2 doesn't degrade it. Live run showed "REMOTE ID: DEGRADED" purely because the marine-layer comms window opened.
2. **Preflight checklist contradicts the sim's own lost-link behavior:** checklist asserts "Lost-link procedure confirmed: RTB at 30s" ([PreflightChecklist.tsx:14](../src/components/PreflightChecklist.tsx:14)); the sim deliberately keeps comms-lost drones on task ([SimulationLoop.ts:254-257](../src/sim/SimulationLoop.ts:254) — a defensible, even modern, choice) and recovery only triggers via the emergency path ([recoveryManager.ts:33-37](../src/sim/mission/recoveryManager.ts:33)). Pick one doctrine and make the artifacts agree.
3. **Deconfliction detects but never acts:** the `avoid` state exists ([types/index.ts:26](../src/types/index.ts:26), [MissionManager.ts:142](../src/sim/mission/MissionManager.ts:142)) but nothing ever transitions into it — conflicts only set a flag and increment a counter (25 "conflicts detected" accumulated in the live run with zero responses). `obstacle_detected`/`avoidance_start`/`avoidance_complete` event types are dead vocabulary.
4. **Thermal model is decorative at the edges:** 60 m max range decaying to zero above ~250 ft ([ThermalSim.ts:6-17](../src/sim/sensors/ThermalSim.ts:6)) is wildly conservative vs. real radiometric payloads (person detection at hundreds of meters from 400 ft), and detections return the target's exact ground-truth position with no localization error. The IR overlay renders every heat source at a fixed `top:50%/left:50%` of the screen — not geolocated ([TacticalMap.tsx:925-933](../src/components/TacticalMap.tsx:925)).
5. **Ground units and recovery teams fly as the crow flies** at fixed speed over water/buildings ([groundUnits.ts:22-29](../src/sim/mission/groundUnits.ts:22)) — ETAs are fiction in urban scenarios.
6. **Regex-derived ops content leaks into the operator UI:** the SAR primary-sector drone's route brief reads "High standoff relay hold with short reposition legs" because `routePatternFor` matched the word "relay" in the scenario *description* ([catalog.ts:498-506](../src/scenarios/catalog.ts:498)); launch-site labels render as "…vessel command launch deck (SAR — COASTAL); **Explicit simulated** vessel deck launch surface…" — template filler visible to the evaluator ([catalog.ts:169-176](../src/scenarios/catalog.ts:169)).
**Fix (S each):** decouple Remote ID from C2; align checklist text with behavior; either implement a minimal avoid maneuver or remove the state/events; label thermal model assumptions; rewrite generated label templates for brevity.

### H7. `npm audit` has drifted from "clean" [PORTFOLIO] — **High (claims-drift), Low (actual risk)**
Fresh run: **5 vulnerabilities (3 moderate, 1 high, 1 critical)** — all confined to the dev toolchain: esbuild ≤0.24.2 (GHSA-67mh-4wv8-2f99), vite ≤6.4.2 (path traversal GHSA-4w7w-66w2-5vf9, Windows NTLMv2 UNC GHSA-v6wh-96g9-6wx3, `fs.deny` bypass), vitest ≤3.2.5 (GHSA-5xrq-8626-4rwp, critical, Vitest UI RCE). Nothing ships in the production bundle. But if any doc or conversation claims "npm audit clean," it is now false. **Fix (M):** upgrade vite 7 / vitest 4 majors; re-run suite.

---

## 5. Medium / Low Findings (quick wins)

| # | Finding | Evidence | Sev | Tag |
|---|---|---|---|---|
| M1 | After-action export during replay scrubbing mixes mid-scrub fleet/thermal state with final metrics/events — live run exported `resolvedContacts: 0` despite a dispatched unit, because `setReplayIndex` overwrites `drones`/`thermalContacts` ([droneStore.ts:337-351](../src/store/droneStore.ts:337)) while ReplayPanel reads them live ([ReplayPanel.tsx:57-78](../src/components/ReplayPanel.tsx:57)) | live repro | Med | P/I |
| M2 | Route suggestion fallback ("Sector sweep refinement") replaced UAV-01's full SAR grid with a 4-waypoint sweep — approval UI shows no diff of what's being discarded ([operatorRoutes.ts:169-179](../src/sim/mission/operatorRoutes.ts:169)) | live repro | Med | P/I |
| M3 | All geofences render identical red fill/dash regardless of `type` or `bypassForMission` ([TacticalMap.tsx:507-512](../src/components/TacticalMap.tsx:507)) — operator can't distinguish an authorized-bypass TFR from an active no-fly; extreme scenarios lean heavily on bypass zones (e.g., "POTUS TFR — USSS Authorized", [extremeScenarios.ts:291](../src/scenarios/extremeScenarios.ts:291)) | code | Med | P |
| M4 | Single 1,613 kB JS chunk (449 kB gzip); Vite warns; no `manualChunks` for maplibre/recharts, no lazy loading | build log | Med | P |
| M5 | Rolling replay buffer silently drops early frames after ~10 min (`MAX_FRAMES` 300 × 2 s/frame), and the comment says "≈5 min" ([droneStore.ts:37](../src/store/droneStore.ts:37)) — long missions replay only the tail with no operator warning | code | Med | P |
| M6 | "MAVLink v2" feed is MAVLink-*shaped* JSON, not wire format (no framing/CRC), and `GLOBAL_POSITION_INT` swaps N/E velocity components (`vx` gets sin·speed = east, MAVLink `vx` is north) ([mavlink.ts:54-55](../src/utils/mavlink.ts:54)) — fine as a display feed, but don't let anyone believe it's protocol-real | code | Med | P/I |
| M7 | KML export interpolates names/labels without XML escaping ([kmlExport.ts:58,144](../src/utils/kmlExport.ts:144)) and flattens each flight path to the drone's *final* altitude (position history stores no altitude, [kmlExport.ts:52-54](../src/utils/kmlExport.ts:52)) | code | Med | P |
| M8 | Biased shuffle `sort(() => rng() - 0.5)` for hazard selection ([weatherEngine.ts:62](../src/sim/weather/weatherEngine.ts:62)) — deterministic in V8 but not spec-guaranteed cross-engine; use Fisher–Yates | code | Low | P |
| M9 | Dead code: `EventBus` exported, never imported ([EventBus.ts:31](../src/sim/comms/EventBus.ts:31)); `createThermalInterventionUnit`/`createRecoveryUnit` unused (store builds units inline); `pointInPolygon` duplicated verbatim in [routeAudit.ts:336-348](../src/sim/mission/routeAudit.ts:336) vs [geometry.ts:59-71](../src/utils/geometry.ts:59) | code | Low | P |
| M10 | Magic sentinel `unit.etaSec === 60` to detect "needs real ETA" ([SimulationLoop.ts:409](../src/sim/SimulationLoop.ts:409)); `gu-${Date.now()}` ids ([droneStore.ts:412](../src/store/droneStore.ts:412)); `setTimeout(50)`/`setTimeout(25)` sequencing hacks in scenario change/demo reset ([ControlBar.tsx:74,96](../src/components/ControlBar.tsx:74)) | code | Low | P |
| M11 | SAR lawnmower rows span the search area's bounding box, so tracks extend outside non-rectangular polygons; row interleaving across drones (0,3,6…) is unusual vs. contiguous sector assignment; no probability-of-detection/sweep-width modeling ([SARPlanner.ts:28-58](../src/sim/mission/SARPlanner.ts:28)) | code | Low | P/I |
| M12 | `nearestStation` is exact-equality match, not nearest ([catalog.ts:231-233](../src/scenarios/catalog.ts:231)) | code | Low | P |
| M13 | In-app demo chapter titled "**AI** Detection Cue" ([demoScript.ts:67](../src/sim/demo/demoScript.ts:67)) — there is no AI/ML anywhere; the only "AI" wording in the project, and it's on the investor demo spine | code | Low→Med for I | I |
| M14 | Preflight checklist is pre-checked theater — no per-item interaction, one click to proceed ([PreflightChecklist.tsx:47-59](../src/components/PreflightChecklist.tsx:47)) | live | Low | P |
| M15 | Map occlusion below ~1300 px width: mission-brief panel + OPS HUB cover most of the tactical map (observed at 800 px); no collapse/dock behavior; fine at 1600×900 | live | Low | P |
| M16 | Windows launcher: solid overall, but 500 responses echo raw exception messages to the client ([Start-DroneSimulator.ps1:137](../outputs/windows-release/staging/autonomous-drone-simulator-v1.0.0-windows/server/Start-DroneSimulator.ps1)) and `verify-extract/` leaks `server.pid`/`server-url.txt` into the shipped tree | code | Low | P |

---

## 6. What's Genuinely Strong (specific, evidenced)

1. **The route-safety pipeline is real engineering.** `planSafePath` runs Dijkstra over buffered geofence-perimeter nodes with sampled segment-clearance checks ([routeAudit.ts:243-286](../src/sim/mission/routeAudit.ts:243)), is wired into *every* route entry point (operator drags, command routes, suggestions, restored drafts), and works live: dragging a waypoint into the surf-zone TFR was rejected with a named, operator-readable reason ("UAV-01 route rejected: Surf Zone / Pelagic TFR (USCG active)"). This is the strongest single "I understand safety interlocks" artifact in the repo.
2. **`waypointPersistence.ts` is how untrusted input should be handled.** Schema version, full structural normalization of every field from localStorage (`normalizeWaypoint` checks types and `Number.isFinite`, [waypointPersistence.ts:246-261](../src/sim/mission/waypointPersistence.ts:246)), injectable `Storage` for tests, and restored routes are re-validated against current safety rules before acceptance ([waypointPersistence.ts:148-167](../src/sim/mission/waypointPersistence.ts:148)). Security-conscious habits, demonstrated.
3. **The sim/render decoupling in TacticalMap shows performance literacy:** 20 Hz physics → refs → 10 fps GeoJSON `setData` interval → 60 fps rAF marker interpolation with DOM-write minimization and cached inner elements ([TacticalMap.tsx:102-185, 331-374](../src/components/TacticalMap.tsx:102)); the map-style fallback (timeout + error → local style, `markMapReady` idempotence) survived a no-network environment flawlessly during this audit.
4. **Claims hygiene is unusually disciplined.** `launch_claims.json` with approved *and banned* claims and a required disclaimer ([manifests/launch_claims.json](../outputs/launch/autonomous-drone-simulator/manifests/launch_claims.json)); "SIMULATION ONLY" stamped in the UI footer, preflight modal, compliance engine (`SIM_DISCLAIMER`, [complianceEngine.ts:17](../src/sim/demo/complianceEngine.ts:17)), UTM coordination-mode string, KML export header, and README Known Limitations. Most solo projects overclaim; this one mostly under-claims — protect that asset (see C2 for the one exception).
5. **The deterministic kernel is clean:** mulberry32 with per-domain seed derivation (`seed ^ tick·1000003 ^ droneId`, [ThermalSim.ts:35](../src/sim/sensors/ThermalSim.ts:35)), fixed 0.05 s timestep, correct spherical geometry ([geometry.ts](../src/utils/geometry.ts)) — and the 178 tests pass, are behavior-level, and include real edge thinking (recharge resume indices, thermal-hold minimum dwell, weather-forced RTB precedence).
6. **Design decisions come with written rationale** — the urban comms floor comment ([weatherEngine.ts:105-119](../src/sim/weather/weatherEngine.ts:105)), the deliberate no-auto-RTB loiter ([MissionManager.ts:96-103](../src/sim/mission/MissionManager.ts:96)), the emergency-timeout grace before recovery dispatch ([recoveryManager.ts:13-18](../src/sim/mission/recoveryManager.ts:13)). This is what reviewers mean by "defensible decisions."
7. **The end-to-end golden path is real, not screenshot-ware.** This audit ran the full README demo script against a live instance: preflight → bays → launch → retask (accepted suggestion logged as `operator_command`, AUTOSAVED) → thermal contact → ground-unit dispatch (ETA computed, unit moved) → weather comms window (predicted in feed, then hit, then restored) → stop → 92-frame replay with working scrub → after-action JSON. Zero console errors the entire session.
8. **The Windows launcher is more careful than it needed to be:** loopback-only binding, GET-only, URL-decode → `GetFullPath` → root-prefix check against traversal ([Start-DroneSimulator.ps1:60-125](../outputs/windows-release/staging/autonomous-drone-simulator-v1.0.0-windows/server/Start-DroneSimulator.ps1)).

---

## 7. The Investor-Objection List (Phase 5) — verbatim, with best answers

**Q1. "What's the moat? A competent team could rebuild this in a weekend — or at most a quarter."**
Honest answer: for the browser simulator itself, they're closer to right than wrong — the sim kernel, map UI, and scenario content are weeks-to-months of replication work with no proprietary data, algorithms, or integrations. The defensible answer is to *agree* and reframe: this repo is not the asset; it's evidence of build velocity and domain product sense. A moat would have to be built from things not in this repo — accumulated agency workflow data, scenario libraries validated by real programs, evidence-handling certification, or integration lock-in. Do not argue "deterministic simulation" is a moat; it isn't.

**Q2. "Skydio, Flock Safety (Aerodome), BRINC, Axon, Motorola, DroneSense, Paladin already own DFR — hardware, dispatch integrations, and agency trust. Where do you wedge?"**
Real gap, be upfront — but there is a credible wedge this repo naturally points at: **mission rehearsal, operator training, and after-action/policy tooling for DFR programs.** Incumbents sell aircraft and live-ops software; none sells a serious simulation/training environment for Part 107/BVLOS operator proficiency, tabletop exercises, waiver-application evidence ("here is our simulated ops envelope"), or vendor-neutral after-action review. That is a smaller market than DFR itself but underserved, procurement-lighter, and this artifact is 60% of a seed demo for it. The alternative framing — "we'll be the ops platform" — puts you head-on against $100M+ war chests and should not be pitched.

**Q3. "Has a single Part 107 pilot, DFR program manager, or public-safety agency touched this? The scenarios name SFPD/OPD/USCG — did any of them validate the workflows?"**
No, and the repo's own framing (agency names in scenario titles, HANDOFF's 'targets SFPD/OPD/DoD evaluators' intent) invites the question. This is the highest-leverage gap to close *before* any investor conversation: get 3-5 structured sessions with actual DFR operators (police UAS units are approachable), fix what they laugh at (see H6), and turn their quotes into the validation slide. Until then, say "not yet validated by operators" proactively — the audit found several tells (H6) that a practitioner will spot in minutes, and being ahead of that is worth more than the features.

**Q4. "Your compliance/UTM layer is simulated. What's the real path to LAANC/USS/Remote ID integration, and do you understand the certification burden (FAA, CJIS for evidence, SOC 2 for agencies)?"**
The repo demonstrates correct *vocabulary* (LAANC, USS, Remote ID, 400 ft, BVLOS, OOP) and admirable honesty that none of it is real. The real path: LAANC via an FAA-approved USS partner (Aloft/Airspace Link class), ASTM F3411 Remote ID ingestion, CJIS compliance if evidence chains touch CAD/RMS, plus multi-tenant backend, RBAC, and audit logging — realistically 12–24 engineer-months to a credible v1, none of it started. Answer honestly: "the simulator de-risks product and workflow; the integrations are the funded work." And fix C1 first — claiming evidence-grade chain-of-custody while the hash chain doesn't verify is the single worst artifact to hand a technical diligence partner.

**Q5. "Who is the team? This looks like one person with AI leverage — impressive, but who operates, who sells to government, who has flown these missions?"**
Real gap; no repo fixes it. The strongest version of the answer: own the solo-with-AI-leverage story explicitly (it's increasingly a positive signal for seed funds when the artifact quality is this high), and name the specific first hire (a DFR operator/former public-safety UAS lead as domain co-founder or advisor). The `outputs/` GTM kit cuts both ways: it shows GTM velocity, but templated Instagram carousels for a defense-adjacent tool will read as AI slop to a partner — keep it private (H5) and lead with the working demo.

**Q6. "What's the market, and what do you charge for?"** *(bonus — it will come up)*
This artifact doesn't evidence a market and shouldn't pretend to. Rough shape if pursuing the training/rehearsal wedge: US public-safety UAS programs number in the low thousands and growing fast post-BVLOS-rulemaking; training/simulation budgets exist (agencies already pay for FlightSafety-style tools elsewhere); DoD synthetic-training adjacency (STE/One World Terrain ecosystem) is the larger dual-use expansion. Order-of-magnitude honesty beats a fabricated TAM slide — consistent with your own banned-claims list.

**Realistic technical gap to a fundable product** (asked for directly): real telemetry ingestion (actual MAVLink/DJI/Autel SDKs — note M6: the current MAVLink layer is display-only), multi-tenant backend + auth/RBAC + audit, CJIS-grade evidence storage (C1 fixed and then hardened), live map/video pipelines, LAANC/USS + Remote ID integrations, hardware-in-the-loop or vendor partnerships, and an operator-validated UX pass. That is a seed round's worth of work; the current repo is the demo that earns the meetings, not the product.

---

## 8. Prioritized Action Plan (each item ≈ one sitting; S < 2 h, M ≈ half-day–day, L = multi-day)

1. **[BOTH][S-M] Fix the hash chain.** Serialize event creation (promise queue in `addEvent`/`buildEvent`, or sync hashing) so `prevHash` is always the true predecessor. (C1)
2. **[BOTH][S] Make verification real.** Call `verifyChain` in a test against a full production-loop run; verify on export; stamp `chainVerified: true/false` into the JSONL/after-action; make the UI ✓ conditional. (C1/C2)
3. **[INVESTOR][S] Remove or relabel `responseTimeSavedMin` and `routeRiskReductionPct`** as formula-based illustrations, or delete them from READY + after-action. Rename the "AI Detection Cue" chapter ("Thermal Detection Cue"). (C2, M13)
4. **[BOTH][S] Repo hygiene:** add LICENSE, gitignore `outputs/`, relocate the GTM kit, delete `verify-extract` runtime droppings. (H5)
5. **[PORTFOLIO][S-M] Fix Launch Bay Planner wiring** (consistent site keys + spawn-position test; make `capacityDrones` data-driven). (H1)
6. **[PORTFOLIO][M] Add a README "Architecture & Verification" section:** store design, fixed-timestep kernel, sim/render decoupling diagram, test counts and philosophy, and a "verified claims" table (commands + expected output). This is the highest-leverage portfolio item after the chain fix — the engineering craft is currently invisible to a skimming reviewer.
7. **[PORTFOLIO][M] Drift-corrected sim clock** (accumulator on `performance.now()`, capped catch-up; sim-time-derived event timestamps). (H2)
8. **[PORTFOLIO][M] Zustand selectors everywhere;** isolate the header clock; gate TelemetryPanel's derived-state computation by active tab. (H4)
9. **[PORTFOLIO][L] Integration + component test layer:** production-loop determinism & chain-integrity test (fake timers), 3-5 @testing-library smoke tests (ControlBar gating, OperatorCommandPanel actions, ReplayPanel), an error boundary. (H3)
10. **[BOTH][S] Domain seam pass #1:** decouple Remote ID from C2; align lost-link checklist text with actual behavior; distinguish bypass/restricted/no-fly geofence rendering. (H6.1-2, M3)
11. **[PORTFOLIO][S] Fix export-during-scrub** (snapshot final state into `replaySession` and export from it, not live store). (M1)
12. **[PORTFOLIO][S] Bundle split** (`manualChunks`: maplibre, recharts) + lazy-load ReplayPanel/LaunchBayPlanner. (M4)
13. **[PORTFOLIO][S] Dead-code sweep:** EventBus, unused ground-unit factories, `avoid` state (implement a minimal lateral-offset maneuver or delete state + event types), dedupe `pointInPolygon`, Fisher–Yates shuffle, `etaSec` sentinel. (M8-M10, H6.3)
14. **[PORTFOLIO][M] Toolchain upgrade** (vite 7 / vitest 4) → `npm audit` clean again; re-run full suite. (H7)
15. **[BOTH][M-L] Operator validation sessions** (3-5 real UAS/DFR practitioners), then a UX pass: suggestion diff preview (M2), generated-label rewrite (H6.6), panel collapse below 1300 px (M15), alert hierarchy for fleet-wide comms loss.

---

## Appendix — Ground-truth verification (Phase 1 results)

| Claim | Result |
|---|---|
| Stack: React 18.3.1, TS 5.7.2, Vite 6.0.5, MapLibre 4.7.1, Zustand 5.0.2, Recharts 2.13.3, Vitest 2.1.8 | ✅ confirmed ([package.json](../package.json)) |
| 92 git-tracked files; ~13.9k LOC | ✅ 92 files; 13,970 lines across `*.ts`/`*.tsx` (incl. configs) |
| 27 test files / 178 tests, vitest `environment: 'node'`, no jsdom/@testing-library | ✅ 27 passed files / 178 passed tests; no component tests exist |
| `tsc -b`, `eslint src`, `vitest run`, `vite build` clean | ✅ all exit 0 |
| Bundle: single ~1.6 MB chunk (449 kB gzip) + Vite warning | ✅ 1,613.24 kB / 449.23 kB gzip |
| `npm audit` clean | ❌ **drifted** — 5 vulns (3 moderate / 1 high / 1 critical), all dev-toolchain only (esbuild/vite/vitest) |
| 21 scenario catalog entries | ✅ 7 base + 14 extreme ([catalog.ts:20-29](../src/scenarios/catalog.ts:20)) |
| No LICENSE at repo root; zip ships EULA/LICENSE/THIRD_PARTY_NOTICES | ✅ confirmed |
| outputs/ untracked ~4 MB GTM kit | ✅ 4.0 MB, untracked **and unignored** |
| TASKS.md / HANDOFF.md stale, gitignored | ✅ gitignored (not audited as current status) |
| Chain-of-custody SHA-256 hash chain | ⚠️ implemented but **broken at runtime** (live `verifyChain` = false) — see C1 |
| Deterministic simulation (seeded mulberry32) | ⚠️ true for the physics/sensor kernel; **not** true for the evidence layer (wall-clock timestamps, promise-ordered events, `Date.now()` ids) and untested against the production loop |

*Audit artifacts: verification log retained in the session scratchpad; live-run evidence captured via instrumented browser session on 2026-07-02.*
