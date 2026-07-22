import { randomBytes } from '@noble/ciphers/utils.js'
import type { CipherBlob } from '@/account/types'
import type { CustomMissionDefinition, ScenarioVariantConfig } from '@/types'

// Wire protocol for the classroom coordinator. The cleartext envelope carries only
// routing fields (type, classId, ids, public keys, scenario assignment); all mission
// telemetry and run data ride inside `sealed` — AES-256-GCM to the instructor's key.
// The relay (server/classroom.mjs) routes on these string fields and never opens
// `sealed`, so no metric is ever readable off-device. The server is plain JS and
// re-derives the same envelope contract without importing this file.

export const PROTOCOL_VERSION = 1 as const

// Relay guardrails (also enforced server-side).
export const MAX_STUDENTS = 40
export const MAX_MESSAGE_BYTES = 256 * 1024
export const HEARTBEAT_TIMEOUT_MS = 30_000
export const GRID_BUFFER_LIMIT_BYTES = 64 * 1024 // publisher backpressure threshold

export type ClassId = string // 6 chars from CLASS_ID_ALPHABET
export type StudentId = string // server-assigned, ephemeral, not an account id
export type Sealed = CipherBlob // { iv, ct } base64 — identical shape to account blobs

// Digits + consonants (vowels A E I O U removed so a code never spells a word).
export const CLASS_ID_ALPHABET = '0123456789BCDFGHJKLMNPQRSTVWXYZ'
export const CLASS_ID_LENGTH = 6

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

export type MsgType =
  | 'class.create' | 'class.focus' | 'class.close'
  | 'student.join' | 'student.grid' | 'student.focus' | 'student.run' | 'student.leave'
  | 'join.ok' | 'join.err' | 'focus.on' | 'focus.off' | 'class.closed'
  | 'roster.update' | 'student.gone'

// ── Instructor → server ──────────────────────────────────────────────────────
export interface ClassCreateMsg { v: 1; type: 'class.create'; classId: ClassId; classPubKey: string; config: ClassConfig }
export interface ClassFocusMsg { v: 1; type: 'class.focus'; classId: ClassId; studentId: StudentId | null }
export interface ClassCloseMsg { v: 1; type: 'class.close'; classId: ClassId }

// ── Student → server (server re-emits grid/focus/run to the instructor with `from`) ──
export interface StudentJoinMsg { v: 1; type: 'student.join'; classId: ClassId; displayName: string; studentPubKey: string }
export interface StudentGridMsg { v: 1; type: 'student.grid'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentFocusMsg { v: 1; type: 'student.focus'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentRunMsg { v: 1; type: 'student.run'; classId: ClassId; from?: StudentId; sealed: Sealed }
export interface StudentLeaveMsg { v: 1; type: 'student.leave'; classId: ClassId }

// ── Server → student ─────────────────────────────────────────────────────────
export interface JoinOkMsg { v: 1; type: 'join.ok'; classId: ClassId; studentId: StudentId; classPubKey: string; config: ClassConfig }
export interface JoinErrMsg { v: 1; type: 'join.err'; classId: ClassId; reason: string }
export interface FocusOnMsg { v: 1; type: 'focus.on'; classId: ClassId }
export interface FocusOffMsg { v: 1; type: 'focus.off'; classId: ClassId }
export interface ClassClosedMsg { v: 1; type: 'class.closed'; classId: ClassId }

// ── Server → instructor ──────────────────────────────────────────────────────
export interface RosterUpdateMsg { v: 1; type: 'roster.update'; classId: ClassId; students: RosterEntry[] }
export interface StudentGoneMsg { v: 1; type: 'student.gone'; classId: ClassId; from: StudentId }

export type Envelope =
  | ClassCreateMsg | ClassFocusMsg | ClassCloseMsg
  | StudentJoinMsg | StudentGridMsg | StudentFocusMsg | StudentRunMsg | StudentLeaveMsg
  | JoinOkMsg | JoinErrMsg | FocusOnMsg | FocusOffMsg | ClassClosedMsg
  | RosterUpdateMsg | StudentGoneMsg

const MSG_TYPES: ReadonlySet<string> = new Set<MsgType>([
  'class.create', 'class.focus', 'class.close',
  'student.join', 'student.grid', 'student.focus', 'student.run', 'student.leave',
  'join.ok', 'join.err', 'focus.on', 'focus.off', 'class.closed',
  'roster.update', 'student.gone',
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
