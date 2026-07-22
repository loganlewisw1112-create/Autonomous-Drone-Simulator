# Coordinator Console — build plan v3

**Autonomous Drone Mission Simulator · 21 July 2026**

Instructor dashboard with a **live screen wall** showing every student's simulator in real
time, encrypted end-to-end, deployable on a classroom LAN, buildable in one pass.

Written against the actual codebase. No code changed by this document.

---

## 1. What already exists

Read before planning. Most of this feature is assembly, not invention.

| Piece | Location | Why it matters |
|---|---|---|
| Encrypted accounts | `src/account/crypto.ts` | PBKDF2 310k → AES-256-GCM, all-`@noble`, **no `crypto.subtle`** |
| Auto-capture on mission end | `src/account/runRecorder.ts:218` | Submission hook exists and already fires |
| Assessment payload | `StoredRunSummary` | ~2–4 KB: metrics, outcomes, `chainVerified`, event mix |
| Live state snapshot | `FullMissionFrame` | drones + thermals + ground units + recovery + weather + active events |
| Scenario knobs | `ScenarioVariantConfig` | seed, ToD, season, weather, comms, thermal, battery, terrain |
| Mission authoring | `src/components/designer/` | `CustomMissionHub`, `DesignerMap`, `designerValidation` — **built** |
| Run drill-down + replay | `src/components/rundetail/` | `RunDetailView`, `ArchivedReplay` — **built** |
| Map layer builders | `src/components/tacticalMapGeoJson.ts` | Already factored out of the map component |
| Key rotation | `accountDb.rekeyAllRecords()` | Password change solved |

Two facts that shape everything below:

**`crypto.ts` deliberately avoids `crypto.subtle`.** SubtleCrypto requires a secure context.
Because it was avoided, **encrypted accounts already work over plain HTTP on a LAN** — no
certificates, no HTTPS setup, no browser warnings. This is why the plan is LAN-first and why
it is a two-week build rather than a two-month one.

**There are zero `fetch` / `WebSocket` / `XHR` calls in `src/` today.** Verified. Adding a
network path is the largest architectural change in the project's history and must be
opt-in, off by default, and absent from the existing bundles.

---

## 2. Live screen wall

### 2.1 The core decision

**Stream state, not pixels.** No video, no canvas capture, no WebRTC, no SFU.

The instructor's browser already holds the scenario, all static geometry, and the full
rendering stack — it published the class. It only needs to know where things are. The sim
and renderer are already decoupled, and `FullMissionFrame` is exactly the state-snapshot
format `ArchivedReplay` already consumes.

### 2.2 Two-tier streaming

| | **Tier A — grid frame** | **Tier B — focus frame** |
|---|---|---|
| Sent by | every student, always | one student, on instructor click |
| Rate | 1 Hz | 3 Hz |
| Payload | packed tuple array | `FullMissionFrame` verbatim |
| Size | ~400 B | ~4 KB |
| Drives | the wall of tiles | full-detail map, telemetry, event feed |

24 students × 400 B × 1 Hz ≈ **10 KB/s total**. Noise on classroom wifi.

### 2.3 Protocol — `src/classroom/protocol.ts`

Cleartext envelope for routing; mission data always sealed. The server never opens `sealed`.

```ts
type ClassId   = string   // 6 chars, Crockford base32, vowels removed (no accidental words)
type StudentId = string   // server-assigned, ephemeral, not an account id

interface Sealed { iv: string; ct: string }   // base64 — same shape as existing CipherBlob

interface Envelope {
  v: 1
  type: MsgType
  classId: ClassId
  from?: StudentId
  seq?: number
  sealed?: Sealed
}
```

**Instructor → server:** `class.create {classPubKey, config}` · `class.focus {studentId|null}`
· `class.close`

**Student → server:** `student.join {classId, displayName, studentPubKey}` ·
`student.grid {sealed}` · `student.focus {sealed}` · `student.run {sealed}` · `student.leave`

**Server → student:** `join.ok {studentId, classPubKey, config}` · `join.err {reason}` ·
`focus.on` / `focus.off` · `class.closed`

