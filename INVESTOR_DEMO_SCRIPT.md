# 3-Minute Demo Path

The one product demo for investors, agencies and instructors. It replaces the July 2026 investor
script (pitch review k2). That script named a demo-mode toggle that no longer exists, pointed at
"compliance" and "where real integrations would attach", and was written before 31 scenarios,
terrain, the thermal-hold cue and the readable after-action report.

Every control named below is the exact on-screen label in the current build. The product is a
training simulator: no real aircraft, airspace, authorization or flight data, and no score here is
a standards or compliance result. Say it that way.

## Before you start (not on the clock)

- **Demo from a local build** so the public demo's 30-minute session wall and 10-minute idle cut-off
  can't interrupt you:

  ```bash
  npm ci
  npm run dev
  ```

  Open `http://127.0.0.1:5173/` on a Windows or Mac desktop browser at 1080p or larger.
- Use a fresh browser profile (or clear site data) so the welcome card appears.
- The backup is a recorded take of the same path (pitch-review item e4).

## The path

| Time | Do | Say |
|---|---|---|
| 0:00 | The welcome card is on screen. | "Drone programs train supervisors in classrooms. This is the practice layer: one person running several drones through a real-place incident, then reviewing what happened." *(Placeholder: replace this line with the welcome card's who-it's-for line once item c3 lands; c3 waits on the lead-direction decision d2.)* |
| 0:15 | Click **▶ LAUNCH DEMO**. | "One click: the fleet plans launch bays, staggers takeoff and flies its routes over real terrain and weather." |
| 0:45 | Point at the mission feed and the drones flying their tracks. | "Everything is deterministic. The same scenario and seed give the same flight, so a class or an agency can compare runs fairly." |
| ~1:00 | A drone stops on a heat source and the banner **Thermal contact — … is holding for you.** appears. Click **Show thermal view**. | "This is the decision point the simulator trains: a drone found something and is waiting for the operator." |
| 1:15 | On the map's **◉ THERMAL CONTACT** panel, click **⬆ Dispatch**. *(Or **✗ False Pos** if you want to show a dismissal.)* | "The ground unit drives the actual road network, so its arrival time is real, not a straight line." |
| 1:45 | Let the unit run for a few seconds, then click **■ END MISSION**. | "Now the part trainers actually buy: the debrief." |
| 2:00 | In the replay bar, click **VIEW REPORT**. | "A one-page after-action report: summary, timeline, map tracks, scores, and a check that the event log hasn't been altered." |
| 2:30 | Click **Download report (HTML)**, or **ENTER REPLAY** and scrub. | "It works offline and it's a file the instructor keeps. Replay lets you rewind to the decision and ask what you'd do differently." |
| 2:50 | Close. | "That's one person, about three months, 31 scenarios. What I'm looking for is the agencies and instructors who'd pilot it." |

Grading: the A–F band currently appears only in a live classroom session, not after a solo run
(pitch-review item c6, waiting on an owner decision). Don't promise it in the solo demo.

## If asked

- **"Is this certified / compliant / FAA-approved?"** No. It is a training simulator. The flight
  limits on screen are the simulator's own training limits, and the lane score uses a rubric
  modelled on the NIST sUAS test methods. It is not an official NIST, NFPA or ASTM evaluation.
- **"Is it autonomous?"** The drones fly planned routes under operator supervision. The operator
  makes the decisions, which is the skill being trained.
- **"Where does the data come from?"** Terrain, weather, FAA ceilings and building footprints are
  real, cited public data, and authorization is simulated. See
  [`docs/REALISM_DEMO_SCRIPT.md`](docs/REALISM_DEMO_SCRIPT.md) for the fidelity walkthrough.
- **"How was it built?"** See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md), the build-story
  narration.

## After the take

Click **DEMO RESET** in the control bar before the next audience.
