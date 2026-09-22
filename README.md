# Autonomous Drone Mission Simulator

**A training simulator for coordinating fleets of search-and-rescue drones — entirely simulated, and never connected to a real aircraft.**

This is a web-based (and optional Windows classroom) tool for practicing supervised, multi-drone public-safety missions: plan a search, run a preflight, launch a fleet, retask aircraft mid-mission, "detect" survivors, recover, replay the whole thing, and export a record. Everything happens in a simulation. It does **not** connect to aircraft, air-traffic systems, Remote ID, dispatch, or cameras, and it is **not** for real flight, real emergencies, or regulatory use.

![Animated coastal search-and-rescue mission: tactical map, fleet, telemetry, and route suggestions.](docs/media/readme/hero-live-workflow.gif)

| Try it | Link |
|---|---|
| Mobile web | [Launch Mobile](https://autonomous-drone-simulator-mobile.vercel.app/) |
| Desktop web | [Launch Windows](https://autonomous-drone-simulator.vercel.app/) |
| Classroom demo | [Open Classroom](https://autonomous-drone-simulator-classroom.vercel.app/) |

## Why it's interesting

Two ideas drive the whole project.

**It's deterministic.** Run the same scenario with the same inputs and you get the exact same mission, every time — same weather, same detections, same outcome — down to a hash-chained record you can replay and audit. That makes it a genuine *training* tool: instructors can compare runs fairly, and a student's mission can be reviewed move by move.

**It's honest about what it is.** Nothing here touches a real aircraft or real airspace, and the code goes out of its way to say so — the "regulatory," airspace, and traffic layers are clearly labeled training props, not the real thing. A build being publicly reachable is never treated as proof it passed a release gate.

## What it does

- **31 scenarios** — 25 incident missions (coastal and mountain search-and-rescue, wildfire, floods, and historical disasters like Camp Fire and Surfside) plus 6 skills drills inspired by NIST test methods.
- **Command a fleet** — run three to eight aircraft at once: plan routes, manage launch and recovery sites, retask, hover, divert, resume, recharge, and return to base.
- **Realistic conditions** — each scenario ships with frozen weather, terrain, airspace, GNSS, thermal, and battery inputs, so runs are repeatable rather than random.
- **A full record** — every mission produces a tamper-evident event log plus KML, GeoJSON, replay, and after-action exports.
- **Runs anywhere, consistently** — mobile web, desktop web, and the classroom app may look different, but they run the identical simulation math.
- **Private by default** — accounts are stored locally in your browser with password-derived encryption; nothing syncs to a server.
- **A connected classroom (optional)** — a Windows instructor host runs a secure local relay that students join from browsers on the school network.

> The six skills drills are educational simulations — not official NIST apparatus, certification, or a standards claim.

## Try it locally

Requires Node.js 24.x and npm 11.12.1.

```bash
npm ci
npm run dev
# open http://127.0.0.1:5173/  (add ?map=fallback if map tiles are unavailable)
```

---

## Under the hood

*Engineering detail below; the overview above is the short version.*

**Determinism and architecture.** Once a scenario's terrain is prepared, the simulation loop is fixed-timestep and synchronous. Missing declared terrain blocks launch rather than silently substituting a flat surface. Presentation targets (mobile, desktop, classroom) may differ in layout and 3D rendering, but the simulation modules, scenario data, scoring, events, and replay hashes may **not** vary by target — an artifact-parity harness enforces that boundary. Scenario inputs are frozen at author time; the runtime never fetches live weather, airspace, terrain, or incident data. Canonical scenario IDs live in `src/scenarios/scenarioManifest.ts`. See [Architecture notes](docs/ARCHITECTURE_NOTES.md), [Working rules](docs/WORKING_RULES.md), and the [Realism roadmap](docs/REALISM_ROADMAP.md).

**The classroom host.** For licensed Windows-host development:

```bash
npm ci
npm run classroom:desktop
```

The host owns the local relay and shutdown lifecycle. It generates a persistent 3072-bit RSA school-local certificate authority plus a renewable LAN leaf certificate, serves HTTPS/WSS, and pins its own loopback relay by fingerprint. It rejects insecure non-loopback traffic by default, and it does **not** install its CA onto student machines — administrators must deploy the exported CA through their own managed process. Message encryption protects sealed student/instructor content but not network metadata (addresses, timing, sizes). A public classroom installer is deliberately not promoted until CA trust and a real two-machine HTTPS/WSS test are proven, a Windows code-signing certificate is supplied, and the signed release checklist passes. See [`docs/EVALUATOR_LICENSING_RUNBOOK.md`](docs/EVALUATOR_LICENSING_RUNBOOK.md), [CLASSROOM_ADMIN.md](CLASSROOM_ADMIN.md), [SECURITY_THREAT_MODEL.md](SECURITY_THREAT_MODEL.md), and [DATA_PRIVACY_RETENTION.md](DATA_PRIVACY_RETENTION.md).

**Verification.** Every deployed target exposes its version, target, and Git SHA at `/build-info.json`; use those when reporting a verified release. To answer "is my change actually live?" without inferring it from build scripts, ask the deployments directly:

```powershell
npm run deploy:status            # fetches /build-info.json from all three targets
```

It prints each target's deployed version and SHA and how that SHA relates to `origin/main` — including the common case where a deployed SHA is a pre-squash branch commit whose content is identical to `main`. The full gate, from a clean checkout:

```powershell
$releaseSha = git rev-parse HEAD
npm ci
npm run verify:ci                 # types, lint, full test suite, coverage thresholds
npm run build:windows;  npm run build:info -- --target windows  --sha $releaseSha
npm run build:mobile;   npm run build:info -- --target mobile   --sha $releaseSha
npm run build:classroom;npm run build:info -- --target classroom --sha $releaseSha
npm run assert:bundles && npm run assert:fixtures && npm run assert:target-parity && npm run assert:training-scope
npm audit --audit-level=high
```

`assert:target-parity` compares deterministic output across targets; `assert:training-scope` rejects any reintroduction of real operational modes. Don't call the gate green unless every command passed for the exact reported SHA — current state and known blockers live in [PROJECT_STATUS.md](PROJECT_STATUS.md).

**Deployment.** Production promotion is designed to run only after CI succeeds on the exact `main` SHA: CI qualifies the code and builds all three targets, the workflow confirms `main` still equals that SHA, protected Vercel deploy hooks build the revision, and the workflow verifies `/build-info.json` on every public alias. Tagged Windows releases re-run the full gate, require signing credentials, and produce checksums, an SBOM, and provenance attestation. See [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) and the [Windows signing runbook](docs/WINDOWS_SIGNING_RUNBOOK.md).

This is the *only* promotion path. There is no GitHub Pages deployment — `npm run deploy` is retired and now fails with a pointer, because a stale `gh-pages` script in `package.json` had previously been mistaken for the real mechanism. Vercel's own git auto-deploy from `main` is deliberately disabled in [`vercel.json`](vercel.json) so a push cannot reach production without passing CI first.

## Safety, privacy, and limitations

- **Not for real use.** This is not certified or intended for real aviation, public-safety, dispatch, regulatory, or emergency operations. Regulatory, Remote ID, and airspace/traffic surfaces are scripted training layers in every build. No mode creates real data connections, FAA authorization, route-safety proof, obstacle-avoidance guarantees, or forensic evidence. See [Agency training assurance](docs/AGENCY_TRAINING_ASSURANCE.md).
- **Modeling, not reality.** Thermal behavior models detection constraints; it does not produce real radiometric imagery. Replay storage is bounded and is not a flight-data recorder.
- **Local encryption has limits.** It does not protect an unlocked device, a compromised browser, a malicious extension, screen capture, a keylogger, or an exported plaintext file.
- **Classroom prerequisites.** The optional host still requires an approved private network, managed CA installation, a retention policy, an administrator owner, and a supervised roster.
- **No external attestations.** Repository tests do not imply an independent penetration test, accessibility certification, or legal-compliance review.
- Map tiles normally come from a third party and may expose ordinary request metadata to that provider.

More detail: [Security threat model](SECURITY_THREAT_MODEL.md), [Data privacy and retention](DATA_PRIVACY_RETENTION.md), [Incident response](INCIDENT_RESPONSE.md), [Accessibility status](ACCESSIBILITY.md).

## License

Publicly viewable under a source-available proprietary [LICENSE](LICENSE) — this is not open source. Third-party components keep their own licenses.
