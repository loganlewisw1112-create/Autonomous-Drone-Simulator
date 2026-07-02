# Autonomous Drone Simulator

Local-first React + TypeScript simulator for multi-drone public-safety missions. The app models operator-supervised drone operations across public safety, SAR, fire, maritime, border, disaster response, and multi-agency pursuit scenarios. It is simulation-only: no real drones, FAA services, cameras, identity systems, dispatch systems, or live UTM providers are connected.

## What The Simulator Does

### Mission Operations

- Runs 21 scenario catalog entries from `src/scenarios/catalog.ts`.
- Supports waypoint, SAR parallel-track, perimeter, inspection, pursuit, wildfire, hazmat, welfare, and long-range relay mission patterns.
- Generates mission briefs, command intent, success criteria, operational constraints, dispatch timelines, and per-drone route briefs.
- Models multi-drone fleets from 3 to 8 aircraft with per-drone roles, altitude bands, route patterns, launch sites, recovery plans, and sortie plans.

### Operator Controls

- Lets the operator start, abort, stop, reset, replay, and speed-control the simulation.
- Supports per-drone route editing, waypoint dragging, route autosave/restore, command routes, append-waypoint flows, hover, resume, RTB, recharge, deep scan, street sweep, perimeter orbit, expanding search, standoff observe, remote landing, and recovery abort commands.
- Generates route suggestions that can be accepted or rejected by the operator.
- Exposes an OPS HUB with active routes, launch/recovery site rows, route suggestions, retask controls, and a dispatch task queue.

### Tactical Map And Telemetry

- Renders drones, routes, editable route markers, launch and recovery sites, geofences, search areas, operational features, thermal contacts, UTM reservations, and external traffic overlays.
- Shows per-drone state, battery, signal, speed, altitude, heading, current waypoint, warnings, conflicts, geofence state, weather diversion, recharge state, and recovery state.
- Tracks mission timeline events including mission start, waypoint reached, route complete, low battery, RTB trigger, emergency landing, comms degraded/lost/restored, conflict detected/resolved, geofence breach, thermal detection, recharge, sortie launch, ground-unit dispatch, and drone recovery.

### Safety, Weather, And Airspace

- Applies deterministic geofence checks, deconfliction, route audits, low-battery RTB, comms-loss windows, weather variants, and safety warnings.
- Models location-aware weather profiles for coastal, urban, wildfire, mountain, desert-border, and generic environments.
- Simulates regulatory/coordination surfaces: Remote ID status, simulated LAANC or incident-command authorization, Part 107 attention flags, BVLOS/night/over-people flags, airspace reservations, external traffic, and UTM conflicts.
- Keeps all compliance and UTM behavior deterministic and simulation-only.

### Sensors, Ground Response, And Recovery

- Simulates thermal detections for people, vehicles, heat sources, and campfires with confidence effects from weather.
- Supports selecting thermal contacts, focused scan, hover hold, dispatch unit, escalation, false-positive marking, resolution, and clearing contacts.
- Models ground units for intervention, medical, fire, law enforcement, maintenance, and recovery tasks.
- Supports downed-drone recovery teams, weather/access notes, remote landed/stranded states, recovery dispatch, on-scene extraction, and unrecoverable simulation outcomes.
- Includes recharge stations, staged battery-swap points, multi-sortie plans, and forward recovery behavior for long-range missions.

### Replay, Evidence, And Exports

- Records full mission replay frames with drones, thermal contacts, ground units, recovery teams, weather state, active events, and mission metrics.
- Exports chain-of-custody JSONL, KML, GeoJSON, mission reports, and investor after-action packages.
- After-action packages include replay frame count, event count, mission KPIs, compliance state, UTM state, chain hash, fleet state, and position samples.
- Investor Demo Mode guides the app through brief, launch, retask, detection, recovery, and review chapters.

## Scenario Catalog

The published simulator currently includes 21 scenarios. Each row below summarizes the current source-backed scenario data.

