# Remediation Log

Tracks disposition of every finding in [`AUDIT_PORTFOLIO_INVESTOR_READINESS.md`](AUDIT_PORTFOLIO_INVESTOR_READINESS.md)
against the 8-phase remediation plan executed on the `remediation/audit-10s` branch. Investor-narrative
findings (team, market validation, moat) were explicitly out of scope for this pass — see the audit's
Phase 5 section for those; they require business work, not code.

| Finding | Severity | Disposition | Phase |
|---|---|---|---|
| C1 — Hash chain broken at runtime (`verifyChain` returns false) | Critical | **Fixed.** Synchronous SHA-256, atomic `emitEvent` action, integration test drives the real production loop and asserts the chain verifies + no duplicate `prevHash`. | 1 |
| C2 — Fabricated investor ROI KPI (`responseTimeSavedMin`, `routeRiskReductionPct`) | Critical | **Fixed.** Both fields deleted from the type, engine, and UI. Outcome summary is measured-only. | 2 |
| H1 — Launch Bay Planner assignments never reach the sim | High | **Fixed.** `initFleet` resolves assignments by the same key the planner uses; regression tests including an unknown-key fallback. | 3 |
| H2 — Sim clock has no drift correction, silently throttles in background tabs | High | **Fixed.** `requestAnimationFrame` fixed-timestep accumulator with capped catch-up; honest pause (no burst) when the tab is hidden. Unit-tested in isolation. | 3 |
| H3 — No integration/component test layer; nothing tests the production loop | High | **Fixed.** Production-loop integration tests (fake timers, real `tick()`) + 5 jsdom component test suites + an error boundary that previously didn't exist. | 1, 6 |
| H4 — Unselected 20Hz store subscriptions re-render on every mutation | High | **Fixed.** `useShallow` selectors on all 10 always-mounted components; tab-gated derived state in TelemetryPanel; UTM state throttled to the existing 10fps interval instead of a per-render `useMemo`. | 5 |
| H5 — No LICENSE; `outputs/` GTM kit untracked but not gitignored | High | **Fixed.** Source-available LICENSE added; `outputs/` gitignored (contents untouched, per scope decision). | 0 |
| H6.1 — Remote ID conflated with C2 comms link | High | **Fixed.** Remote ID status now derives from mission state (independent broadcast), not `signalDbm`. Regression test asserts RID stays broadcasting through a comms window. | 2 |
| H6.2 — Preflight checklist text contradicts actual lost-link behavior | High | **Fixed.** Checklist text now matches the sim's real doctrine (continue task, reconnect on restore, RTB on reserve/geofence). | 2 |
| H6.3 — Deconfliction detects but never acts; dead `avoid` state/events | High | **Fixed.** Give-way drone flies a timed divergence maneuver; `avoidance_start`/`avoidance_complete` emitted through the chain. Dead `obstacle_detected` event type removed. | 4 |
| H6.4 — Thermal model overly conservative range, no localization error, fake IR overlay | High | **Fixed.** Seeded localization error added; model assumptions documented in-code and in `ARCHITECTURE_NOTES.md`; fake screen-anchored IR blobs removed (the already-correct geolocated layer is now the only thermal overlay). | 4 |
| H6.6 — Regex/template-generated ops text leaks into operator UI | High | **Fixed.** `routePatternFor` matches drone role before scenario text; "Explicit simulated…" filler rewritten; `deriveAgencies` uses a token scan instead of a fragile name-prefix split. | 4 |
| H7 — `npm audit`: 5 vulnerabilities (1 critical, 1 high) in dev toolchain | High | **Fixed.** vitest 2→4 major upgrade; `npm audit` now reports 0 vulnerabilities. | 0 |
| M1 — After-action export during replay scrub reflects stale frame state | Medium | **Fixed.** `MissionReplaySession` snapshots final fleet/thermal/weather state at stop time; exports prefer the snapshot over live (scrub-contaminated) store fields. | 3 |
| M2 — Route suggestion fallback can silently replace a route with no diff shown | Medium | **Fixed** (build-update pass, July 2026). Every pending suggestion card shows a current-vs-suggested route diff (waypoints, distance, first→last labels); regression test in `operatorCommandPanel.spec.tsx`. |  |
| M3 — All geofences render identical red regardless of type/authority | Medium | **Fixed.** Styled by authority (no-fly / restricted / authorized-bypass) with an on-map legend. | 4 |
| M4 — Single unsplit ~1.6MB JS chunk | Medium | **Fixed.** `manualChunks` isolates maplibre-gl/recharts/react; 3 modal components lazy-loaded. Main app chunk: 1613kB → 268kB. | 5 |
| M5 — Replay buffer comment wrong; no truncation warning | Medium | **Fixed.** Comment corrected (~10 min, not ~5); ReplayPanel shows a truncation note when early frames were dropped. | 3 |
| M6 — "MAVLink" feed could be mistaken for wire-format protocol | Medium | **Fixed.** Header comment clarifies display-only status and the vx/vy convention. | 6 |
| M7 — KML export doesn't XML-escape interpolated text | Medium | **Fixed.** All free-text fields escaped; final-altitude-per-path simplification documented. | 6 |
| M8 — Biased `sort(() => rng()-0.5)` shuffle | Low | **Fixed.** Replaced with seeded Fisher–Yates. | 6 |
| M9 — Dead code (EventBus, duplicate `pointInPolygon`, unused ground-unit factories) | Low | **Fixed.** All three removed (plus their now-orphaned tests). | 6 |
| M10 — Non-deterministic-looking ids, magic ETA sentinel, `setTimeout` sequencing hacks | Low | **Fixed.** Tick-derived ids, explicit `etaComputed` flag, `setTimeout` hacks removed (Zustand writes are synchronous). | 3 |
| M11 — SAR lawnmower rows use bounding box, not polygon | Low | **Fixed.** Scan-line clipping to the actual search polygon; regression test on a non-rectangular area. | 4 |
| M12 — `nearestStation` uses exact-equality, not true nearest | Low | **Fixed.** Now a real nearest-by-distance search. | 4 |
| M13 — "AI Detection Cue" label (no ML exists anywhere) | Low (Medium for investor read) | **Fixed.** Renamed to "Thermal Detection Cue"; regression test asserts no "AI" wording on the demo spine. | 2 |
| M14 — Preflight checklist is pre-checked theater | Low | **Fixed.** Items are individually checkable; "Continue" gates on all confirmed. | 2 |
| M15 — Map occlusion below ~1300px viewport width | Low | **Fixed** (build-update pass, July 2026). 1300px breakpoint narrows shell columns and ops-hub/status-feed overlays; verified at 1280px. |  |
| M16 — Windows launcher echoes exceptions; stray runtime files in the release tree | Low | **Fixed** (build-update pass, July 2026). Launcher promoted to tracked source (`scripts/windows/Start-DroneSimulator.ps1`) with a packaging script; 500s return a generic body, runtime markers write to a temp rundir cleaned on exit. Verified live: 200/404 correct, package tree stays pristine. |  |

## Net result

- `npm audit`: 5 vulnerabilities → **0**
- ESLint: 6 warnings → **0**
- Tests: 178 → **242** (27 → 42 files as of the public-launch pass), now spanning node unit
  tests, jsdom component tests, and fake-timer production-loop integration tests (previously
  zero of the latter two)
- Main JS chunk: ~1,613 kB → **268 kB** (maplibre/recharts split into separate vendor chunks)
- The chain-of-custody hash chain **verifies** on live missions (previously did not)
