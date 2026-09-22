# Project status

Status date: 2026-09-22
Release line: `main`. The **v1.1 web beta is published** and all three public
targets are promoted automatically from `main` by CI. Do not trust a SHA quoted
here — it goes stale on the next merge. Run `npm run deploy:status` for the
live answer; it reads `/build-info.json` from each public target and reports how
that SHA relates to `origin/main`. At this status date the three targets served
`24a274b` while `main` was at `0e380ea`, which is the healthy steady state:
production tracks the last CI-verified SHA and follows one promote behind a
fresh merge.

This is a local-first, high-fidelity agency drone-training platform with a
shared, fail-closed training-assurance architecture for classroom and Windows
pilot builds. Repository fixtures remain synthetic/recorded and do not
command aircraft or connect to operational FAA, LAANC, USS/UTM, Remote ID,
dispatch, camera, weather, or aircraft-telemetry services.

> **Direction (2026-09-16): this build is maintained as a portfolio/demo
> flagship at the live web beta.** Release-candidate and stable promotion are
> **not currently being pursued** — they depend on external inputs the
> repository cannot supply itself (an organization Windows code-signing
> certificate, a real school pilot with two-machine and 40-student load, an
> administrator-provided licence-service `DATABASE_URL` secret, and independent
> security/accessibility assessment; see "External blockers"). Ongoing work is
> hardening, cleanup, and quality polish of the shipped product rather than
> advancing the release ladder. The RC/stable sections below remain accurate as
> the path that *would* be taken if that decision changes.

> Canonical sources of truth are the tracked documents only: this file,
> README.md, CHANGELOG.md, SECURITY_THREAT_MODEL.md, and docs/. Ignored local
> files (HANDOFF.md, PROJECT_PLAN.md, START_HERE.md, TASKS.md) and locally
> built packages under outputs/ are non-canonical, may hold older state, and
> are labeled as such in place (audit F-13).

## Implemented product

| Area | Current repository capability |
|---|---|
| Scenarios | 25 incident missions plus 6 NIST-inspired skills drills |
| Simulation | Seeded fixed-timestep multi-aircraft missions, safety decisions, replay, and hash-chained evidence |
| Realism | Frozen terrain, building, weather, airspace, thermal, SAR, GNSS, RF, turbulence, and battery fixtures/models for covered scenarios |
| Operations | Preflight, launch/recovery planning, route editing, suggestions, retasking, hover/divert/resume/RTB, OPS HUB, after-action review |
| Targets | Separate Mobile, Windows web, and Classroom client builds using one simulation contract |
| Accounts | Browser-local encrypted profiles, runs, custom missions, backups, and classroom history |
| Classroom | Instructor/student roles, HTTPS/WSS local relay, persistent school-local CA and renewable leaf, encrypted protocol-v3 messages, fingerprint-pinned join URL/QR, coordinator wall, commands, scoring, and archives |
| Evidence | Replay, JSONL chain, KML, GeoJSON, reports, and after-action exports |
| Assurance | Training-envelope evaluator, mechanically prohibited operational claims, geographic-familiarization acknowledgement, and assurance state in preflight/readiness/classroom/reports |
| Licensing | Public-demo wall/idle/debrief windows; evaluation/pilot expiry channels; 30-180 minute classroom schedule |

The mobile presentation intentionally omits desktop 3D extrusion, but may not
omit simulation fixtures or produce different mission math.

## v1.1 closure objective

The current branch is a qualification and hardening line:

1. **Beta:** green web gate, identical target simulation behavior, no
   high/critical dependency findings, exact deployed-SHA proof, and current
   documentation.
2. **Release candidate:** signed Windows classroom installer, relay-enforced
   instructor authorization, trusted HTTPS/WSS school LAN, and a real
   two-machine pilot smoke.
3. **Stable technical baseline:** pilot defects closed, production controls
   enforced, and training/privacy/accessibility evidence complete.

No phase is complete merely because its source exists. Promotion requires the
evidence in `RELEASE_CHECKLIST.md`.

## Open qualification blockers

- Host-side CA/leaf generation, HTTPS/WSS serving, Electron certificate
  fingerprint pinning, and secure-default CLI wiring are implemented. Managed
  installation of the generated public CA certificate on student Windows
  profiles is not
  automated or proven.
- Organization code-signing, a trusted two-machine TLS smoke, 40-student load,
  and institutional accessibility/security evidence remain unproven.
- Operational modes and live-aircraft/external aviation connectors have been
  removed from the product contract. Every build remains training-only.
- Production Deploy Hook secrets and the `production-*` environments are
  configured and exercised: four consecutive unattended promotions succeeded on
  2026-09-22 (`f19078e`, `9a73b15`, `24a274b`, `0e380ea`).
