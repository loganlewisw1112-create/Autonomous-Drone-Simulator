# Classroom administrator runbook

Last reviewed: 2026-07-27

Use this runbook for the optional Windows classroom host. The public Vercel
Classroom URL is a client showcase and cannot provide the long-lived relay.

## Release boundary

Two modes are intentionally separate:

- **Engineering mode:** a reviewed source checkout may run a loopback or
  explicitly insecure, non-graded relay for development. It is not a school
  release.
- **School-pilot mode:** host-side school-local CA/leaf generation and
  HTTPS/WSS wiring are implemented. A signed Windows installer, managed
  installation of the exported CA certificate on student devices, and the RC
  checklist are still required.

Never use `CLASSROOM_ALLOW_INSECURE_LAN=1` or
`CLASSROOM_ALLOW_MISSING_ORIGIN=1` for a graded/live pilot.

## Before a class

- Use a patched Windows instructor PC with Node 24.x/npm 11.12.1 for source
  operation, or the approved signed installer.
- Use a dedicated managed Windows account, disk encryption, screen lock, and a
  supported managed browser.
- Keep instructor and student devices on the approved private school network.
  Do not use a public hotspot or port-forward the relay.
- Restrict the relay port to the intended private subnet and local profile.
- Confirm the exact release SHA, installer signature/checksum, and
  `RELEASE_CHECKLIST.md` evidence.
- Confirm the school’s authorization, notice/consent, naming convention,
  retention period, export destination, and incident contact.
- Use pseudonymous display names when legal identity is unnecessary.

## Start an engineering host

From an approved checkout:

```powershell
npm ci
npm run classroom:desktop
```

Terminal maintainers can use:

```powershell
npm run classroom
```

The direct CLI prints a randomly generated 256-bit local administrator token
once unless `CLASSROOM_ADMIN_TOKEN` was supplied securely. Capture it in the
approved password manager; do not put it in command history, chat, screenshots,
student instructions, `.env` files that are backed up, or Git.

Both launch paths generate/reuse the persistent school-local CA and renewable
LAN leaf, then serve HTTPS/WSS by default. The CLI prints the generated CA
certificate path. Electron stores TLS material beneath its per-user application
data, fingerprint-pins the exact certificate of its owned loopback relay, and
owns/stops only the relay it starts. A browser or hosted deployment cannot
start the relay.

## Provision instructor authority

First provisioning, rotation, and reset are local-administrator actions:

- `/api/instructor-access/status`, `/provision`, `/rotate`, and `/reset` are
  loopback-only.
- Provision/rotate/reset require the process administrator token in
  `x-classroom-admin-token`.
- Instructor access codes are 12–128 characters, NFKC-normalized,
  case-sensitive, and preserve internal spaces.
- The relay stores a versioned scrypt verifier, never a reversible code.
- A successful legacy migration atomically creates the verifier before
  removing old plaintext/SHA-256 files.

When Electron owns the relay, first-time provisioning uses its narrow
schema-validated IPC bridge. The renderer supplies the proposed code, Electron
asks for local confirmation, and the main process submits it with an
administrator token that is never exposed to the renderer.

When a maintainer started the relay directly, provision through PowerShell
without placing either secret literally in command history:

Install the printed school-local CA certificate in the maintainer profile's
trusted root store before using this HTTPS command. Remove that trust again
when decommissioning the engineering relay.

```powershell
$relayBase = 'https://127.0.0.1:8080'
$adminSecure = Read-Host 'Local administrator token' -AsSecureString
$codeSecure = Read-Host 'New instructor access code' -AsSecureString
$adminToken = [Net.NetworkCredential]::new('', $adminSecure).Password
$accessCode = [Net.NetworkCredential]::new('', $codeSecure).Password
$headers = @{ 'x-classroom-admin-token' = $adminToken }
$body = @{ code = $accessCode } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$relayBase/api/instructor-access/provision" `
  -Headers $headers -ContentType 'application/json' -Body $body
