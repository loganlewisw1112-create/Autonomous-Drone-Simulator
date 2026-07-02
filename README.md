# Autonomous Drone Simulator

Local-first React + TypeScript simulator for multi-drone public-safety missions. It models scenario-driven launch planning, per-drone route editing, waypoint autosave, weather/comms effects, tactical map overlays, thermal detections, ground intervention, recovery teams, replay, and exportable evidence packages.

## Demo-Ready Capabilities

- 21 scenario catalog entries with generated mission briefs, dispatch feeds, launch/recovery sites, geofences, weather profiles, and per-drone tactical routes.
- Operator workflow for per-drone route edits, validated command routes, route suggestions, hover/resume/RTB, and saved waypoint drafts.
- Investor Demo Mode with guided chapters across mission brief, launch/edit, live retask, AI detection, recovery, and after-action review.
- Mission Outcome / ROI readiness panel showing coverage, contacts, estimated time saved, route-risk reduction, fleet health, and event evidence.
- Compliance and airspace readiness simulation for Remote ID status, simulated LAANC / incident-command authorization, Part 107 flags, BVLOS/night/over-people attention, and simulation-only disclaimers.
- UTM layer with deterministic external traffic, mission-volume reservations, conflict status, and map overlays.
- After Action Package export combining replay count, mission KPIs, compliance, UTM, chain hash, and evidence summary.
- Chain-of-custody JSONL, KML, and GeoJSON exports for investor and technical review.

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




