import { randomBytes } from '@noble/ciphers/utils.js'
import limits from '@/classroom/limits.json'
import type { CipherBlob } from '@/account/types'
import type { CustomMissionDefinition, ScenarioVariantConfig } from '@/types'

// Wire protocol for the classroom coordinator. The cleartext envelope carries only
// routing fields (type, classId, ids, public keys, scenario assignment); all mission
// telemetry and run data ride inside `sealed` — AES-256-GCM to the instructor's key.
// The relay (server/classroom.mjs) routes on these string fields and never opens
// `sealed`, so no metric is ever readable off-device. The server is plain JS and
// re-derives the same envelope contract without importing this file.

export const PROTOCOL_VERSION = 1 as const

// Relay guardrails and the class-code alphabet live in limits.json because
// server/classroom.mjs needs the identical values and, being plain ESM JS, cannot
// import this module. They used to be literals on both sides; the server's copy had
// already drifted (it enforced MAX_STUDENTS and MAX_MSG but knew nothing of the code
// alphabet, so it never validated a classId at all). One JSON file, two readers.
export const MAX_STUDENTS = limits.MAX_STUDENTS
export const MAX_CLASSES = limits.MAX_CLASSES
export const MAX_MESSAGE_BYTES = limits.MAX_MESSAGE_BYTES
export const MAX_COMMANDS_PER_SEC = limits.MAX_COMMANDS_PER_SEC
export const HEARTBEAT_TIMEOUT_MS = limits.HEARTBEAT_TIMEOUT_MS
export const INSTRUCTOR_RECONNECT_GRACE_MS = limits.INSTRUCTOR_RECONNECT_GRACE_MS
export const GRID_BUFFER_LIMIT_BYTES = 64 * 1024 // publisher backpressure threshold, client-only

export type ClassId = string // 6 chars from CLASS_ID_ALPHABET
export type StudentId = string // server-assigned, ephemeral, not an account id
export type Sealed = CipherBlob // { iv, ct } base64 — identical shape to account blobs

// Digits + consonants (vowels A E I O U removed so a code never spells a word).
export const CLASS_ID_ALPHABET = limits.CLASS_ID_ALPHABET
export const CLASS_ID_LENGTH = limits.CLASS_ID_LENGTH

export function makeClassId(): ClassId {
  const bytes = randomBytes(CLASS_ID_LENGTH)
  let out = ''
  for (let i = 0; i < CLASS_ID_LENGTH; i++) {
    out += CLASS_ID_ALPHABET[bytes[i] % CLASS_ID_ALPHABET.length]
  }
  return out
}

export function isValidClassId(value: unknown): value is ClassId {
  return typeof value === 'string'
    && value.length === CLASS_ID_LENGTH
    && [...value].every((c) => CLASS_ID_ALPHABET.includes(c))
}

// The assignment every student runs. Cleartext (it is not a metric): catalog seed
// or an authored mission, plus the deterministic variant dials. Same bytes for all
// students → byte-identical conditions, the one guarantee determinism gives for free.
export type ClassConfig =
  | { kind: 'catalog'; scenarioId: string; variant: ScenarioVariantConfig }
  | { kind: 'custom'; definition: CustomMissionDefinition; variant: ScenarioVariantConfig }

export interface RosterEntry {
  studentId: StudentId
  displayName: string
  joinedAt: number
  studentPubKey: string // base64 x25519 public key — instructor derives the shared key from this
}

// Every sealed payload carries the sender's counter INSIDE the ciphertext. Build plan
// §2.3 sketched `seq` as a cleartext envelope field; that is forgeable — anyone on the
// LAN can capture a frame, rewrite a plaintext integer and re-inject it. Sealed, the
// counter is covered by the GCM auth tag, so a replayed frame necessarily replays its
// own seq and the instructor drops it. Deliberately NOT mirrored in cleartext: a
// server-visible seq the server cannot authenticate is worse than none, because an
// attacker could poison the counter and lock the real student out.
// Without this, a captured student.grid renders as live on the wall, and a replayed
// student.run silently overwrites a newer submission (classroomStore replaces by id).
export interface SealedPayload<T> {
  seq: number
  body: T
}

export function isSealedPayload(value: unknown): value is SealedPayload<unknown> {
  if (!value || typeof value !== 'object') return false
  const p = value as SealedPayload<unknown>
  return typeof p.seq === 'number' && Number.isFinite(p.seq) && 'body' in p
}

// Strictly increasing per student. Gaps are normal and accepted — dropped frames,
// backpressure skips, and Tier-B frames the instructor discards before decrypting all
// leave holes. A repeat or a rewind, however, can only be a replay.
export function acceptsSeq(lastSeq: number | undefined, seq: number): boolean {
  if (!Number.isFinite(seq)) return false
  return lastSeq === undefined || seq > lastSeq
}

