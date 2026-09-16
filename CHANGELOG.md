# Changelog

This project follows semantic versioning for published artifacts. Dates use
ISO 8601.

## Unreleased — v1.1 closure

### Added

- Canonical asynchronous terrain preparation and cross-target deterministic
  parity qualification.
- Relay-owned instructor sessions, credential migration, classroom protocol
  v2, fingerprint-pinned join links, and bounded backup handling.
- Persistent 3072-bit RSA school-local CA generation, renewable LAN leaf
  certificates, secure-default HTTPS/WSS relay startup, Electron certificate
  fingerprint pinning, and a copyable QR join surface.
- Exact version/target/Git-SHA build metadata for all three targets.
- Fatal coverage, parity, fixture, bundle-isolation, and dependency-audit
  release gates.
- Security, classroom administration, privacy/retention, incident-response,
  accessibility, release, and third-party documentation.
- Windows classroom packaging, signing, checksums, SBOM, and provenance
  workflow scaffolding.
- Agency training-assurance claim gate across preflight, readiness, classroom,
  scorecards, and after-action reports.

### Changed

- Standard development and CI runtime moves to Node 24.x and npm 11.12.1.
- Mobile uses the same terrain fixtures and simulation inputs as Windows and
  Classroom while retaining its lighter 2D presentation.
- Instructor/account persistence is fail-closed: decrypted account keys are
  memory-only, and legacy encrypted data migrates after successful sign-in.
- Production promotion is gated on successful CI for the exact `main` SHA.
- The product contract is agency training only. Live-aircraft and external
  aviation connectors are out of scope, and operational claims are
  mechanically prohibited.

### Security

- High-severity dependency findings block qualification.
- Classroom administration, WebSocket origin/payload/rate limits, Electron
  navigation/permissions, browser headers, and classroom backup retention are
  hardened for the school-pilot boundary.

### Release status

**Beta — 2026-09-15 — web targets at `cb6833c`.**
The `RELEASE_CHECKLIST.md` §3 web beta gate is met for all three public
targets:

- CI passed on the exact `main` SHA `cb6833c3b9ac34f98c03a1634549e4ce30f4a0e6`.
- Production promotion was performed by the verified `workflow_run` promotion
  workflow off that successful CI run, not by a direct Vercel Git deployment.
- `/build-info.json` reports the exact SHA and target on every alias:
  - Windows — https://autonomous-drone-simulator.vercel.app (`target=windows`)
  - Mobile — https://autonomous-drone-simulator-mobile.vercel.app (`target=mobile`)
  - Classroom — https://autonomous-drone-simulator-classroom.vercel.app (`target=classroom`)
- The promotion's rendered-mount, security-header, and CSP smoke checks passed
  for all three targets.

Not yet done, and not claimed by this beta: no signed Windows classroom
installer, no completed institution pilot, and no release-candidate or stable
artifact. The independent licence service (`RELEASE_CHECKLIST.md` §4) is not
promoted — its `production-licensing` environment still needs an
administrator-provided `DATABASE_URL` secret. RC and stable promotion remain
blocked on the external items in `PROJECT_STATUS.md`.

No further entry means an RC or stable artifact has been published. Record the
release date, tag, exact SHA, deployment proof, and signed artifact links only
after completing `RELEASE_CHECKLIST.md`.

## 1.0.0 — 2026-07-02

- Initial public portfolio release of the deterministic multi-drone mission
  simulator.

Substantial scenario, realism, mobile, account, tactical-command, and classroom
work landed after this tag. The old `v1.0.0` Windows ZIP is not a package of
the current v1.1 closure code.