**Server → instructor:** `roster.update {students[]}` · `student.grid {from, sealed}` ·
`student.focus {from, sealed}` · `student.run {from, sealed}` · `student.gone {from}`

### 2.4 Sealed payloads

```ts
interface GridFrame {              // Tier A
  t:  number                       // elapsedSec
  st: 0|1|2|3                      // preflight | active | replay | stopped
  d:  Array<[string, number, number, number, number, number]>
  //  [droneId, lat*1e5, lng*1e5, headingDeg, batteryPct, stateCode]
  a:  number                       // alert bitfield
  th: number                       // thermal contact count
  ev: number                       // event count
}

interface FocusFrame  { t: number; frame: FullMissionFrame }

interface RunSubmission {
  summary: StoredRunSummary        // existing type, verbatim
  detail?: StoredRunDetailV2       // optional, size-gated
  student: { displayName: string }
}
```

Encoding choices that keep Tier A small:
- fixed-length tuples rather than objects — roughly 60 % smaller JSON
- lat/lng as integers ×1e5 (~1.1 m) — far finer than a 200 px tile can show
- `stateCode` as a small int enum, not the `MissionState` string
- alerts as a bitfield, not a string array

8 drones × ~35 B = 280 B + envelope ≈ **400 B**.

### 2.5 Alert bitfield

```
1<<0  GEOFENCE_BREACH      1<<6   CONFLICT
1<<1  COMMS_LOST           1<<7   THERMAL_NEW
1<<2  COMMS_DEGRADED       1<<8   RTB
1<<3  BATTERY_LOW  (<20%)  1<<9   RECOVERY_NEEDED
1<<4  BATTERY_CRIT (<10%)  1<<10  STALLED  (no waypoint progress 60 s)
1<<5  EMERGENCY            1<<11  IDLE     (no operator input 90 s)
```

Derived client-side in the publisher from `activeEventIds` plus drone state. Two severities:

- **CRIT (red):** BREACH · COMMS_LOST · BATTERY_CRIT · EMERGENCY · CONFLICT · RECOVERY_NEEDED
- **WARN (amber):** COMMS_DEGRADED · BATTERY_LOW · RTB · STALLED · IDLE · THERMAL_NEW

**This is what makes the wall usable.** Nobody watches 24 tiles. Alerting tiles get a
coloured border, **auto-sort to the top-left**, and appear in a one-line "needs attention"
strip above the grid. Without this the wall is decorative; with it, it is an instrument.

### 2.6 Tile renderer — the part that must not be got wrong

**Do not instantiate MapLibre per tile.** Browsers cap concurrent WebGL contexts at roughly
8–16. Twenty-four map instances will fail, and it will fail late, on someone else's laptop.

Design:

1. **Shared static backdrop, rendered once per class.** Fixed bbox = scenario bounds +
   margin. Draw geofences, search areas, routes, launch/recovery sites into one offscreen
   canvas at tile resolution (320×240 @2x). Cache as an `ImageBitmap`. **Every tile shares
   the same bitmap** — one `drawImage` each, zero per-tile setup cost.
2. **Dynamic layer per tile per frame.** `drawImage(backdrop)`, then ~8 drone glyphs (arc +
   heading triangle) coloured by state. Trivial work.
3. **Projection.** Linear lat/lng → pixel over the fixed bbox. Web Mercator is unnecessary
   at this extent; error over a 5 km AO is sub-pixel.
4. **One `requestAnimationFrame` loop for the whole wall**, iterating tiles with a dirty
   flag — not 24 independent loops. At 1 Hz updates that is ~24 redraws/sec spread across
   the wall.
5. **Interpolation.** Lerp drone positions between the last two grid frames. ~15 lines.
   Worth it: at 1 Hz without it the wall steps, and a stepping wall reads as broken even
   though nothing is wrong.

**Tile chrome:** student name · elapsed · active drone count · lowest battery · status pill ·
alert border. Click to focus.

**Grid sizing:** CSS grid, `auto-fit` / `minmax(240px, 1fr)`. 1–6 students → large tiles;
7–16 → medium; 17–40 → compact. No manual layout switch.