export type MsgType =
  | 'class.create' | 'class.focus' | 'class.command' | 'class.close'
  | 'student.join' | 'student.grid' | 'student.focus' | 'student.run' | 'student.ack' | 'student.leave'
  | 'join.ok' | 'join.err' | 'focus.on' | 'focus.off' | 'command' | 'class.closed'
  | 'roster.update' | 'student.gone' | 'class.ok' | 'class.err'

// ── Instructor → server ──────────────────────────────────────────────────────
// `instructorToken` is absent on the first create (the server mints one and returns it
// in class.ok) and required on every later create for a live classId — that is what
// stops a LAN client who overheard the code from re-pointing the room at its own key.
export interface ClassCreateMsg { v: 1; type: 'class.create'; classId: ClassId; classPubKey: string; config: ClassConfig; instructorToken?: string }
export interface ClassFocusMsg { v: 1; type: 'class.focus'; classId: ClassId; studentId: StudentId | null }
export interface ClassCommandMsg { v: 1; type: 'class.command'; classId: ClassId; studentId: StudentId | null; instructorToken: string; sealed: Sealed }
export interface ClassCloseMsg { v: 1; type: 'class.close'; classId: ClassId }

// ── Student → server (server re-emits grid/focus/run to the instructor with `from`) ──
export interface StudentJoinMsg { v: 1; type: 'student.join'; classId: ClassId; displayName: string; studentPubKey: string }
export interface StudentGridMsg { v: 1; type: 'student.grid'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentFocusMsg { v: 1; type: 'student.focus'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentRunMsg { v: 1; type: 'student.run'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentAckMsg { v: 1; type: 'student.ack'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentLeaveMsg { v: 1; type: 'student.leave'; classId: ClassId }

// ── Server → student ─────────────────────────────────────────────────────────
export interface JoinOkMsg { v: 1; type: 'join.ok'; classId: ClassId; studentId: StudentId; classPubKey: string; config: ClassConfig }
export interface JoinErrMsg { v: 1; type: 'join.err'; classId: ClassId; reason: string }
export interface FocusOnMsg { v: 1; type: 'focus.on'; classId: ClassId }
export interface FocusOffMsg { v: 1; type: 'focus.off'; classId: ClassId }
export interface CommandMsg { v: 1; type: 'command'; classId: ClassId; sealed: Sealed }
export interface ClassClosedMsg { v: 1; type: 'class.closed'; classId: ClassId }

// ── Server → instructor ──────────────────────────────────────────────────────
// class.ok carries the server-held instructor token. It is the only secret the relay
// keeps, it never leaves the creating socket, and holding it is the sole way to
// re-bind a live class to a new socket after a reload or a dropped connection.
export interface ClassOkMsg { v: 1; type: 'class.ok'; classId: ClassId; instructorToken: string }
export interface ClassErrMsg { v: 1; type: 'class.err'; classId: ClassId; reason: string }
export interface RosterUpdateMsg { v: 1; type: 'roster.update'; classId: ClassId; students: RosterEntry[] }
export interface StudentGoneMsg { v: 1; type: 'student.gone'; classId: ClassId; from: StudentId }

export type Envelope =
  | ClassCreateMsg | ClassFocusMsg | ClassCommandMsg | ClassCloseMsg
  | StudentJoinMsg | StudentGridMsg | StudentFocusMsg | StudentRunMsg | StudentAckMsg | StudentLeaveMsg
  | JoinOkMsg | JoinErrMsg | FocusOnMsg | FocusOffMsg | CommandMsg | ClassClosedMsg
  | ClassOkMsg | ClassErrMsg | RosterUpdateMsg | StudentGoneMsg

const MSG_TYPES: ReadonlySet<string> = new Set<MsgType>([
  'class.create', 'class.focus', 'class.command', 'class.close',
  'student.join', 'student.grid', 'student.focus', 'student.run', 'student.ack', 'student.leave',
  'join.ok', 'join.err', 'focus.on', 'focus.off', 'command', 'class.closed',
  'roster.update', 'student.gone', 'class.ok', 'class.err',
])

export function isMsgType(value: unknown): value is MsgType {
  return typeof value === 'string' && MSG_TYPES.has(value)
}

export function encodeEnvelope(msg: Envelope): string {
  return JSON.stringify(msg)
}

// Parse + shape-check. Rejects wrong version, non-object, and unknown message
// types so a malformed or hostile frame never reaches the dispatch switch.
export function decodeEnvelope(raw: string): Envelope {
  const obj = JSON.parse(raw) as Record<string, unknown>
  if (!obj || typeof obj !== 'object') throw new Error('envelope: not an object')
  if (obj.v !== PROTOCOL_VERSION) throw new Error(`envelope: bad version ${String(obj.v)}`)
  if (!isMsgType(obj.type)) throw new Error(`envelope: unknown type ${String(obj.type)}`)
  if (!isValidClassId(obj.classId)) throw new Error('envelope: bad classId')
  return obj as unknown as Envelope
}
