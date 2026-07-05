# Architecture Notes — Autonomous Drone Simulator

## Runtime Shape

- `src/App.tsx` owns the tactical shell: fleet status on the left, map in the center, telemetry
  and readiness on the right, with the control bar pinned below. Wrapped in an `ErrorBoundary`
  so a render defect in any one panel degrades to a visible error card, not a white screen.
- `src/store/droneStore.ts` is the shared Zustand state boundary for scenario selection, drones,
  events, command state, route suggestions, replay state, and UI mode. Every always-mounted
  component subscribes via a `useShallow`-wrapped selector (never the bare hook) — each panel
  re-renders only on the slice of state it actually reads, not on every mutation anywhere in
  the store.
- `src/sim/SimulationLoop.ts` advances the deterministic mission tick, publishes chain-of-custody
  events, updates drone state, records replay snapshots, and keeps simulator time separate from
  React rendering (see **Sim/Render Decoupling** below).
- `src/scenarios/catalog.ts` is the scenario source of truth for mission metadata, launch/recovery
  sites, geofences, weather, heat sources, and per-drone routes — 21 scenarios (7 base +
  14 "extreme"), all run through the same safety/route-audit pipeline.

## Deterministic Simulation Kernel

- Physics runs on a **fixed timestep** (`FIXED_DT = 0.05`s) independent of wall-clock frame rate.
  A drone's next state depends only on the number of ticks executed, never on real elapsed time —
  this is what makes two runs at the same seed byte-identical and replay scrubbing exact.
- All randomness flows through a single seeded PRNG (`mulberry32`, `src/utils/rng.ts`), with
  per-domain seed derivation (e.g. thermal detection noise seeds off `scenarioSeed ^ tick ^
  droneId`) so subsystems don't share — or accidentally correlate — RNG state.
- **Loop driver:** `startSimLoop()` uses a `requestAnimationFrame` accumulator
  (`advanceAccumulator`, unit-tested in isolation) rather than a bare `setInterval`. Each frame
  accumulates real elapsed time and runs whole `FIXED_DT` steps, capped per frame to absorb
  ordinary jitter without a catch-up burst. When the tab is hidden, rAF stops firing —the sim
  **pauses honestly** and resumes cleanly on return (no silent divergence between displayed time
  and actual elapsed time, no fast-forward burst). A `setInterval` fallback exists for
  non-browser contexts (tests call the exported `tick()` directly instead).
- The core step function `tick()` is exported specifically so tests exercise the *real*
  production loop, not a parallel reimplementation (see **Test Strategy**).

## Evidence Chain (Chain-of-Custody)

- `src/utils/chainOfCustody.ts` hashes each mission event with a **synchronous** SHA-256
  (`@noble/hashes`), not the browser's async `crypto.subtle`. This matters structurally: hashing
  must be synchronous so that reading the previous link's hash and committing the next one can
  happen in a single atomic step.
- `droneStore.emitEvent(...)` is the *only* way an event enters the log. It computes
  `hash = hashEvent(state.lastHash, partial)` **inside** the Zustand `set()` reducer, so
  `lastHash` is read and updated in one pass — even when many events fire within a single sim
  tick, each correctly chains off the true previous link. (An earlier async-hash design let
  concurrent emissions within one tick all read the same stale `lastHash` and fork the chain —
  `verifyChain()` now runs as a regression guard against that class of bug, both in
  `src/tests/simulationLoop.integration.spec.ts` and live in the UI.)
- `verifyChain(events)` is synchronous and is actually wired up: the event-log UI's per-event
  mark and the exported JSONL/after-action `chainVerified` field both reflect a real, current
  verification pass — not an unconditional checkmark.

## Sim/Render Decoupling

`TacticalMap` is the highest-frequency-data, highest-complexity view, so it uses a three-tier
update strategy instead of letting React re-render the map on every physics tick:

1. **20fps physics** writes drone state into the Zustand store.
2. A **10fps interval** (independent of React's render cycle) reads the latest state via refs
   and calls MapLibre's `setData()` directly for trails, next-waypoint lines, conflict zones,
   and UTM airspace state — cheap GeoJSON updates at a cadence the map can actually show.
3. A **60fps `requestAnimationFrame` loop** interpolates marker positions and applies
   heading/state changes as direct DOM/CSS mutations (`transform: rotate(...)`), bypassing React
   entirely for the hot path.

Derived, expensive state (`buildMissionOutcomeSummary`, `buildComplianceState`,
`buildUtmAirspaceState`) is computed only when its consuming tab is actually visible
(`TelemetryPanel`'s READY tab), not unconditionally on every tick regardless of what's on screen.

## Mission Systems

- Route safety lives in `src/sim/mission/routeAudit.ts` (Dijkstra over buffered geofence-perimeter
  nodes, with segment-sampling clearance checks) and operator retasking lives in
  `src/sim/mission/operatorRoutes.ts`. Every route entry point — operator drags, command routes,
  route suggestions, restored localStorage drafts — is re-validated through the same pipeline.
- Launch and recovery planning flows through `LaunchBayPlanner`, scenario launch metadata
  (`scenario.launchSites`, keyed by drone id), `defaultDroneStartPosition`, and
  `buildSafeDroneRoutes`. `initFleet()` resolves a confirmed launch-bay assignment by that same
  key, so reassigning a bay in the UI actually moves where the drone spawns.
- Conflict avoidance is not just detection: when `DeconflictEngine` flags a separation-minima
  violation, the give-way aircraft flies a timed divergence-heading maneuver
  (`MissionManager`'s `avoid` state, `AVOID_MANEUVER_SEC` window) and emits paired
  `avoidance_start`/`avoidance_complete` chain events before resuming its interrupted task.
- Ground intervention and downed-drone recovery use `src/sim/mission/groundUnits.ts` and
  `src/sim/mission/recoveryManager.ts`.
- Weather, comms, thermal detections, compliance, UTM, mission outcomes, and after-action
  reporting are deterministic simulation layers, explicitly labeled as such everywhere they
  surface (UI, exports, disclaimers) — see the verified-claims table in the README.
- Thermal detections carry seeded localization error (a reported contact is a sensor estimate,
  not ground truth) and a documented, deliberately conservative range model — see the comment
  block at the top of `src/sim/sensors/ThermalSim.ts`.

## UI Surfaces

- `TacticalMap` renders mission geography, drones, launch/recovery markers, geofences (styled by
  authority: solid red no-fly / dashed amber restricted / dashed green authorized-bypass, with an
  on-map legend), route overlays, thermal contacts, UTM layers, and editable route markers.
- `OperatorCommandPanel` is the OPS HUB for active routes, suggestions, hover/resume/RTB, route
  commands, launch/recovery details, and dispatch tasks.
- `MissionStatusFeed`, `TelemetryPanel`, `FleetPanel`, `ReplayPanel`, `LaunchBayPlanner`, and
  `ControlBar` expose the rest of the operator workflow. `PreflightChecklist`, `LaunchBayPlanner`,
  and `ReplayPanel` are lazy-loaded (`React.lazy`/`Suspense`) since they're gated behind UI state
  and never needed on first paint.
- `ErrorBoundary` wraps the shell; a component throw renders a recoverable fallback card instead
  of a blank page.

## Test Strategy

Three layers, deliberately kept distinct:

1. **Simulation/state unit tests** (`environment: 'node'`, the majority of `src/tests`) — pure
   functions and store actions: geometry, RNG, route auditing, weather, thermal detection,
   compliance/UTM derivation, waypoint persistence, etc.
2. **Production-loop integration tests** — `simulationLoop.integration.spec.ts` and
   `avoidManeuver.spec.ts` drive the *real* `tick()` via `vi.useFakeTimers()` and `startSimLoop()`,
   not a hand-rolled copy of the kernel. These are what pin the hash-chain invariant
   (`verifyChain` true, no duplicate `prevHash`, tamper detection) and cross-subsystem behavior
   (conflict → avoid → resume) against the actual code path a real mission runs.
3. **Component tests** (`// @vitest-environment jsdom` per file, `@testing-library/react`) —
   `ControlBar`, `OperatorCommandPanel`, `ReplayPanel`, `FleetPanel`, `ErrorBoundary`. These mount
   against the real `useDroneStore` singleton (seeded via `setState` in each test) rather than a
   mock, so assertions exercise the same store wiring production does.

The default `node` environment is preserved for the (large) first layer — jsdom is opted into
per-file only where a component actually needs a DOM, keeping the bulk of the suite fast.

## Verification

- `npm test`, `npm run lint`, `npm run build` (plus `npm audit`) are the CI gates — see
  `.github/workflows/ci.yml`.
- The app is intentionally local-first. External systems are represented by deterministic
  simulation layers, not live drone, FAA, camera, or UTM integrations — see the README's Known
  Limitations and the disclaimer strings embedded directly in `complianceEngine.ts` and
  `utmEngine.ts`'s output.
