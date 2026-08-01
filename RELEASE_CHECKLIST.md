# Release checklist

Use this checklist for every beta, release candidate, and stable release. A
source review, a Vercel success badge, or a package built from an unverified
checkout is not release evidence.

## 1. Establish the candidate

- [ ] Work from a clean checkout of the intended commit on Node 24.x and
  npm 11.12.1.
- [ ] Confirm `git rev-parse HEAD`, version, target, and generated build
  metadata agree.
- [ ] Review the complete dependency and lockfile diff.
- [ ] Confirm `PROJECT_STATUS.md`, `CHANGELOG.md`, administrator guidance, and
  known limitations describe this candidate.
- [ ] Freeze feature changes until qualification is complete.

## 2. Run the required gate

```powershell
$releaseSha = git rev-parse HEAD
npm ci
npm run verify:ci
npm run build:windows
npm run build:info -- --target windows --sha $releaseSha
npm run build:mobile
npm run build:info -- --target mobile --sha $releaseSha
npm run build:classroom
npm run build:info -- --target classroom --sha $releaseSha
npm run assert:bundles
npm run assert:fixtures
npm run assert:target-parity
npm run assert:training-scope
npm audit --audit-level=high
```

- [ ] Coverage meets the configured minimums: 50% statements, 50% lines,
  40% functions, and 40% branches.
- [ ] Mobile, Windows, and Classroom artifacts contain the expected target and
  exact Git SHA.
- [ ] Target-parity evidence covers terrain, buildings, thermal detection,
  safety decisions, final drone state, score, event chain, and replay hash.
- [ ] The tracked worktree remains clean after the gate.

## 3. Beta promotion

- [ ] CI passed on the exact `main` SHA.
- [ ] Production promotion was triggered by that successful CI run, not by a
  direct Vercel Git deployment.
- [ ] `/build-info.json` on all three public aliases reports the exact SHA and
  target.
- [ ] Windows, Mobile, Classroom home, coordinator sign-in, and join entry
  render without console or CSP errors.
- [ ] Release notes do not claim a signed classroom installer or completed
  institution pilot.

## 4. School-pilot release candidate

- [ ] `npm run package:classroom` produces the NSIS installer from the verified
  SHA.
- [ ] The installer and executables are signed by the organization certificate.
- [ ] SHA-256 checksums, SBOM, third-party notices, provenance attestation, and
  release notes accompany the package.
- [ ] A clean Windows instructor machine installs, provisions, rotates, resets,
  and uninstalls successfully.
- [ ] A second Windows machine trusts only the generated public school-local
  CA certificate and connects over HTTPS/WSS.
- [ ] A real two-machine class passes join, reconnect, command, archive,
  shutdown, and restart checks.
- [ ] Synthetic testing covers 40 students, connection/message limits, storage
  quota, retention pruning, and warning behavior.
- [ ] No graded class can start over insecure LAN transport.
- [ ] Public demo proves 30-minute wall, 10-minute idle, and 15-minute
  read-only debrief behavior without interrupting active recovery/export.
- [ ] Classroom config enforces 30-180 minutes (60 default), rejects late
  joins, and preserves instructor monitoring and archives after expiry.
- [ ] Guest attempts to create, import, load, or start a custom mission fail at
  both UI and mission-control boundaries.
- [ ] Classroom rosters use pseudonyms and seven-day browser/relay retention
  is verified with clock-controlled tests.

## 5. Agency-training scope gate

- [ ] Every UI and export labels the product and results as training-only.
- [ ] “High-fidelity” always includes the documented training/model-envelope
  qualifier.
- [ ] Digital-twin, FAA-compliance/approval, real-mission-validation,
  safe-route, guaranteed-obstacle-avoidance, evidence/forensic-grade,
  complete-chain-of-custody, tamper-proof, and full-compliance claims are
  absent from permitted UI, exports, documentation, demos, and marketing.
- [ ] No runtime or build configuration can enable an operational mode.
- [ ] No aircraft-control, live-aircraft, or external aviation/dispatch/camera/
  weather connector is present in a shipping bundle.
- [ ] Scripted authorization, Remote ID, airspace, and traffic surfaces remain
  clearly marked as training exercises.
- [ ] Independent aviation-training, security, privacy, accessibility, and
  human-factors reviewers approve the exact candidate.

## 6. Stable technical baseline

- [ ] All release-candidate pilot defects are closed and regression-tested.
- [ ] Supported browser/Windows matrix and accessibility review are recorded.
- [ ] Privacy, retention, administrator recovery, incident response, and
  institutional deployment guidance have named owners.
- [ ] Production branch protection and required checks are effective.
- [ ] The stable tag, signed artifact, checksums, SBOM, and deployed web SHA
  refer to the same source revision.

## External blockers

The repository cannot procure a Windows organization code-signing certificate,
install a school CA on managed student devices, approve school policy, or
perform an independent accessibility/security assessment. RC or stable
promotion remains blocked until an authorized owner supplies evidence for
those items.
