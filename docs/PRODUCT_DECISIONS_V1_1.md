# Approved v1.1 product decisions

Approved by the legal publisher/product owner on 2026-07-31.

1. Release target is a controlled agency classroom pilot with the shared training-assurance core also present in Windows pilot builds.
2. Battery action uses the earliest confirmed percentage, loaded-voltage, or energy-to-home reserve; invalid battery state is conservative and hard critical voltage triggers emergency behavior.
3. Lost link is scenario-configurable; default is short hold, validated RTB, then modeled emergency landing. Continue requires explicit acknowledgement.
4. Unknown required training terrain/airspace blocks training modes that declare those fixtures. Geographic familiarization may continue only with explicit acknowledgement and never produces a real-world safety or validation result.
5. Historical proxy weather is allowed only with visible proxy labels and preserved source/time/location differences; never claim exact reconstruction.
6. Twenty feet is a modeled emergency surface threshold only; real clearance is dynamic and risk-based.
7. One to four aircraft is ordinary. Five to eight is an advanced supervised multi-crew exercise with additional separation doctrine.
8. Custom missions distinguish synthetic training from real-coordinate familiarization; neither becomes operational merely from coordinates.
9. The current surface is “Scripted Airspace & Traffic.” Recorded public traffic remains post-pilot and is not UTM.
10. Individual mission import is required: untrusted, versioned, 256 KB maximum, fully validated, previewed, ID-regenerated, duplicate-rejected, no-overwrite, and atomically quota-limited.
11. Guests may never create, import, edit, validate, load, or run custom missions.
12. 20x is not an account default, is absent from classroom, is unassessed solo/replay only, and auto-slows on emergency.
13. The official device/accessibility matrix is in `SUPPORTED_PLATFORMS.md`.
14. Classroom rosters use pseudonyms. Institution owns records; instructor is custodian. Training records have a seven-day application default unless explicitly exported under institution policy.
15. Logan Lewis-Whitfield is legal publisher/code-signing owner. Schools own local CA trust lifecycle. The app never silently installs a root CA; production signing keys must not be loose PFX files.
16. Superseded by decision 22. Classroom simulation traffic remains school-LAN-local, but selected-evaluator and agency-pilot Windows hosts require publisher-service activation and a signed entitlement refresh at least once every 72 hours.
17. Logs are minimum/local by default. No external analytics or automatic uploads. Support material must redact secrets, direct identifiers, full IPs, and exact coordinates.
18. Superseded: the approved product is agency training software only. “High-fidelity” is permitted only as “high-fidelity training simulation within the documented deterministic model and frozen-fixture envelope.” Digital-twin, FAA-compliance, real-mission-validation, safe-route, guaranteed-obstacle-avoidance, evidence/forensic-grade, complete-chain-of-custody, tamper-proof, and full-compliance claims are prohibited in every mode.
19. Publisher-operated Vercel demos are authorized. Public demo: 30-minute wall, 10-minute idle, 15-minute read-only debrief. Licensed Windows durations are governed by decision 22. Classes: 30-180 minutes, 60 default. Expiry does not delete records or interrupt monitoring/recovery/logging/export.
20. Licensing implementation work is isolated on `codex/evaluator-demo-licensing`. The release candidate must be a clean reviewed commit merged to `main`; only after service deployment and qualification may that exact merged revision receive annotated tag `v1.1.0-rc.1` and signed/provenance-attested artifacts.
21. Live aircraft feeds, aircraft-control links, and external aviation/dispatch/camera/weather connectors are outside the approved product scope. The only live connection is the private classroom relay between simulator clients.
22. Selected-evaluator Windows licences run 14 days from successful activation; explicitly promoted agency/classroom pilots run 90 days. One code binds one Windows device and activating account, authorizes one concurrent class of at most 40 students, permits one publisher-approved transfer without extending the original expiry, and requires trusted entitlement renewal every 72 hours. Unused codes expire after 30 days. Students never redeem product codes. Expiry preserves debrief, recovery, records, diagnostics, and exports.