| # | Scenario | ID | Drones / sorties | Summary |
|---|---|---|---:|---|
| 1 | Demo - Basic Waypoint | `demo_basic` | 3 / 1 | Baseline movement and telemetry check. Three drones fly a square route with one no-fly geofence, thermal person/vehicle cues, and a short comms-loss window. |
| 2 | SAR - Parallel Track Grid | `demo_sar` | 3 / 1 | Golden Gate Park SAR pattern. Three drones execute parallel-track search over a defined area with thermal missing-person cues and an SFO approach restricted corridor. |
| 3 | SFPD - Suspect Grid Search | `demo_suspect_search` | 3 / 1 | Financial District armed-robbery search. Drones run an east-west lawnmower grid across Battery, Front, and Davis corridors with thermal suspect/getaway cues and Salesforce Tower RF degradation. |
| 4 | OPD - Vehicle Pursuit (Oakland) | `demo_vehicle_pursuit` | 3 / 1 | Oakland Broadway stolen-vehicle pursuit. One drone shadows overhead, one relays mid-corridor, and one pre-positions at the I-880/Oak Street intercept while comms degrade under an overpass. |
| 5 | SAR - Coastal / Ocean Beach | `demo_sar_coastal` | 3 / 1 | Night coastal SAR for hypothermic swimmers. Nearshore, beach-face, and dune-strip drones use thermal-first search with weak heat signatures and marine-layer comms degradation. |
| 6 | Port Security - Perimeter Patrol | `demo_perimeter` | 3 / 1 | Port of Oakland suspicious-vessel response. Overlapping drone sectors cover dock, gates, berth, and full-terminal overwatch with vessel/person/vehicle thermal contacts and crane RF interference. |
| 7 | CAL FIRE - Wildfire Recon (East Bay) | `demo_wildfire` | 3 / 1 | Grizzly Peak wildfire recon. Three-flank routes map spotfires and structure threat while avoiding the active fire-column no-fly zone and smoke-driven RF degradation. |
| 8 | LAPD SIS - Hollywood Bowl Response | `extreme_lapd_hollywood_bowl` | 5 / 2 | Five-drone venue response across shell, hillside seating, VIP/press entrance, Highland Ave, and Cahuenga Pass sectors, with recharge and relaunch for secondary search. |
| 9 | CBP Eagle Pass - Rio Grande Relay | `extreme_cbp_eagle_pass` | 5 / 3 | Overnight Rio Grande relay patrol. Five drones cover ford, cane-break, bridge, oxbow, and high-alt relay sectors across multiple sorties with border geofences and repeated comms windows. |
| 10 | FBI HRT - Compound Siege (ISR/Entry/Extract) | `extreme_fbi_hrt_compound` | 4 / 1 | Fortified-compound support mission. Four drones cover outer ISR, dynamic entry support, structure/garage observation, extraction corridor, and command relay. |
| 11 | USCG District 1 - Atlantic Mariner SAR | `extreme_uscg_cape_cod_sar` | 5 / 2 | Cape Cod offshore SAR for an overdue vessel. Five drones search SAROPS probability sectors, drift vectors, and relay/contact zones for hypothermic survivors. |
| 12 | USSS - Presidential Visit SF Advance Sweep | `extreme_usss_presidential_sf` | 5 / 1 | Presidential site-advance sweep around Moscone, motorcade route, Union Square/Westin, Powell BART, and Nob Hill hotel exterior. |
| 13 | FEMA USAR - Hurricane Ian, Fort Myers Beach | `extreme_fema_fort_myers` | 5 / 2 | Post-hurricane USAR grid over Estero Island. Drones search collapsed structures and debris fields for survivor thermal signatures before an inbound weather window closes. |
| 14 | ATF Group IX - Oakland Stash Surveillance | `extreme_atf_oakland_stash` | 4 / 2 | East Oakland surveillance support. Two-sortie operation covers pre-distribution and distribution windows with four drones assigned to overwatch, route, stash, and command-link roles. |
| 15 | DHS CIKR - Port of LA Chemical Response | `extreme_dhs_port_la_chemical` | 5 / 1 | Port of LA hazmat response. Five drones characterize source, track plume, sweep container yard, hold Seaside Ave perimeter, and maintain ICP comms relay. |
| 16 | LAPD SkyWatch - Skid Row Welfare Grid | `extreme_lapd_skid_row_welfare` | 5 / 2 | Heat-advisory welfare check grid with LAPD, LA County DMH, and LAHSA. Drones look for hyperthermia or motionless contacts without identity logging. |
| 17 | NYPD Aviation - Times Square MCI | `extreme_nypd_times_sq_mci` | 5 / 2 | Times Square mass-casualty response. Drones cover incident zone, crowd-flow corridors, Port Authority blocks, TKTS overwatch, and comms relay. |
| 18 | CAL FIRE / USFS - Dixie Fire, Northern Flank | `extreme_cal_fire_dixie` | 5 / 3 | Persistent wildfire recon over an 8-km northern flank segment, including Hwy 70 fire edge, spotfires, Greenville structures, canyon crews, and ATGS/ICP relay. |
| 19 | CBP Big Bend - Desert Humanitarian SAR | `extreme_cbp_big_bend_desert_sar` | 4 / 2 | Presidio Station humanitarian SAR in extreme desert heat. Drones search for hyperthermic distress signatures and cue CBP EMT teams at forward points. |
| 20 | Multi-Agency - SF -> Albany Hills Suspect Pursuit | `extreme_multiagency_sf_pursuit` | 8 / 2 | SFPD/OPD/CHP/BART PD pursuit from SF through the East Bay. Eight drones cover shadows, overwatch, forward intercepts, perimeter sealing, and C2 relay with explicit SF, Jack London Square, East Bay, and Oakland Airport staging. |
| 21 | CBP Laredo - Rio Grande 25-Mile Relay Patrol | `extreme_cbp_rio_grande_longrange` | 5 / 6 | Long-range corridor patrol from Falcon Lake toward Mission, TX. Drones advance through staged mobile recharge vehicles on US-83 instead of returning to origin, with long-range battery kits and forward recovery discipline. |

## Local Setup

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Verification Commands

```bash
npm test
npm run lint
npm run build
```

Expected build note: Vite may warn about a large chunk because MapLibre/Recharts are bundled into the app. That warning is known and does not block the local demo.

## Investor Demo Script

1. Load `USCG Coastal SAR` (`demo_sar_coastal`) and let preflight / launch bay planning appear.
2. Turn on `DEMO MODE` in the bottom control bar.
3. Complete launch planning, start the mission, and select a drone from the fleet panel.
4. Drag a yellow route marker or issue `SUGGEST` / `Deep Scan` from OPS HUB to show validated route edits and autosave.
5. Open the `READY` tab in the right panel to show mission outcome, compliance readiness, and UTM coordination.
6. Switch to IR / Thermal, select a thermal contact, and dispatch or resolve it.
7. Stop the mission, enter replay, and export the After Action Package.
8. Use `DEMO RESET` before a second run to clear transient state and saved waypoint drafts.

## Known Limitations

- This is a browser simulator only. It does not connect to real drones, Remote ID hardware, FAA services, LAANC, UTM providers, cameras, or cloud APIs.
- Regulatory and UTM surfaces are deterministic simulation layers for demo credibility, not operational authorization tools.
- Map tiles load from OpenFreeMap; the app keeps tactical UI state local, but a venue with no network can still affect base-map detail.
- Generated build output, runtime logs, local environment files, and agent handoff artifacts are intentionally excluded from the published repository.
