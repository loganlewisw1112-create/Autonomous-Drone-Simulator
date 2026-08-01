# Data privacy and retention

Last reviewed: 2026-07-31

This is a technical description, not legal advice or a claim of FERPA, COPPA,
GDPR, CCPA, or other regulatory compliance. The deploying organization owns
notices, consent/lawful basis, access rules, retention, deletion, and response
to data-subject requests.

## Data inventory

| Location | Typical contents | Boundary |
|---|---|---|
| Browser IndexedDB | Account identifiers/KDF parameters plus encrypted preferences, runs, details, missions, classroom metadata, and archives | Payloads use versioned AES-256-GCM; database/record metadata is not uniformly confidential |
| Browser memory | Decrypted account key and active records while signed in | Cleared by sign-out/reload/process exit; exposed to the active page and compromised endpoint |
| Browser URL fragment/session state | Pinned instructor fingerprint, relay choice, transient join state | Fragment is not sent in ordinary HTTP requests but is visible to the active page, browser history/UI, and local user |
| Relay memory | Classes, roster/routing fields, public keys, sockets, sessions, rate-limit state | Process local and cleared by class/session expiry or shutdown |
| Relay snapshot directory | Current ciphertext snapshot per student/class plus routing metadata | Relay cannot decrypt sealed body; retention/quota pruning applies |
| Local application data | Instructor verifier, relay snapshots, persistent school-local CA/private key, renewable leaf certificate/private key, and TLS manifest | Protect with Windows account permissions and disk encryption; export only the CA certificate to students, never either private key |
| Host process memory/terminal | Electron administrator token exists only in main-process memory; the CLI-generated token is printed once for the local maintainer | Never expose it to renderer state, logs, screenshots, chat, or shell history |
| User downloads | Backups, JSON/JSONL, KML, GeoJSON, reports, CSV, certificates, or sync envelopes | Managed outside the app; some are plaintext |
| Third-party services | Map/style/tile requests and ordinary hosting logs | Providers may receive IP, user agent, URL, timing, and service metadata under their own policies |

The application has no custom advertising SDK or active cloud account-sync
backend. Local “Analytics” screens calculate mission summaries on the device.
Hosting and map providers may still produce normal service logs.

## Defaults

- Decrypted account keys are not persisted across reloads.
- Active instructor sessions expire after eight hours.
- Relay storage keeps one current ciphertext snapshot per student/class.
- Closed-class relay snapshots expire after seven days.
- Browser run details and classroom session archives older than seven days are
  removed transactionally after successful profile sign-in. Custom missions
  and the account itself are not part of this rolling operational-record purge.
- Relay snapshots share a 256 MiB global quota; oldest closed classes are
  pruned first.
- Classroom snapshot writes are limited to four per minute per student/class.

Downloaded exports do not receive automatic application retention. They must
be deleted from their destination and backups under institutional policy.

## Required deployment decisions

Before use, name the data owner and technical administrator and record:

- pseudonymous classroom aliases only; real student names are prohibited in
  pilot rosters;
- training purpose and organizational/legal authority;
- browser-record, relay-snapshot, export, log, and backup retention periods;
- approved export destination and access group;
- deletion/review dates and accountable person;
- incident and access/deletion request contacts;
- applicable Vercel, map-provider, browser-management, and school-network
  policies.

Do not enter sensitive incident, medical, biometric, disciplinary, or real
flight data into this simulator.

## Access, export, and deletion

- A signed-in operator can export or delete records made available by the
  application.
- Account deletion must remove that account’s related local records from the
  current browser origin.
- Clearing site data removes all local records for that origin/device.
- Stop the relay before administrative deletion of snapshots or credentials.
- Reset/rotation revokes active classroom authority but is not secure erasure
  of browser, filesystem, logs, SSD blocks, or backups.
- Remove exports from their destination and every managed backup/sync system.
- A school-local CA replacement also requires removal of the old trusted CA
  certificate from student devices.

Mobile, Windows, hosted Classroom, and LAN Classroom are separate origins.
Identify every browser profile and device before declaring an access or
deletion request complete.

## Migration behavior

Legacy encrypted accounts are upgraded only after successful authentication.
Migration writes new authenticated records transactionally and retains the
legacy data unchanged if conversion fails. Legacy persistent session keys are
deleted; users sign in again. Protocol-v1 classroom sessions do not migrate and
must start a new v2 class.