### 2.7 Focus view

Click a student → instructor sends `class.focus{studentId}` → server sends `focus.on` to
that student only → that student begins Tier B at 3 Hz → instructor renders a **real
MapLibre map** fed by `FullMissionFrame`, plus telemetry and the live event feed.

`ArchivedReplay` already consumes exactly this shape from `frames[i]`; feed it a live frame
instead. Largely reuse, not new code.

**One focus at a time.** Switching sends `focus.off` to the previous student. Cost is
bounded by construction — there is no configuration in which Tier B scales with class size.

### 2.8 Publisher — student side

Lives in `classroomClient.ts`. Subscribes to `droneStore` **from outside**, exactly as
`initRunRecorder()` does. **Never imported by the store** — your memory records the
store ↔ `SimulationLoop` circular-import trap that forced `quickDemo.ts` out of the store;
the same rule applies here.

- `setInterval` at 1000 ms reads `useDroneStore.getState()`, builds, seals, sends.
- **Wall-clock interval, not the sim tick** — it must keep reporting while the sim is
  paused, which is precisely when the instructor most wants to know.
- **`setInterval`, not `rAF`** — your memory notes that browser-pane previews report
  `document.hidden=true` and rAF honestly pauses. A 1 Hz interval survives background
  throttling well enough for a heartbeat; rAF would go silent.
- **Backpressure:** if `ws.bufferedAmount > 64 KB`, skip the frame. Never queue — a stale
  frame is worthless.
- On `focus.on`, start a second 333 ms interval for Tier B; clear on `focus.off`.

### 2.9 Performance budget

| Item | Cost |
|---|---|
| 24 tiles, shared backdrop, Canvas 2D, 1 Hz | < 5 ms/frame, mid laptop |
| 24 AES-GCM opens/sec on ~400 B | microseconds |
| Instructor memory | latest frame per student only |

**Do not accumulate frame history instructor-side.** That is what the run submission is for.

---

## 3. Scenario selection

Class config is a small discriminated union carried in the join payload:

```ts
type ClassConfig =
  | { kind: 'catalog'; scenarioId: string; variant: ScenarioVariantConfig }   // ~100 B
  | { kind: 'custom';  definition: CustomMissionDefinition;
      variant: ScenarioVariantConfig }                                        // few KB
```

- **Saved seed** — pick one of the 21 catalog scenarios plus the 8 `ScenarioVariantConfig`
  values. Every student gets byte-identical conditions: same weather, same comms dropouts,
  same thermal contacts, same battery pressure. **No competitor can offer this honestly**,
  and it costs nothing — determinism already provides it.
- **From scratch** — open the existing `CustomMissionHub`, author, publish to the class.

Controls: **reroll seed**, and **lock seed** (locked = graded run, unlocked = practice).

---

## 4. Security model

Envelope encryption to the instructor's key.

```
Instructor:  (classPriv, classPub) = x25519.keygen()
Student:     (sPriv, sPub)         = x25519.keygen()
             shared = x25519(sPriv, classPub)
             key    = hkdf_sha256(shared, salt=classId, info='dsim-class-v1', 32)
Instructor:  shared = x25519(classPriv, sPub)  → same key
```

**Derive once per student session, cache the AES key.** Each frame is then plain AES-256-GCM
with a fresh 12-byte IV. Per-frame ECDH would burn CPU for nothing.

Reuses `encryptJson` / `decryptJson` verbatim. Only new dependency surface: `@noble/curves`
(x25519) and `@noble/hashes/hkdf` — both siblings of packages already in the tree.

Instructor's `classPriv` is wrapped with the existing PBKDF2 account key and stored in
IndexedDB, so a page reload does not kill a running class.

**The server stores and relays ciphertext only.** It cannot read a single metric.
"Nothing readable leaves the device" stays literally true in a classroom product.

**State plainly in the UI at class creation:** if the instructor loses their password, that
class's data is unrecoverable. That is inherent to real E2EE, not a defect — but it belongs
on screen, not in a support email afterwards.

**Live frames are never persisted.** Only the end-of-run submission is stored. Small storage
footprint, small compliance surface.

