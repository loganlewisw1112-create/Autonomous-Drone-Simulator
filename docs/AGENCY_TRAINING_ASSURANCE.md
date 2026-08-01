# Agency training assurance and permitted claims

## Product boundary

This product is a high-fidelity **training simulator** for agency drone teams.
It does not connect to aircraft, ingest live aircraft feeds, control vehicles,
submit aviation authorizations, or validate real missions. The classroom relay
connects instructor and student simulator clients only.

Every runtime mode remains inside that boundary:

| Mode | Purpose | Real-world authority |
|---|---|---|
| Synthetic training | Deterministic skills and incident exercises | None |
| Recorded training replay | Review an application-generated training run | None |
| Agency training exercise | Run a documented frozen-fixture exercise | None |
| Geographic familiarization | Place a fictional exercise around user-entered coordinates | None |

The shared evaluator lives in `src/assurance/trainingAssurance.ts`. Training
assurance appears in preflight, readiness, classroom setup, scorecards, and
after-action exports. Missing declared training inputs fail closed for the
affected training mode.

## Permitted language

The following claim is permitted only with its qualifier intact:

> High-fidelity training simulation within the documented deterministic model
> and frozen-fixture envelope.

“Repeatable assessment” is permitted only when the same scenario revision,
seed, inputs, scoring rules, and simulator revision are used. “Tamper-evident”
describes an application event record only when its exported hash chain
verifies; it never means tamper-proof or forensic-grade.

## Prohibited language

The product, UI, exports, sales material, demonstrations, and support responses
must not claim or imply:

- digital twin;
- FAA compliant, FAA approved, or full compliance;
- validation of real missions;
- a safe route for flight;
- guaranteed obstacle avoidance;
- evidence-grade or forensic-grade evidence;
- a complete chain of custody; or
- tamper-proof records.

No configuration flag may enable those claims. Adding live-aircraft,
FAA/LAANC/USS/UTM, Remote ID, dispatch, camera, or weather connectors is outside
the approved product scope.

## Model limits operators must see

- Twenty feet is a modeled emergency surface threshold, not a regulatory or
  recommended real-world obstacle-clearance minimum.
- Four hundred feet is a simulator input ceiling, not an operation-specific
  authorization.
- Terrain, buildings, airspace, weather, GNSS, RF, traffic, and aircraft
  behavior are frozen or synthetic exercise inputs whose coverage and age vary.
- Scripted Airspace & Traffic is fictional exercise traffic, not UTM or a live
  situational-awareness service.
- Historical scenarios are reconstructions or proxy-supported exercises, not
  exact reproductions of incident conditions.
- Multi-aircraft separation values are training doctrine, not regulatory
  separation minima.

## Agency retention loop

The durable product loop is: instructor assigns a repeatable scenario,
operators practice under the same conditions, the application records scores
and replay, the team conducts a structured debrief, and the instructor assigns
the next drill based on demonstrated gaps. Retention depends on useful exercise
libraries, comparable assessments, fast classroom setup, local/offline
reliability, and trustworthy exports—not operational-aircraft integration.