Remove-Variable adminToken, accessCode, body, headers
```

Close that PowerShell session after provisioning. Rotation/reset remain local
maintainer actions and should be scheduled outside a class.

After provisioning, an instructor enters the code through the local classroom
UI. Successful verification issues an eight-hour `HttpOnly`,
`SameSite=Strict` relay session. The browser cannot read that cookie.

Five failed attempts per IP or 30 global failures within 15 minutes trigger
temporary refusal. Investigate unexpected failures before retrying.

Rotation or reset revokes all instructor sessions, room tokens, and active
classes. Schedule it outside class time.

## School-local TLS

The host creates a 3072-bit RSA school-local CA valid for 3,650 days and a LAN
server leaf valid for 397 days. It renews the leaf within 30 days of expiry or
when the LAN host/IP set changes. Certificate SANs include localhost, loopback,
and detected LAN IPv4 addresses.

TLS files are kept outside the repository in per-user application data:

- `school-local-ca.crt` — the only certificate distributed to students;
- `school-local-ca.key` — never exported;
- `classroom-relay.crt` and `classroom-relay.key`;
- `classroom-relay.json` host/renewal manifest.

The direct CLI prints the full CA certificate path and honors
`CLASSROOM_TLS_DIR`. Electron uses `<Electron user-data>\tls`; it does not
currently install or export the certificate through Windows certificate-store
APIs.

The application creates restrictive directory/key modes where the platform
supports them, but does not configure Windows ACLs or install certificates into
Windows certificate stores.

The NSIS uninstaller removes the desktop host's per-user application data,
including its verifier, relay snapshots, and private TLS material. Export any
records that policy requires before uninstalling. Because school-managed CA
trust is installed outside the application, administrators must separately
remove that exported CA certificate from managed student/instructor profiles
when the host is decommissioned.

- Install only `school-local-ca.crt` on managed student Windows profiles using
  the school’s approved device-management/certificate process.
- Never copy the CA private key to a student device or shared drive.
- Use the hostname/IPs covered by the generated leaf certificate.
- Verify the browser shows trusted HTTPS before creating the class.
- Replace the CA and remove the former trust from every student profile after
  suspected private-key exposure.

The coordinator provides a QR and copyable join URL. The URL includes the
instructor public-key fingerprint in the fragment (`#ik=...`); students reject
a relay key that does not match it.

Until managed CA installation and a real two-machine HTTPS/WSS smoke are
recorded, this implementation is not an RC-qualified school deployment.

## Start and supervise a class

1. Sign in as Instructor and establish the relay instructor session.
2. Create the class, choose scenario and seed, and verify the UI reports
   trusted HTTPS/WSS.
3. Share the approved HTTPS join URL or QR.
4. Students sign in as Student and join from managed Windows devices.
5. Match the on-screen roster to the room before starting.
6. Keep the instructor window open and investigate unknown participants,
   fingerprint failures, replay failures, disconnects, takeover warnings, or
   `backup.warn`.
7. Recreate the class if its code or join link escaped the supervised group.

The class code identifies a room; it is not external identity proof.
Protocol-v2 messages protect their authenticated payloads, not a compromised
endpoint or every piece of relay/network metadata.

## Capacity and storage controls

The relay enforces:

- 262,144-byte maximum WebSocket payload;
- 96 total sockets and 12 per IP;
- 30 upgrades per IP per minute;
- 10-second role handshake;
- 16 messages/second with burst 24 per socket;
- the separate 10 instructor commands/second limit;
- four backup writes per minute per student/class;
- one current atomic ciphertext snapshot per student/class;
- seven-day closed-class retention and 256 MiB global quota.

Oldest closed classes are pruned first. `backup.warn` reports rate limiting,
quota pressure, or write failure without interrupting live forwarding. Export
or recover only under the approved retention policy.

## End a class

1. End the class and confirm participant/archive status.
2. Record and resolve any backup warning.
3. Export only required records to the approved destination.
4. Sign out the instructor relay session.
5. Quit the Electron host or stop the terminal relay.
6. Confirm the relay port is no longer listening before leaving the trusted
   network.
7. Apply browser, snapshot, download, and backup retention rules.

## Reset, decommission, or incident

For planned reset, use the authenticated loopback administrator action; do not
delete verifier files behind a running relay. Then clear approved browser data,
snapshots, exports, certificates, and backups under policy.

For suspected compromise, stop the class/relay, preserve required evidence,
rotate credentials and tokens, replace CA trust when applicable, and follow
`INCIDENT_RESPONSE.md`.
