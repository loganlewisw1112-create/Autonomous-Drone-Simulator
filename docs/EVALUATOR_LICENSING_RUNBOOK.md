# Evaluator licensing runbook

This runbook covers the publisher-operated licence service used by the signed
Windows classroom host. It does not authorize aircraft operations and it does
not receive missions, student rosters, telemetry, coordinates, or classroom
results.

## Product contract

- `selected_evaluator_demo`: 14 days from successful server activation.
- `agency_classroom_pilot`: 90 days from an explicit publisher promotion.
- One active Windows device and activating Windows account per entitlement.
- One concurrent class with at most 40 students.
- Internet is required at activation and at least once every 72 hours.
- Students use class-scoped join credentials and never redeem product codes.
- Expiry blocks new training activity but preserves debrief, recovery, records,
  diagnostics, and exports.
- One publisher-approved replacement is allowed. A replacement retains the
  original expiry; it does not restart the evaluation.
- An unused redemption code expires 30 days after issuance.

Administrator cloning, virtual-machine snapshots, patched binaries, and a
compromised Windows account remain endpoint risks. Do not describe this system
as tamper-proof or impossible to bypass.

## Service boundary

The licence API is an independent Vercel Functions project backed by managed
Neon PostgreSQL. The three simulator web deployments do not host licence API
routes. Electron main is the only simulator component allowed to contact the
licence API.

Production service secrets:

- `DATABASE_URL`: pooled TLS PostgreSQL connection for request handlers.
- `DATABASE_URL_UNPOOLED`: migration and publisher-CLI connection.
- `LICENSING_JWS_PRIVATE_KEY_PKCS8_BASE64`: Ed25519 PKCS#8 signing key.
- `LICENSING_JWS_PUBLIC_KEY_SPKI_BASE64`: corresponding public SPKI key.
- `LICENSING_JWS_KEY_ID`: public key identifier placed in signed leases.
- `LICENSING_CODE_HMAC_KEY_BASE64`: code lookup secret.
- `LICENSING_RATE_LIMIT_HMAC_KEY_BASE64`: source-rate pseudonymization secret.
- `LICENSING_AUDIT_HMAC_KEY_BASE64`: recipient/actor audit pseudonymization secret.
- `LICENSING_ISSUER`: stable production issuer URL.

The Windows package contains only the HTTPS API origin, issuer, audience, and
Ed25519 public verification-key ring. Authenticode and licence-signing keys are
separate credentials with separate rotation and incident procedures.

## Publisher operations

Run the publisher CLI only from the publisher-controlled Windows account. Load
secrets from a protected secret manager or process environment; never place
them in shell history, screenshots, tickets, chat, repository files, or logs.

Supported operations:

```text
issue --tier evaluator|pilot --recipient-ref <pseudonym>
status --code|--license
revoke --license <id> --reason <text>
replace --license <id> --reason <text>
promote --license <id> --tier pilot --reason <text>
```

`issue` prints the plaintext redemption code exactly once. Send it through an
approved out-of-band channel. The database retains only an HMAC digest.

Use `replace` only after confirming the evaluator identity and support case.
It revokes the old installation, consumes the one replacement allowance, and
issues a replacement credential for the original remaining term. Use
`promote`—not a second evaluator code—to begin an approved 90-day pilot.

## Expected failure behavior

- Activation service unavailable: do not consume the code; retry is safe.
- Refresh unavailable inside the 72-hour lease: continue with a visible warning.
- Refresh unavailable after the lease: enter verification-required/read-only.
- Backward clock movement over five minutes: require trusted online time.
- Forward clock error: fail safe; a successful refresh may correct it.
- Lost protected installation key or reinstall: do not reopen the spent code;
  use the audited replacement process.
- Revocation: applies no later than the end of the current 72-hour lease and
  immediately after the next successful refresh.

Support diagnostics must contain only application version/SHA, a licence-ID
suffix, installation public-key thumbprint prefix, entitlement state, trusted
timestamps, and service reachability. They must never contain redemption
codes, private keys, student data, missions, IP addresses, or coordinates.

## Retention and recovery

- Entitlement and audit records: through 90 days after expiry/revocation.
- Application/provider request logs: 30 days maximum.
- HMAC-pseudonymized rate-limit records: 24 hours maximum.
- Database backups/PITR: enabled under the publisher account and tested before
  release, then at least quarterly.

Run `npm --prefix services/licensing run purge-retention` from protected
publisher automation at least daily. The command expires unused/ended records,
deletes expired challenges and rate-limit fingerprints, and removes licensing
and audit records only after their 90-day terminal retention boundary.

Monitor API availability, database failures, challenge/redeem/refresh error
rates, latency, signing-key identifier, migration version, and deployment SHA.
Never emit success/failure metrics keyed by a plaintext code or real person.

## Release and key rotation

Before packaging, verify that the production API health response reports the
expected schema version, signing `kid`, and deployed Git SHA. A licensed build
must fail packaging if its public API configuration or public key ring is
missing.

For Ed25519 rotation, deploy the new public key in the Windows key ring first,
then begin issuing leases with the new `kid`, retain the previous public key
until every lease it signed has expired, and only then remove it. Compromise of
the licence-signing key requires revocation of that `kid`, a new signed Windows
build, and incident notification. Compromise of the Authenticode key follows
the separate Windows signing runbook.
