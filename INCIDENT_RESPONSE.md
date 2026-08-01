# Incident response

This runbook covers the simulator, three web deployments, the optional local
classroom host, and repository/release infrastructure. It is not a substitute
for a school or employer incident-response policy.

## Report and classify

Record the reporter, time, affected release/SHA, target, device, browser,
class ID, symptoms, and whether student data, credentials, deployment secrets,
or signing keys may be affected. Do not copy passwords, instructor codes,
administrator tokens, private keys, or decrypted student records into an
issue or chat.

Treat these as high priority:

- suspected exposure of account data, instructor credentials, classroom
  payloads, deployment credentials, CA/signing keys, or release secrets;
- an unknown instructor session or participant;
- a deployment serving an unexpected SHA/target;
- a broken evidence chain or cross-target deterministic mismatch;
- malware, unsigned release substitution, or a high/critical dependency issue.
- exposed redemption codes, licence-signing/HMAC/database credentials,
  unexpected entitlement issuance, or a licence API serving the wrong SHA or
  signing-key identifier.

## Contain

1. Stop the affected class and shut down the local relay.
2. Disconnect the instructor host from untrusted networks; preserve volatile
   evidence only under the organization’s policy.
3. Disable affected deployment/repository credentials and pause production
   promotion.
4. Revoke instructor sessions, room tokens, and active classes. Rotate the
   administrator token and instructor credential locally.
5. If a school-local CA private key may be exposed, revoke trust in that CA and
   issue a new CA and leaf certificate before the next class.
6. Do not delete logs or backups until the incident owner confirms what must be
   preserved.
7. For a licence-service incident, disable redemption, revoke affected
   entitlements, rotate the exposed key/secret in the documented order, and
   preserve the redacted audit trail. Do not publish raw codes or private keys.

## Investigate

- Verify the served `/build-info.json`, GitHub workflow run, commit, tag,
  checksums, SBOM, signature, and downloaded artifact.
- Review relay security events, connection origins/IPs, rate-limit events,
  archive warnings, and shutdown state without attempting to decrypt student
  payloads unnecessarily.
- Determine every affected browser origin and device; Mobile, Windows,
  hosted Classroom, and LAN Classroom store data separately.
- Reproduce against a copy or synthetic data. Do not use the live classroom as
  a diagnostic environment.
- Document proven facts separately from assumptions.
- Compare licence API health revision/schema/`kid`, database migrations,
  entitlement audit events, and packaged public-key ring. Confirm that no
  student, mission, telemetry, or coordinate data entered the service.

## Recover

Restore only from a reviewed commit that passes the complete
`RELEASE_CHECKLIST.md` gate. Replace compromised credentials/keys, remove
untrusted CA certificates, apply approved retention/deletion decisions, and
run a two-machine classroom smoke before reopening.
For licence-service recovery, restore PostgreSQL from the approved PITR point,
reconcile issued/revoked entitlements, deploy the reviewed service SHA, verify
challenge/redeem/refresh with synthetic codes, and then reopen issuance.

## Notify and learn

The deploying organization determines legal, contractual, student, guardian,
customer, insurer, and authority notification obligations. Record the
timeline, impact, root cause, corrective actions, evidence retained/deleted,
and owner/date for follow-up tests. Add regression coverage and update the
threat model before closing the incident.
