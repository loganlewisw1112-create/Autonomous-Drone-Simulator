# Autonomous Drone Simulator

**Browser-only. Simulation-only. No real aircraft.**

A local-first React + TypeScript simulator for the multi-drone public-safety missions a human operator **supervises** — plan, preflight, launch, retask, thermal contacts, readiness, replay, and export — without wiring anything to live drones or aviation systems.

![Animated capture of the simulator running a coastal SAR mission with active drones, the OPS HUB, route suggestions, telemetry, and tactical map overlays.](docs/media/readme/hero-live-workflow.gif)

| Try it now | Open |
|---|---|
| **Mobile** | **[Launch Mobile](https://autonomous-drone-simulator-mobile.vercel.app/)** — phone or tablet |
| **Windows** | **[Launch Windows](https://autonomous-drone-simulator.vercel.app/)** — Windows PC only |
| **Classroom (UI demo)** | **[Classroom home](https://autonomous-drone-simulator-classroom.vercel.app/)** — accounts + instructor/student UI |

> **Live multi-student class?** The Vercel classroom link is a **client showcase**. A real class on your Wi‑Fi needs one **Windows instructor PC** running the **desktop classroom app** (`npm run classroom:desktop`) or the terminal relay (`npm run classroom`) — step-by-step below.

---

## What you get in one glance

- **Full mission arc** — scenario → preflight → launch → retask → thermal → ready → replay → export  
- **Autonomy on a leash** — route suggestions wait for accept/reject; nothing reroutes behind your back  
- **Deterministic sim** — same seed → same mission (honest demos and classroom grading)  
- **Three builds, one repo** — Mobile, Windows, Classroom  
- **Classroom mode** — instructor wall + student sims, end-to-end encrypted on your LAN  

On Mobile or Windows, tap **▶ LAUNCH DEMO** on the welcome screen for a guided mission.

Windows is platform-locked: open it on a non-Windows device and you get **ERROR — WINDOWS VERSION ONLY** with a path to Mobile.

Accounts stay in **that browser’s storage** — nothing is uploaded; Mobile / Windows / Classroom do **not** share logins.

---

## Run a classroom session (instructor + students)

**Who this is for:** a teacher, club lead, or anyone hosting a class. Students need a **Windows** laptop or desktop browser on the same Wi‑Fi.

**You need:** Node.js **20+**, this repo, and one computer that stays on (the instructor machine).

### Step 1 — Install once (instructor machine)

```bash
git clone https://github.com/loganlewisw1112-create/Autonomous-Drone-Simulator.git
cd Autonomous-Drone-Simulator
npm install
```

### Step 2 — Instructor unlock (type a code once)

Instructor signup needs a one-time access code. **You never create folders or hex digests by hand.**

1. Start the classroom (Step 3), open **Start a training class**, and create/sign in as Instructor.  
2. On first setup for that machine, type the access code you want for your school → **Finish account setup**.  
3. The app saves a hash automatically (browser storage, and `local-secrets/` on the LAN relay when available). That code becomes the school unlock for later instructor accounts.  
4. If a school code is already set, new instructors must enter **that same code** — the app will not silently overwrite it.

Optional: a plaintext recovery copy may appear under gitignored `local-secrets/instructor-access-code.txt` on the instructor PC. You do not need to create or edit that file.

**Reset (intentional admin only):** clear this site’s browser storage for the classroom origin, and either delete `local-secrets/instructor-access-hash.txt` (and the optional code file) on the instructor machine or `DELETE /api/instructor-access` against the LAN relay. Then type a new first code.

If you are a student: skip this. Your teacher gives you the unlock code only if you are creating an instructor account.

Hosted classroom on Vercel can still use a dashboard env digest when present; operators still only **type a code** in the UI.

### Step 3 — Start the classroom server (Windows instructor PC)

**Preferred — desktop app (auto-starts / auto-stops the relay):**

```bash
npm run classroom:desktop
```

PowerShell helper: `pwsh scripts/windows/Start-ClassroomDesktop.ps1`  
Relaunch without rebuild: `npm run classroom:desktop:launch`

A splash asks **Start the Classroom Server?**

| Choice | What happens |
|---|---|
| **Yes** | Starts `server/classroom.mjs` in the background (if not already up), opens the classroom UI, keeps the relay alive until you quit the app |
| **No** | Connects if a relay is already running; otherwise shows short setup and lets you open the UI without a live server |

Closing the desktop app stops a relay **this app started**. Browser / GitHub / Vercel demos **cannot** spawn Node — their Yes button only probes for a running server.

**Alternative — terminal relay:**

```bash
npm run classroom
```

Wait until you see something like:

```text
Classroom relay on http://localhost:8080
Classroom relay on http://192.168.x.x:8080
```

Leave that terminal open if you used the alternative path. Closing it ends the class for everyone.

### Step 4 — Instructor (same machine or another device on the Wi‑Fi)

1. Open the LAN URL printed above (on the instructor PC: `http://localhost:8080`).  
2. Create or sign in as an **Instructor** account.  
3. Open **Start a training class** (`?coordinator=1` if you need the direct link).  
4. New instructors: enter the supervised **Insert access code here** once → Finish account setup.  
5. Choose scenario / seed → **Create class**.  
6. Note the **6‑character class code** and show students the join URL (same host, join flow).

### Step 5 — Students (Windows laptops/desktops on the same Wi‑Fi)

Classroom is **Windows-only**. Phones and tablets are blocked with a clear error screen.

1. Open the instructor’s LAN address on a **Windows PC** (for example `http://192.168.x.x:8080` — use the IP from Step 3, not `localhost` on another machine).  
2. Create or sign in as a **Student** account (open signup).  
3. Enter the **6‑character class code** and join.  
4. Fly the mission on their Windows device; the instructor wall watches the class.

### Step 6 — End class

Instructor ends the class from the console. Per‑student progress is archived into the instructor’s **encrypted on‑device** classroom history (that browser + that instructor password).

### Quick rules (read once)

| Do | Don’t |
|---|---|
| Prefer `npm run classroom:desktop` on the instructor Windows PC (or keep `npm run classroom` running) | Expect a live multi‑student class on Vercel alone |
| Put students on **Windows PCs** on the **same Wi‑Fi** as the instructor | Ask students to join from phones/tablets or open `localhost` on another machine |
| Give instructors the unlock code **offline** (or let the first typed code set it) | Put unlock codes in README, git, or chat logs you publish |
| Use Student accounts for learners | Use Instructor unlock for every student |
| Type only an access code in the UI for instructor setup | Ask anyone to create `local-secrets/` or paste hex digests by hand |

Hosted UI tour (no live relay): [Classroom home](https://autonomous-drone-simulator-classroom.vercel.app/) · [Start a class](https://autonomous-drone-simulator-classroom.vercel.app/?coordinator=1) · [Join](https://autonomous-drone-simulator-classroom.vercel.app/?join=)

More detail: [`docs/CLASSROOM_GUIDE.html`](docs/CLASSROOM_GUIDE.html)

---

## Workflow at a glance

### 1. Command center overview

The simulator opens into a tactical operations layout: fleet status on the left, map and mission brief in the center, OPS HUB controls docked beside the map, and telemetry/readiness tabs on the right.

![Command center overview showing SAR coastal scenario data, fleet cards, tactical map, OPS HUB, telemetry, and bottom mission controls.](docs/media/readme/01-command-center-overview.png)

### 2. Scenario breadth

The scenario catalog includes public safety, SAR, fire, maritime, border, disaster response, venue security, and multi-agency pursuit missions. Larger scenarios model more aircraft, more launch/recovery sites, and more coordination pressure.

![Multi-agency pursuit scenario loaded with an eight-drone fleet, tactical map overlays, OPS HUB route data, and telemetry panels.](docs/media/readme/02-scenario-catalog.png)

### 3. Preflight and launch planning

Before launch, the app requires simulated readiness checks and per-drone launch bay planning. The operator can inspect launch/recovery surfaces, detect blockers, auto-assign bays, and confirm the launch plan.

![Launch bay planning modal showing per-drone assignments, launch blockers, bay slots, and confirm launch controls.](docs/media/readme/03-preflight-launch-planning.png)

### 4. Live mission operations

Once launched, drones move through assigned routes while telemetry, battery, signal, mission state, route progress, dispatch tasks, and chain-of-custody events update in real time.

![Live coastal SAR mission with drones navigating, active OPS HUB controls, telemetry charts, route overlays, UTM status, and mission active controls.](docs/media/readme/04-live-mission-ops-hub.png)

### 5. Operator route direction

The OPS HUB supports direct route commands and generated route suggestions. Suggestions stay approval-based so the operator can accept or reject changes before the mission plan is altered.

![OPS HUB route suggestion panel showing a relay reposition recommendation with accept and reject controls during a live mission.](docs/media/readme/05-route-command-suggestions.png)

### 6. Thermal detection workflow

IR mode overlays the mission with thermal cues and urgent dispatch feed entries. Detection confidence, drone hold behavior, and operator follow-up cues are visible alongside the tactical map.

![IR thermal mode showing detected thermal contact cues, urgent mission feed entries, drone states, and the operator command surface.](docs/media/readme/06-thermal-contact-dispatch.png)

### 7. Readiness, compliance, and UTM

The READY tab converts simulation state into reviewable outcomes: mission coverage, detected contacts, fleet health, Remote ID status, simulated authorization, max altitude, external traffic, reservations, and active UTM conflicts.

![Readiness panel showing mission outcome, compliance readiness, Remote ID, simulated LAANC authorization, UTM traffic, reservations, and conflicts.](docs/media/readme/07-readiness-compliance-utm.png)

### 8. Replay and after-action export

When the mission stops, replay controls and report export become available. The after-action package includes mission KPIs, replay frame count, event count, compliance state, UTM state, chain hash, fleet state, and position samples.

![Replay mode showing playback controls, mission timeline, report export button, weather state, thermal contact count, and readiness metrics.](docs/media/readme/08-replay-after-action-export.png)

---

## Development timeline (A → Z)

**Z is today.** Earlier letters are foundations this repo still ships.

| | Milestone |
|---|---|
| **A** | React 18 + TypeScript + Vite app scaffold; local-first browser target |
| **B** | Deterministic simulation kernel (seeded loop, same seed → same outcome) |
| **C** | Scenario catalog + mission briefs (**25** incident missions + **6** NIST skills drills) |
| **D** | MapLibre tactical map: drones, routes, geofences, sites, overlays |
| **E** | Fleet panel, telemetry, OPS HUB, mission controls |
| **F** | Preflight checklist + launch-bay planning / auto-assign |
| **G** | Operator route edit, suggestions (accept/reject), RTB / hover / recovery commands |
| **H** | Thermal contact workflow + ground-unit dispatch cues |
| **I** | Safety layer: geofence, deconfliction / avoid maneuvers, battery RTB, comms loss |
| **J** | Weather profiles + simulated Remote ID / LAANC-style / UTM surfaces (demo-only) |
| **K** | Replay window + chain-of-custody evidence + KML / GeoJSON / after-action export |
| **L** | Encrypted on-device accounts (IndexedDB) for Mobile / Windows operators |
| **M** | Mobile map-first shell (drawers, tap waypoints, tablet sizing tier) |
| **N** | Windows-only gated desktop console build |
| **O** | Three Vercel deployments from one codebase (`VITE_APP_TARGET` / classroom flag) |
| **P** | Realism fixture pipeline (weather, airspace, terrain) with verified SHA‑256 fixtures |
| **Q** | Terrain / buildings / occlusion + thermal optics ranges (realism WP‑4 / WP‑5) |
| **R** | Realism WP‑6→11: SAR PoD, GNSS DOP, RF link, NIST lanes, Dryden turbulence, battery discharge |
| **S** | Classroom LAN relay (`server/classroom.mjs`) + E2EE instructor↔student protocol |
| **T** | Coordinator wall + live focus maps (basemap tiles, live pose streaming) |
| **U** | Tactical command assessment Phases 0–9 (advisor → command channel → divert/resume) |
| **V** | Classroom **instructor / student** accounts wrapping live ClassSetup / Join / console |
| **W** | Durable classrooms + encrypted session archives + history UI + sync envelope seam |
| **X** | Supervised instructor unlock: first typed code auto-saves hash (gitignored `local-secrets/` / device storage; never manual hex for instructors) |
| **Y** | Unlock field on **Start a training class**; Create class / Access saved class(es) |
| **Z** | **Current:** Mobile + Windows + Classroom showcase live; LAN class via desktop app (`npm run classroom:desktop`) or `npm run classroom`; unlock + archives on instructor device |

---

## What the simulator does

### Mission operations

- Runs **25 incident missions** plus **6 NIST skills drills** from `src/scenarios/catalog.ts` (see Scenario catalog).
- Supports waypoint, SAR parallel-track, perimeter, inspection, wildfire, hazmat, welfare, flood/USAR, historical disaster, and NIST lane patterns.
- Generates mission briefs, command intent, success criteria, operational constraints, dispatch timelines, and per-drone route briefs.
- Models multi-drone fleets from 3 to 8 aircraft with per-drone roles, altitude bands, route patterns, launch sites, recovery plans, and sortie plans.

### Operator controls

- Lets the operator start, abort, stop, reset, replay, and speed-control the simulation.
- Supports per-drone route editing, waypoint dragging, route autosave/restore, command routes, append-waypoint flows, hover, resume, RTB, recharge, deep scan, street sweep, perimeter orbit, expanding search, standoff observe, remote landing, and recovery abort commands.
- Generates route suggestions that can be accepted or rejected by the operator.
- Exposes an OPS HUB with active routes, launch/recovery site rows, route suggestions, retask controls, and a dispatch task queue.

### Tactical map and telemetry

- Renders drones, routes, editable route markers, launch and recovery sites, geofences, search areas, operational features, thermal contacts, UTM reservations, and external traffic overlays.
- Shows per-drone state, battery, signal, speed, altitude, heading, current waypoint, warnings, conflicts, geofence state, weather diversion, recharge state, and recovery state.
- Tracks mission timeline events including mission start, waypoint reached, route complete, low battery, RTB trigger, emergency landing, comms degraded/lost/restored, conflict detected/resolved, geofence breach, thermal detection, recharge, sortie launch, ground-unit dispatch, and drone recovery.

### Safety, weather, and airspace

- Applies deterministic geofence checks, deconfliction, route audits, low-battery RTB, comms-loss windows, weather variants, and safety warnings.
- Models location-aware weather profiles for coastal, urban, wildfire, mountain, desert-border, and generic environments.
- Simulates regulatory/coordination surfaces: Remote ID status, simulated LAANC or incident-command authorization, Part 107 attention flags, BVLOS/night/over-people flags, airspace reservations, external traffic, and UTM conflicts.
- Keeps all compliance and UTM behavior deterministic and simulation-only.

### Sensors, ground response, and recovery

- Simulates thermal detections for people, vehicles, heat sources, and campfires with confidence effects from weather.
- Supports selecting thermal contacts, focused scan, hover hold, dispatch unit, escalation, false-positive marking, resolution, and clearing contacts.
- Models ground units for intervention, medical, fire, law enforcement, maintenance, and recovery tasks.
- Supports downed-drone recovery teams, weather/access notes, remote landed/stranded states, recovery dispatch, on-scene extraction, and unrecoverable simulation outcomes.
- Includes recharge stations, staged battery-swap points, multi-sortie plans, and forward recovery behavior for long-range missions.

### Replay, evidence, and exports

- Records full mission replay frames with drones, thermal contacts, ground units, recovery teams, weather state, active events, and mission metrics.
- Exports chain-of-custody JSONL, KML, GeoJSON, mission reports, and investor after-action packages.
- After-action packages include replay frame count, event count, mission KPIs, compliance state, UTM state, chain hash, fleet state, and position samples.
- Investor Demo Mode guides the app through brief, launch, retask, detection, recovery, and review chapters.

### Classroom (current)

- Instructor and student roles with local encrypted profiles.
- One-time supervised instructor unlock on **Start a training class**.
- Live LAN session: instructor wall, student sims, E2EE to the instructor browser key.
- End-of-class archives into instructor-only on-device history; optional sync-envelope export for a future cloud seam.

---

## Scenario catalog

The published catalog has **25 incident missions** plus **6 NIST skills drills** (outside the 25). Ids and grouping live in `src/scenarios/scenarioManifest.ts`.

| Group | Count | Examples |
|---|---:|---|
| Training / refreshed incidents | 15 | `demo_basic`, `demo_sar_coastal`, `demo_wildfire`, `train_uscg_maritime_sar`, `train_mountain_sar`, `train_flood_corridor`, … |
| Historical disasters | 10 | Oso SR 530, Camp Fire Paradise, Helene Asheville, Surfside CTS, Harvey Houston, Katrina Lower Ninth, … |
| NIST skills (outside the 25) | 6 | open, obstructed, confined, night acuity, maritime, urban mask (`missionClass: nist_skills`) |

Priority AOs ship terrain DEM fixtures (and Surfside buildings). Interactive authorization training, exact thermal contacts, 25‑minute replay stop, and radiometric payload HUD apply across the operator builds — see Known limitations and [`docs/CLASSROOM_GUIDE.html`](docs/CLASSROOM_GUIDE.html).

---

## Run locally (solo Mobile / Windows style)

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

For venue demos where network map tiles may be unavailable, open `http://127.0.0.1:5173/?map=fallback` to use the local tactical fallback map.

---

## Verification commands

```bash
npm test
npm run lint
npm run build
npm audit
```

The production build isolates MapLibre into its own vendor chunk
(`build.rollupOptions.output.manualChunks` in `vite.config.ts`) and defers Recharts entirely:
the telemetry charts are a `React.lazy` component, so the ~530 kB charts bundle loads
asynchronously and never blocks first paint. MapLibre is still reported as a large chunk —
that's the library's own size, isolated into a cacheable vendor bundle rather than inlined
into app code.

---

## Deployment

The app deploys to **Vercel** via its Git integration: every merge to `main`
triggers a production build (`npm run build`, output `dist/`, Node 20 from
`engines`/`.nvmrc`) in each of the three Vercel projects described below.
`vercel.json` adds immutable caching for hashed assets plus basic security
headers.

The three launch links above are the **same codebase and the same build
command**, deployed as three separate Vercel projects. What differs is a single
per-project environment variable in each project's Vercel dashboard:

| Project | Env |
|---|---|
| Mobile | `VITE_APP_TARGET=mobile` |
| Windows | `VITE_APP_TARGET=windows` |
| Classroom | `VITE_CLASSROOM_ENABLED=true` (`VITE_APP_TARGET` left unset). Production also sets the instructor unlock digest in the Vercel dashboard (never in git). |

Classroom is **client-only** on Vercel — the WebSocket relay (`server/classroom.mjs`) is started on a Windows instructor PC with `npm run classroom:desktop` (preferred) or `npm run classroom`.

The mobile target **never falls back to the desktop grid**: `useDeviceMode`
(`src/hooks/useDeviceMode.ts`) always renders the mobile shell for
`VITE_APP_TARGET=mobile`, on any device that loads that URL, following the
device's own orientation. A tablet is the one wrinkle — it stays on that same
mobile shell but picks up a roomier sizing tier on top of it (wider drawers,
larger type, three-column grids), driven by a separate `useIsTablet` check.
That's a CSS tier, not a different shell or a different `DeviceMode`, so the
phone layout and all the map-fit logic underneath it are untouched. (The
Windows target is unconditional the other way: always the desktop console,
regardless of device, and separately platform-gated to Windows clients only.)
The size/pointer heuristic only comes into play in a local build with no
`VITE_APP_TARGET` set at all — e.g. `npm run dev` — where a tablet counts as
desktop-class and gets the frozen desktop grid, since it already works there.

Fallbacks (maintainer only): `.github/workflows/deploy.yml` can publish a
GitHub Pages copy on manual dispatch (it sets `GITHUB_PAGES=true` so Vite
builds with the `/Autonomous-Drone-Simulator/` base path), and `npm run deploy`
pushes `dist/` to the `gh-pages` branch with the `gh-pages` CLI.

---

## Architecture & verification

See [`docs/ARCHITECTURE_NOTES.md`](docs/ARCHITECTURE_NOTES.md) for the deterministic simulation
kernel, the sim/render decoupling strategy, the evidence-chain design, and the test layering
(node unit tests, production-loop integration tests with fake timers, and jsdom component
tests). The claims below are checkable directly, not just asserted:

| Claim | How to verify | Expected result |
|---|---|---|
| Deterministic simulation (same seed → identical output) | `npx vitest run src/tests/determinism.spec.ts src/tests/simulationLoop.integration.spec.ts` | All pass, including two production-loop runs producing identical replay frames |
| Chain-of-custody hash chain actually verifies | `npx vitest run src/tests/simulationLoop.integration.spec.ts` | `verifyChain()` returns `true` against a live mission's event log; a tampered copy returns `false` |
| No dead-vocabulary safety states (deconfliction acts, not just flags) | `npx vitest run src/tests/avoidManeuver.spec.ts` | A detected conflict drives the give-way drone through a real `avoid` maneuver with paired chain events |
| Reassigning a launch bay actually moves the spawn | `npx vitest run src/tests/launchBayAssignment.spec.ts` | Spawn position matches the reassigned site, not the default |
| Component layer has real UI tests, not just simulation-state tests | `npx vitest run src/tests/controlBar.spec.tsx src/tests/operatorCommandPanel.spec.tsx src/tests/replayPanel.spec.tsx src/tests/fleetPanel.spec.tsx src/tests/errorBoundary.spec.tsx` | All pass against the real Zustand store, not mocks |
| Full gate is green | `npm test && npm run lint && npm run build && npm audit` | 0 type errors, 0 lint errors, successful build, 0 known vulnerabilities |

---

## Investor demo script

1. Load `SAR - Coastal / Ocean Beach` (`demo_sar_coastal`) and let preflight / launch bay planning appear.
2. Turn on `DEMO MODE` in the bottom control bar.
3. Complete launch planning, start the mission, and select a drone from the fleet panel.
4. Drag a yellow route marker or issue `SUGGEST` / `Deep Scan` from OPS HUB to show validated route edits and autosave.
5. Open the `READY` tab in the right panel to show mission outcome, compliance readiness, and UTM coordination.
6. Switch to IR / Thermal, select a thermal contact, and dispatch or resolve it.
7. Stop the mission, enter replay, and export the After Action Package.
8. Use `DEMO RESET` before a second run to clear transient state and saved waypoint drafts.

---

## Known limitations

- This is a browser simulator only. It does not connect to real drones, Remote ID hardware, FAA services, LAANC, UTM providers, cameras, dispatch systems, or cloud APIs.
- Regulatory and UTM surfaces are deterministic simulation layers for **operational authorization training** (interactive preflight steps, launch gating, classroom scoring) — not operational authorization tools and not real FAA/LAANC network calls.
- Map tiles load from OpenFreeMap by default. The fallback map keeps tactical UI state local, but it is not a geographic base-map replacement.
- The thermal sensor model uses published radiometric payload optics (e.g. FLIR
  Hadron 640R / Boson+ class: Johnson detection range from focal length + pixel pitch,
  NETD contrast gating, atmospheric transmission, and terrain/building LOS when a DEM
  fixture is present). Contact positions are exact heat-source coordinates. Full IR
  image simulation and absolute temperature maps are out of scope — radiometric accuracy
  (±5 °C class) is operator metadata only.
- Replay recording stops at ~25 minutes of mission time (750 frames × 2 s); it does not drop
  oldest frames in a rolling window. The UI notes when the cap is reached.
- Hosted classroom cannot run the WebSocket relay on Vercel serverless — use `npm run classroom:desktop` (Electron shell owns start/stop) or `npm run classroom` for live multi-student sessions. Web Yes only probes for a running server.
- Generated build output, runtime logs, local environment files, `local-secrets/`, and agent handoff artifacts are intentionally excluded from the published repository.
