# Working Rules

Read this before working in this repository. These rules are the operating
standard for the Autonomous Drone Mission Simulator.

## Product boundary

This is a local-first React, TypeScript, and Vite simulator for multi-drone
public-safety missions. It includes deterministic physics, routing, sensor,
GNSS, RF, evidence-chain, replay, and instructor-led classroom systems.

Mobile, Windows, and Classroom use one simulation kernel. Rendering and
delivery may differ, but simulation behavior must not. A target-specific
simulation result is a defect.

The classroom relay is LAN-first and does not run on Vercel. Vercel hosts only
the classroom client showcase.

## Source boundaries

- `src/sim/SimulationLoop.ts` owns the fixed-timestep production loop.
- `src/sim/` owns physics, routing, safety, sensor, terrain, weather, battery,
  GNSS, RF, and mission behavior.
- `src/store/droneStore.ts` is the Zustand state boundary. Events enter the
  evidence log only through `emitEvent()`.
- `src/utils/chainOfCustody.ts` and `src/utils/rng.ts` own the synchronous hash
  chain and deterministic random-number derivation.
- `src/scenarios/catalog.ts`, `registry.ts`, and `scenarioManifest.ts` are the
  scenario sources of truth.
- `src/classroom/`, `server/classroom.mjs`, and `desktop/classroom/` own
  classroom-only protocol, crypto, assessment, relay, and desktop behavior.
- Architecture belongs in tracked documents under `docs/`; current release
  status belongs in tracked root `PROJECT_STATUS.md`.

When code and documentation disagree, verify the code, then update the
documentation in the same change.

## Invariants

1. The same seed and inputs produce byte-identical simulation output on every
   target. Physics advances by tick count, never wall clock.
2. Simulation paths must not depend on `Date.now()`, `Math.random()`, runtime
   network data, unstable iteration order, or asynchronous race order.
3. `hashEvent` remains synchronous inside the Zustand reducer. Do not emit
   evidence events outside `emitEvent()`.
4. Object-returning Zustand selectors use `useShallow`.
5. Map readiness is driven by the map `load` event, not
   `map.isStyleLoaded()`.
6. Hot-path map updates stay outside React render. Expensive derived summaries
   are computed only while their consuming view is visible.
7. Every operator, classroom, restored, suggested, or custom route passes
   through the production route-audit and safe-route pipeline.
8. Bundle isolation and fixture budgets are release contracts.
9. User-visible numbers trace to primary standards, published data, or platform
   specifications. Unknown values remain unknown; do not invent constants.
10. Failures are visible and fail closed. Never substitute a silently wrong
    simulation result.
11. Secrets, student work, local classroom backups, and generated credentials
    never enter Git.

## Working method

1. **Orient:** Read the affected production path, current tracked status, recent
   commits, and applicable architecture/realism documentation.
2. **Reproduce:** Verify the behavior before deciding its cause. Record what is
   proven and what remains assumed.
3. **Plan proportionally:** Write down failure modes and rollback for simulation,
   determinism, crypto, account migration, or classroom protocol changes.
4. **Implement narrowly:** Match surrounding conventions. Separate unrelated
   cleanup. Tests must drive production paths rather than parallel
   reimplementations.
5. **Prove:** Run the applicable type, lint, test, target-build, bundle,
   fixture, parity, audit, and rendered smoke gates. Classroom changes exercise
   relay and client together.
6. **Report honestly:** Lead with what is now true, name skipped or blocked
   gates, and distinguish source inspection from rendered/runtime proof.

## Research and fixtures

Use primary sources for standards, aircraft specifications, propagation models,
FAA/NIST procedures, and current library APIs. Record source, retrieval date,
license, and the anchor case reproduced.

External operational data is fetched only by author-time fixture tools and is
frozen into committed, checksummed fixtures. The runtime simulation and
scenario modules never fetch.

## Definition of done

A change is complete only when:

- It fully solves the requested behavior.
- Every touched invariant remains mechanically enforced.
- Typecheck, lint, full tests, bundle isolation, fixture budgets, and dependency
  audit pass.
- Mobile, Windows, and Classroom retain identical simulation inputs and math.
- New behavior is covered through the production path.
- New dependencies and numeric constants are justified.
- Documentation made stale by the change is updated.
- Rendered/runtime behavior is verified where the change is visible.
- Any external or unavailable gate is named explicitly rather than promoted to
  a pass.