- A local gate result does not qualify beta until the same SHA passes CI and
  all three public aliases serve matching build metadata.

## Required release evidence

- Clean Node 24.x/npm 11.12.1 install.
- Typecheck, expanded lint, full tests, and configured coverage thresholds.
- Explicit Windows, Mobile, and Classroom builds.
- Bundle isolation, realism fixture budgets, and deterministic target parity.
- Fatal high/critical dependency audit.
- Version, target, and exact Git SHA in every artifact and deployment.
- Clean tracked worktree.

The CI workflow applies these gates. Production promotion checks out the exact
successful `main` SHA and verifies `/build-info.json` after deployment.

### Promotion stall, 2026-09-17 to 2026-09-22 (resolved)

Recorded because the failure was silent and the repository looked healthy
throughout. Two settings combined into a total stall:

1. `production-windows`, `production-mobile` and `production-classroom` each
   carried a **required-reviewer** rule, so every promotion waited on a manual
   approval. Run `35276994011` (`5890dfc`) entered `waiting` on 2026-09-17 and
   was never approved.
2. `deploy.yml` set `concurrency.cancel-in-progress: false`. A promote run holds
   the `vercel-production` group until it finishes, and GitHub keeps only one
   queued run per group — so the run that never finished wedged the pipeline and
   each new arrival cancelled the previously queued one.

Net effect: seven cancelled runs, one permanently `pending`, and no promotion
for five days. Production was kept current by hand with `vercel alias set`
against a Ready preview build, which is why the public targets served a
preview-branch SHA (`27f06c8`) rather than a `main` commit while every tracked
document described the CI path as the only route.

Resolved 2026-09-22: the wedged runs were cancelled, the required-reviewer rules
were removed from the three `production-*` environments (their `main`-only
branch restriction is retained), and `cancel-in-progress` is now `true` so a
stalled run fails fast instead of accumulating. The promote job's own
verification — exact SHA, target identity, security headers, CSP, and a headless
render check that the application mounted — is unchanged and remains the real
gate.

The durable lesson is the reason `scripts/live-status.mjs` exists: a deployment
claim in a document cannot be checked, and this one was wrong for five days
without anything failing. `npm run deploy:status` makes the truth cheaper to get
than the guess.

## External blockers

Repository implementation cannot complete these on its own:

- organization Windows code-signing certificate and protected signing secrets;
- installation of the approved school-local CA on managed student devices;
- real two-machine school-network testing and a supervised 40-student load;
- school privacy/retention/incident-response authorization;
- independent security and accessibility assessment;
- GitHub/Vercel administrator changes for branch protection and any further
  environment policy. Deployment secrets, the protected `production-*`
  environments, and the suppression of unverified promotion (Vercel git
  auto-deploy is disabled in `vercel.json`) are configured and working as of
  2026-09-22; branch protection on `main` remains administrator-owned.

These block release-candidate or stable promotion even if all local tests pass.

## Deliberately deferred

- Recorded public-traffic fixture WP-12 until an approved deterministic source
  is available.
- New scenarios and major feature epics.
- Cloud accounts/synchronization.
- Real aircraft, regulatory, dispatch, camera, weather, Remote ID, or
  emergency-service integrations; these are outside the approved product scope.
- Full thermal image generation and absolute-temperature mapping.

## Residual product limitations

- Browser accounts are origin/device local; password loss can make encrypted
  data unrecoverable.
- Map tiles are network dependent; the fallback is tactical, not geographic.
- Replay and browser storage are bounded and are not operational flight-data
  recording.
- Scenario provenance depth is not uniform across all 31 missions.
- Student identity remains supervised classroom roster identity, not an
  external identity-provider assertion.
- Local encryption cannot protect a compromised or unlocked endpoint.
- Institution readiness still depends on deployment, policy, accessibility,
  support, and pilot evidence outside the codebase.

## Canonical project documents

- `README.md` — public product and developer orientation
- `docs/WORKING_RULES.md` — repository invariants and working contract
- `RELEASE_CHECKLIST.md` — beta, RC, and stable promotion evidence
- `SECURITY_THREAT_MODEL.md` — assets, boundaries, protections, and residual risk
- `CLASSROOM_ADMIN.md` — local classroom administration
- `DATA_PRIVACY_RETENTION.md` — data inventory and retention process
- `INCIDENT_RESPONSE.md` — containment and recovery
- `ACCESSIBILITY.md` — current assurance boundary and required assessment
- `CHANGELOG.md` — release delta and publication status
- `THIRD_PARTY_NOTICES.md` — direct components and release notice process
