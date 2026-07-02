# Architecture Notes - Autonomous Drone Simulator

## Runtime Shape

- `src/App.tsx` owns the tactical shell: fleet status on the left, map in the center, telemetry and readiness on the right, with the control bar pinned below.
- `src/store/droneStore.ts` is the shared Zustand state boundary for scenario selection, drones, events, command state, route suggestions, replay state, and UI mode.
- `src/sim/SimulationLoop.ts` advances the deterministic mission tick, publishes events, updates drone state, records replay snapshots, and keeps simulator time separate from React rendering.
- `src/scenarios/catalog.ts` is the scenario source of truth for mission metadata, launch/recovery sites, geofences, weather, heat sources, and per-drone routes.

## Mission Systems

- Route safety lives in `src/sim/mission/routeAudit.ts` and operator retasking lives in `src/sim/mission/operatorRoutes.ts`.
- Launch and recovery planning flows through `LaunchBayPlanner`, scenario launch metadata, `defaultDroneStartPosition`, and `buildSafeDroneRoutes`.
- Ground intervention and downed-drone recovery use `src/sim/mission/groundUnits.ts` and `src/sim/mission/recoveryManager.ts`.
- Weather, comms, thermal detections, compliance, UTM, mission outcomes, and after-action reporting are deterministic simulation layers.

## UI Surfaces

- `TacticalMap` renders mission geography, drones, launch/recovery markers, geofences, route overlays, thermal contacts, UTM layers, and editable route markers.
- `OperatorCommandPanel` is the OPS HUB for active routes, suggestions, hover/resume/RTB, route commands, launch/recovery details, and dispatch tasks.
- `MissionStatusFeed`, `TelemetryPanel`, `FleetPanel`, `ReplayPanel`, `LaunchBayPlanner`, and `ControlBar` expose the rest of the operator workflow.

## Verification

- Unit and integration coverage lives in `src/tests`.
- Primary gates for this portfolio simulator are `npm test`, `npm run lint`, and `npm run build`.
- The app is intentionally local-first. External systems are represented by deterministic simulation layers, not live drone, FAA, camera, or UTM integrations.