---

## 5. Deployment — LAN first

Instructor runs a small server on their laptop; students on the same wifi connect directly.

**Why LAN rather than cloud:** no hosting bill, no uptime obligation, no support SLA, no
vendor-stability conversation — precisely the obligations a solo developer cannot meet. It
ends the FERPA/CJIS discussion because nothing leaves the building. It works air-gapped. And
live streaming is where LAN genuinely wins: ~1 ms latency, free bandwidth.

**`server/classroom.mjs`** — Node 20, one new dependency (`ws`):

- In-memory `Map<classId, {pubKey, config, instructorSock, students: Map}>`
- Routes purely on the cleartext envelope
- Serves `dist/` statically
- Prints LAN IP + join URL on boot (QR is rendered client-side in `ClassSetup.tsx` — no
  server-side QR dependency)
- Run submissions also written to `./classroom-runs/<classId>/<studentId>-<ts>.json` as
  ciphertext — a backup against a crashed instructor tab
- Limits: 40 students/class, 256 KB max message, heartbeat timeout 30 s

**No auth on the server, deliberately.** The class code is the join token; the crypto is the
real boundary. Document it exactly that way: *anyone on the LAN with the code can join as a
student; nobody can read anything without the instructor's key.*

Cloud (Supabase, RLS, instructor accounts) is a later, separate build. Not in scope.

---

## 6. File manifest and cut list

| # | File | Purpose | Approx |
|---|---|---|---|
| 1 | `server/classroom.mjs` | WS relay, static serve, disk backup | 200 |
| 2 | `src/classroom/protocol.ts` | Message union + payload types, shared | 90 |
| 3 | `src/classroom/sessionCrypto.ts` | x25519 + HKDF + cached AES, seal/open | 90 |
| 4 | `src/classroom/gridFrame.ts` | Build/parse `GridFrame`, alert bitfield | 110 |
| 5 | `src/classroom/classroomClient.ts` | WS lifecycle, publishers, run submit | 200 |
| 6 | `src/store/classroomStore.ts` | Roster, latest frame per student, focus | 120 |
| 7 | `src/components/classroom/JoinGate.tsx` | Student: code + name | 80 |
| 8 | `src/components/classroom/ClassSetup.tsx` | Scenario picker, create class, code + QR | 180 |
| 9 | `src/components/classroom/CoordinatorConsole.tsx` | Wall, roster, alert strip, focus pane | 260 |
| 10 | `src/components/classroom/StudentTile.tsx` | Canvas 2D tile + alert border | 160 |
| 11 | `src/components/classroom/tileRenderer.ts` | Backdrop bitmap, projection, glyphs | 170 |
| 12 | `src/components/classroom/ClassResults.tsx` | Comparison table, CSV, drill-down reuse | 180 |

**Explicitly out of scope for this build:**
Cloud / Supabase · server-side instructor accounts · cmi5 / xAPI / SCORM / LTI ·
cross-session class history · MapLibre per tile · video or screen capture ·
auto-graded operator judgment · student chat · instructor take-control of a student sim ·
mobile *instructor* console (mobile *students* work fine) · more than one focused student.

**Definition of done.** Instructor starts the server, picks a scenario, reads a 6-character
code aloud. Twenty students join from their own laptops in under a minute. The instructor
watches twenty live tiles with alert promotion, clicks one for full detail, and every
student's run arrives encrypted at mission end. Instructor exports a class CSV.

---

## 7. Not breaking mobile or Windows

- **`VITE_CLASSROOM_ENABLED` build flag.** Unset on both current Vercel projects → the whole
  module tree-shakes out. Bundles stay byte-comparable to today.
- **Third Vercel project**, same codebase, same build command — the pattern the README
  already documents for mobile vs Windows. Leave `VITE_APP_TARGET` **unset** on it so the
  existing device heuristic gives phone students the mobile shell and the instructor the
  desktop console automatically. One env var total.
