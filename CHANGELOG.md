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

No entry above means a beta, RC, or stable artifact has been published. Record
the release date, tag, exact SHA, deployment proof, and signed artifact links
only after completing `RELEASE_CHECKLIST.md`.

## 1.0.0 — 2026-07-02

- Initial public portfolio release of the deterministic multi-drone mission
  simulator.

Substantial scenario, realism, mobile, account, tactical-command, and classroom
work landed after this tag. The old `v1.0.0` Windows ZIP is not a package of
the current v1.1 closure code.
