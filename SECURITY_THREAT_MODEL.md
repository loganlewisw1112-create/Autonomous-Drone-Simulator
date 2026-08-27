# Security threat model

Last reviewed: 2026-07-27

## Scope and assurance boundary

This model covers the browser targets, local browser storage, optional Windows
Electron classroom host, LAN relay, build pipeline, and release artifacts. It
does not certify Vercel, a school network, endpoint-management tools, browser
extensions, users, or the operating system.

The product is simulation-only. It is not safety-critical avionics, a
command-and-control system, an identity provider, or a regulated
student-information system. Repository tests are not a penetration test or
compliance attestation.

## Assets and trust boundaries

Protected assets include account passwords and decrypted session keys,
instructor credentials/sessions, process administrator token, classroom
private keys, classroom roster/results, mission history, exports, signing
credentials, deployment credentials, and the school-local CA/leaf private
keys.

Primary boundaries:

1. browser JavaScript ↔ memory ↔ IndexedDB;
2. student browser ↔ HTTPS/WSS LAN ↔ relay ↔ instructor browser;
3. Electron renderer ↔ schema-validated preload IPC ↔ main process/relay;
4. local administrator ↔ loopback-only administration endpoints;
5. source/lockfile ↔ CI ↔ signed installer and three web deployments;
6. Electron main ↔ independent publisher licence API ↔ managed PostgreSQL;
7. application ↔ third-party map/style/tile provider.

## Security controls

### Accounts and stored records

- Password-derived account keys use PBKDF2-HMAC-SHA-256 with 310,000
  production iterations and random salts.
- Versioned AES-256-GCM records bind record identity/type through additional
  authenticated data.
- Legacy records migrate transactionally after successful authentication;
  corrupt or misbound data rolls the migration back and opens the account
  read-only/exportable with an explicit warning.
- Decrypted account keys remain in memory. Legacy persisted session-key
  material is removed at startup; closing/reloading requires sign-in.

### Instructor authority

- The relay, not browser UI state, authorizes class creation.
- Instructor credentials use a versioned scrypt verifier with random salt.
- Instructor sessions are opaque, time-limited, `HttpOnly`, and
  `SameSite=Strict`.
- Provision, rotation, and reset require a random process administrator token
  and loopback access.
- Verification attempts are limited per source and globally.
- Rotation/reset revokes instructor sessions, room tokens, and active classes.
- Plaintext legacy recovery material is removed only after atomic verifier
  migration succeeds.

### Classroom protocol and transport

- Protocol v3 (`PROTOCOL_VERSION = 3`, `src/classroom/protocol.ts`) uses X25519,
  HKDF-SHA-256, and AES-256-GCM. The relay enforces the same version
  (`server/classroom.mjs`) and rejects envelopes carrying any other value.
- Key derivation and authenticated context bind version, class, direction,
  message type, and both session public keys.
- Sealed monotonic sequence values protect against replay.
- Join URLs pin the instructor-key fingerprint in the URL fragment.
- The relay rejects insecure non-loopback class creation/join by default.
- Host, WebSocket Origin, payload size, connection count, upgrade rate,
  handshake time, message rate, and command rate are bounded before classroom
  state is allocated.
- The CLI and Electron host generate a persistent 3072-bit RSA school-local CA
  and renewable LAN leaf certificate, then serve HTTPS/WSS by default.
- Electron trusts only the exact fingerprint of its owned loopback relay
  certificate. The CLI permits HTTP only when both explicit insecure
  development flags are set.
- The host creates the CA certificate file and the direct CLI prints its path,
  but the application does not install it into Windows trust stores. Managed
  student trust and a real two-machine proof remain deployment
  responsibilities.

### Relay storage and availability

- Classroom backups are ciphertext snapshots, not decrypted student payloads.
- Writes are rate-limited and atomically replace the current student/class
  snapshot.
- Closed-class retention and global quota pruning are bounded; the instructor
  receives warning events without interrupting live message forwarding.
- Class IDs and paths are validated and contained beneath the configured
  storage directory.

### Browser, desktop, build, and release

- Hosted and trusted relay responses use a restrictive CSP and standard
  framing, MIME, referrer, permission, isolation, caching, and transport
  headers.
- Electron uses context isolation, sandboxing, disabled Node integration,
  denied permissions, owned-origin navigation, and `https:`-only external
  links.
- CI enforces tests, coverage, explicit target builds, bundle isolation,
  fixture budgets, target parity, and fatal high/critical dependency audit.
- Tagged classroom releases require signing credentials and publish
  checksums, an SBOM, and provenance evidence.

### Evaluator entitlements

- Redemption codes contain at least 160 random bits and are stored only as an
  HMAC digest; plaintext is displayed once by the publisher CLI.
- Ed25519-signed leases bind tier, expiry, 72-hour offline limit, features,
  version range, class limits, and the protected installation public key.
- Electron main owns activation/refresh and Windows `safeStorage`; the renderer
  receives only a schema-validated status summary.
- The owned relay independently verifies the signed lease and requires a fresh
  main-process heartbeat before class creation, joins, or normal commands.
- Licence signing, code HMAC, database, deployment, and Authenticode secrets
  are separate credentials. No private licence secret is packaged.

## Residual threats

| Threat | Residual exposure and required treatment |
|---|---|
| Compromised endpoint | An unlocked or malicious instructor/student machine can access visible/decrypted data. Use managed accounts, patching, disk encryption, screen lock, browser controls, and endpoint protection. |
| Local CA compromise | The school-local CA could authenticate a malicious relay if its private key is stolen. Protect it with OS permissions, never copy it to students, and replace trust after suspected exposure. |
| Classroom identity | A class code and local account are not proof of legal identity. Supervise the roster and use pseudonymous identifiers where possible. |
| Metadata disclosure | TLS protects network traffic in transit, but the relay necessarily handles connection metadata and roster/routing fields. Host/device logs may retain IPs and timing. |
| Availability | Limits reduce abuse but cannot prevent Wi-Fi disruption, host failure, local denial of service, or a malicious authorized participant. |
| Browser/XSS risk | Active pages hold decrypted data. CSP reduces but does not eliminate XSS, dependency, extension, or browser compromise. |
| Recovery/data loss | Local-first encryption means forgotten passwords, cleared browser profiles, or corrupt storage may be unrecoverable. |
| Export leakage | Downloaded reports may be plaintext and fall outside application encryption/retention controls. |
| Supply chain | npm packages, GitHub Actions, signing infrastructure, and host integrations remain trusted dependencies. Review lockfile/action changes and protect release credentials. |
| Deployment drift | Repository state alone does not prove external environment values or aliases. Verify target and SHA from the served artifact. |
| Endpoint cloning/licence bypass | A local administrator, patched executable, or full VM/disk clone can attack local enforcement. Device-bound keys, one-time redemption and 72-hour trusted leases deter ordinary copying but are not tamper-proof hardware attestation. |
| Licence-service availability | Activation requires service/database availability. A valid lease permits 72 hours of LAN operation; after that, new activity fails closed while records and exports remain available. |

## Classroom encryption statement

“Encrypted classroom” means authenticated protocol-v2 application payloads
over the host’s HTTPS/WSS transport. RC qualification still requires managed
student trust installation and a real two-machine TLS smoke. Neither layer
means anonymity, externally verified student identity, protection from a
compromised endpoint, or concealment of every field from the local relay.

Use `INCIDENT_RESPONSE.md` when a trust assumption fails and
`DATA_PRIVACY_RETENTION.md` when collecting, exporting, or deleting records.