- Everything classroom-side behind `React.lazy`, as `TelemetryCharts` already defers Recharts.
- Student join triggered by a URL parameter that never fires on a normal load.
- **Never import the classroom module from `droneStore`** (§2.8).
- **CI assertion** that the mobile and Windows bundles contain no networking code. Make the
  guarantee mechanical, not a promise.

---

## 8. What the instructor gets

**Free — the data already exists:**
roster and attendance · same-seed enforcement · class comparison across mission outcome,
waypoints reached, geofence breaches, RTB triggers, conflicts, thermal contacts and final
battery · per-student `chainVerified` tamper-evidence badge.

**Nearly free — reuses `rundetail/`:**
full scrubbable replay of any student's mission. Debriefing a decision by replaying it is
the single highest-value thing a training officer does.

**New work:**
instructor notes and a manual rubric score per run · class CSV plus a per-student session
record for the CLEE/POST documented-hours case.

**The one thing that can legitimately be auto-scored.** Auto-grading *judgment* would be torn
apart by any real training officer. But **NIST's Standard Test Methods for sUAS** specify a
complete published rubric — 20 targets, 5 features each, 100 points, 15–20 minute trial sized
to one battery — and they are cited as Job Performance Requirements in **NFPA 2400** and
**ASTM F38.03**. A NIST-style scored lane is not an opinion; it is an agency-recognised
number. Make it the default scenario for a new class. See `REALISM_ROADMAP.md` §12.

---

## 9. Build order inside the one shot

Sequenced so partial progress is always testable.

1. `protocol.ts` + `gridFrame.ts` + `sessionCrypto.ts` — **pure functions, fully unit-testable
   with no network.** Do these first and they stay correct forever.
2. `server/classroom.mjs` — verify with `wscat` before any UI exists.
3. `classroomClient.ts` publisher — log frames to console; confirm size and rate.
4. `tileRenderer.ts` — render one tile from a **recorded** frame fixture. No live data yet.
5. `StudentTile` + `CoordinatorConsole` wall — replay a canned multi-student fixture.
6. `JoinGate` + `ClassSetup` — real join flow end to end.
7. Focus view — wire Tier B into the existing `ArchivedReplay` shape.
8. Run submission → `ClassResults` → CSV.

Steps 1–5 need no second machine. First real multi-device test is step 6.

---

## 10. Test plan

Fits the existing layering (node unit · integration with fake timers · jsdom component).

| Target | Test |
|---|---|
| `gridFrame` build | Known store snapshot → expected packed tuples |
| Alert bitfield | Each event/state → expected bit; combinations |
| Round-trip | `GridFrame` → seal → open → deep-equal |
| Session crypto | Two keypairs derive the same AES key; wrong key throws |
| Protocol | Every message type encodes/decodes; unknown type rejected |
| Tile projection | bbox + latlng → expected pixel; corners and out-of-bounds |
| Backpressure | `bufferedAmount` over threshold → frame skipped, not queued |
| Server routing | Fake sockets: join, grid fan-out, focus on/off, leave |
| Bundle guard | Built mobile/Windows bundles contain no `WebSocket` |

Every item except the last two is a pure function. The WS layer needs one integration test
with fake sockets — no real network in CI.

---

## 11. Risks

- **Scope.** Zero-backend local app → networked classroom tool. LAN-first defers hosting,
  uptime and support entirely; cloud-first incurs all three immediately.
- **The marketing position** survives only if the E2EE is real and classroom is opt-in and
  off by default. Get that wrong and you lose the thing that makes agencies willing to try
  you at all.
- **Lost instructor password = lost class data.** Inherent. Say it on screen.
- **The 10-minute rolling replay window** will bite an instructor debriefing a 40-minute
  mission. Fix by streaming frames off-device during class — not by raising `MAX_FRAMES`.
- **WebGL context limit** is the one technical failure that would surface late, on someone
  else's hardware. §2.6 exists specifically to prevent it. Do not shortcut it.
- **Build-order risk, unchanged and still the largest.** The go-to-market research says the
  next 30 days should buy fifteen named operators, not features. **Ask the design partners
  for this before building it.** If it is real it surfaces unprompted in the first five
  calls — and their answer also settles the graded-lane vs free-practice fork, which is
  worth not guessing at.
