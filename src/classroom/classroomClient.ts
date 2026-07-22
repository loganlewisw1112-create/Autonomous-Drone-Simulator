import { useDroneStore } from '@/store/droneStore'
import { buildRunSummary } from '@/account/runRecorder'
import { useClassroomStore } from '@/classroom/classroomStore'
import { loadClassMission } from '@/classroom/classroomMission'
import { generateKeyPair, SessionCipher, type KeyPair } from '@/classroom/sessionCrypto'
import { buildGridFrame, parseGridFrame, type GridFrame, type GridFrameInput, type GridStatus } from '@/classroom/gridFrame'
import {
  GRID_BUFFER_LIMIT_BYTES, PROTOCOL_VERSION, encodeEnvelope, decodeEnvelope, makeClassId,
  acceptsSeq, isSealedPayload,
} from '@/classroom/protocol'
import type { ClassConfig, ClassId, Envelope, Sealed, SealedPayload, StudentId } from '@/classroom/protocol'
import type { FullMissionFrame } from '@/types'

// WebSocket lifecycle + the Tier-A/Tier-B publishers. Subscribes to droneStore
// from OUTSIDE (exactly as initRunRecorder does) and is never imported by any
// store. Instructor and student paths share one module-level connection; only one
// runs per tab. All crypto keys live here, never in a store.

const RUN_SUBMISSION_V = 1

// Console noise budget for integrity failures. The store counter is the UI's source of
// truth; the console gets one aggregated line per window, never one per frame.
const INTEGRITY_LOG_INTERVAL_MS = 10_000

// The relay keeps a room alive across a dropped instructor socket, so a flaky classroom
// AP should not end a class. Bounded so a relay that is genuinely gone still surfaces.
const INSTRUCTOR_RECONNECT_MS = 2_000
const INSTRUCTOR_RECONNECT_TRIES = 10

interface RunSubmission {
  v: 1
  summary: ReturnType<typeof buildRunSummary>
  student: { displayName: string }
}

let ws: WebSocket | null = null
let classId: ClassId | null = null

// Instructor
let instructorKeys: KeyPair | null = null
const studentCiphers = new Map<StudentId, SessionCipher>()
// High-water sealed seq per student — the anti-replay state. Lives beside the ciphers
// and is dropped with them, so a rejoining student (new studentId, new key) starts clean.
const lastSeqByStudent = new Map<StudentId, number>()
// Server-minted proof that this tab created the class. Held only in memory: it is the
// one credential that can re-point a live room at a different key, so it never touches
// storage and never leaves this module except back to the relay that issued it.
let instructorToken: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectTries = 0
let lastIntegrityLogAt = 0

// Student
let studentKeys: KeyPair | null = null
let studentCipher: SessionCipher | null = null
let displayName = ''
// Monotonic across grid/focus/run for this student session. The instructor keeps ONE
// high-water mark per student, so every message this tab sends must advance it.
let outSeq = 0
let gridTimer: ReturnType<typeof setInterval> | null = null
let focusTimer: ReturnType<typeof setInterval> | null = null
let unsubscribeRun: (() => void) | null = null

function wsUrl(): string {
  const override = import.meta.env.VITE_CLASSROOM_WS_URL
  if (typeof override === 'string' && override) return override
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}`
}

function send(msg: Envelope): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encodeEnvelope(msg))
}

// ── Instructor ────────────────────────────────────────────────────────────────

export function startClass(config: ClassConfig): ClassId {
  teardown()
  const id = makeClassId()
  classId = id
  instructorKeys = generateKeyPair()
  const store = useClassroomStore.getState()
  store.reset()
  store.setStatus('connecting')
  openInstructorSocket(id, config)
  return id
}

// One socket-open, reused for the first create and every re-bind. The token is absent
// on the first attempt (the relay mints it and returns class.ok) and present on every
// later one — which is precisely what distinguishes "my tab reconnected" from "someone
// who overheard the code is claiming the room".
function openInstructorSocket(id: ClassId, config: ClassConfig): void {
  ws = new WebSocket(wsUrl())
  ws.onopen = () => {
    send(instructorToken
      ? { v: PROTOCOL_VERSION, type: 'class.create', classId: id, classPubKey: instructorKeys!.publicKey, config, instructorToken }
      : { v: PROTOCOL_VERSION, type: 'class.create', classId: id, classPubKey: instructorKeys!.publicKey, config })
    useClassroomStore.getState().setInstructorClass(id, config)
  }
  ws.onmessage = (ev) => handleInstructorMessage(String(ev.data))
  ws.onclose = () => scheduleRebind(id, config)
  ws.onerror = () => useClassroomStore.getState().setStatus('error', 'connection failed')
}

// Retry only once the class actually exists (token in hand). Before that, a close is a
// failed create, not a dropped one, and must surface immediately rather than spin on
// "Creating…". Status deliberately stays 'live' across attempts: the roster and the last
// frames are still meaningful, and flapping to ClassSetup for a two-second wifi hiccup
// would tear down the wall and its shared backdrop bitmap.
function scheduleRebind(id: ClassId, config: ClassConfig): void {
  const store = useClassroomStore.getState()
  if (!instructorToken || classId !== id) {
    if (store.status === 'live') store.setStatus('closed')
    return
  }
  if (reconnectTries >= INSTRUCTOR_RECONNECT_TRIES) {
    store.setStatus('closed')
    return
  }
  reconnectTries += 1
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => openInstructorSocket(id, config), INSTRUCTOR_RECONNECT_MS)
}

// Aggregate, never per-frame. A wrong key at 1 Hz × 40 students would otherwise emit
// 40 console lines a second and bury the one fact that matters.
function noteIntegrity(kind: 'decrypt' | 'replay'): void {
  useClassroomStore.getState().noteIntegrityFailure(kind)
  const now = Date.now()
  if (now - lastIntegrityLogAt < INTEGRITY_LOG_INTERVAL_MS) return
  lastIntegrityLogAt = now
  const { decryptFailures, replayRejects } = useClassroomStore.getState().integrity
  console.warn(`[classroom] ${decryptFailures} undecryptable and ${replayRejects} replayed frame(s) rejected so far — check that students joined this class, not another one`)
}

// The single decrypt door. Opens the payload, enforces the sealed anti-replay counter,
// and records WHICH of the two failed — three separate empty catches used to make a key
// mismatch, a hijack and a tampered frame all indistinguishable from a dropped wifi
// link. Any future path that decrypts without going through here re-opens the hole.
function openSealed<T>(from: StudentId, cipher: SessionCipher, sealed: Sealed): T | null {
  let payload: SealedPayload<T>
  try {
    payload = cipher.open<SealedPayload<T>>(sealed)
  } catch {
    noteIntegrity('decrypt')
    return null
  }
  if (!isSealedPayload(payload)) {
    noteIntegrity('decrypt')
    return null
  }
  if (!acceptsSeq(lastSeqByStudent.get(from), payload.seq)) {
    noteIntegrity('replay')
    return null
  }
  lastSeqByStudent.set(from, payload.seq)
  return payload.body
}

function forgetStudent(studentId: StudentId): void {
  studentCiphers.delete(studentId)
  lastSeqByStudent.delete(studentId)
}

function handleInstructorMessage(raw: string): void {
  let msg: Envelope
  try { msg = decodeEnvelope(raw) } catch { return }
  const store = useClassroomStore.getState()
  switch (msg.type) {
    case 'class.ok':
      instructorToken = msg.instructorToken
      reconnectTries = 0
      store.setStatus('live')
      break
    case 'class.err':
      // Only reachable if another tab already owns this code, or the relay is full.
      store.setStatus('error', msg.reason)
      teardown()
      break
    case 'roster.update': {
      store.setRoster(msg.students)
      // Derive one cached AES key per student session; drop keys for those gone.
      const live = new Set(msg.students.map((s) => s.studentId))
      for (const id of [...studentCiphers.keys()]) if (!live.has(id)) forgetStudent(id)
      for (const s of msg.students) {
        if (!studentCiphers.has(s.studentId) && instructorKeys && classId) {
          studentCiphers.set(s.studentId, SessionCipher.forInstructor(instructorKeys.secretKey, s.studentPubKey, classId))
        }
      }
      break
    }
    case 'student.grid': {
      const cipher = msg.from ? studentCiphers.get(msg.from) : undefined
      if (!cipher || !msg.from) return
      const frame = openSealed<GridFrame>(msg.from, cipher, msg.sealed)
      if (frame) store.setFrame(msg.from, parseGridFrame(frame))
      break
    }
    case 'student.focus': {
      if (!msg.from || msg.from !== store.focusedStudentId) return
      const cipher = studentCiphers.get(msg.from)
      if (!cipher) return
      const frame = openSealed<FullMissionFrame>(msg.from, cipher, msg.sealed)
      if (frame) store.setFocusFrame(frame)
      break
    }
    case 'student.run': {
      const cipher = msg.from ? studentCiphers.get(msg.from) : undefined
      if (!cipher || !msg.from) return
      const sub = openSealed<RunSubmission>(msg.from, cipher, msg.sealed)
      if (sub) store.addRun({ studentId: msg.from, displayName: sub.student.displayName, summary: sub.summary, receivedAt: Date.now() })
      break
    }
    case 'student.gone':
      forgetStudent(msg.from)
      store.removeStudent(msg.from)
      break
  }
}

export function focusStudent(studentId: StudentId | null): void {
  if (!classId) return
  useClassroomStore.getState().setFocused(studentId)
  send({ v: PROTOCOL_VERSION, type: 'class.focus', classId, studentId })
}

export function closeClass(): void {
  if (classId) send({ v: PROTOCOL_VERSION, type: 'class.close', classId })
  teardown()
  useClassroomStore.getState().setStatus('closed')
}

// ── Student ───────────────────────────────────────────────────────────────────

export function joinClass(id: ClassId, name: string): void {
  teardown()
  classId = id
  displayName = name
  outSeq = 0
  studentKeys = generateKeyPair()
  const store = useClassroomStore.getState()
  store.reset()
  store.setStatus('connecting')

  ws = new WebSocket(wsUrl())
  ws.onopen = () => send({ v: PROTOCOL_VERSION, type: 'student.join', classId: id, displayName: name, studentPubKey: studentKeys!.publicKey })
  ws.onmessage = (ev) => handleStudentMessage(String(ev.data))
  ws.onclose = () => { if (useClassroomStore.getState().status === 'live') useClassroomStore.getState().setStatus('closed') }
  ws.onerror = () => useClassroomStore.getState().setStatus('error', 'connection failed')
}

function handleStudentMessage(raw: string): void {
  let msg: Envelope
  try { msg = decodeEnvelope(raw) } catch { return }
  const store = useClassroomStore.getState()
  switch (msg.type) {
    case 'join.ok': {
      if (!studentKeys || !classId) return
      studentCipher = SessionCipher.forStudent(studentKeys.secretKey, msg.classPubKey, classId)
      store.setStudentJoined(classId, msg.studentId, msg.config)
      loadClassMission(msg.config)
      startGridPublisher()
      subscribeRunSubmission()
      break
    }
    case 'join.err':
      store.setStatus('error', msg.reason)
      teardown()
      break
    case 'focus.on':
      store.setBeingFocused(true)
      startFocusPublisher()
      break
    case 'focus.off':
      store.setBeingFocused(false)
      stopFocusPublisher()
      break
    case 'class.closed':
      store.setStatus('closed')
      teardown()
      break
  }
}

// Every outbound payload goes through here so the anti-replay counter is inside the
// ciphertext, under the GCM auth tag — a captured frame re-injected by a LAN
// eavesdropper necessarily carries its original seq and the instructor drops it.
// Single counter for the whole session across grid/focus/run: the instructor keeps one
// high-water mark per student, so every send must advance it. See SealedPayload.
function sealOutgoing(cipher: SessionCipher, body: unknown): Sealed {
  outSeq += 1
  const payload: SealedPayload<unknown> = { seq: outSeq, body }
  return cipher.seal(payload)
}

// Wall-clock intervals, NOT the sim tick or rAF: the publisher must keep reporting
// while the sim is paused (exactly when the instructor most wants to know), and a
// background browser tab honestly pauses rAF but still fires setInterval.

function startGridPublisher(): void {
  stopGridPublisher()
  gridTimer = setInterval(() => {
    if (!studentCipher || !ws || ws.readyState !== WebSocket.OPEN || !classId) return
    if (ws.bufferedAmount > GRID_BUFFER_LIMIT_BYTES) return // backpressure: skip, never queue a stale frame
    const frame = buildGridFrame(currentGridInput())
    send({ v: PROTOCOL_VERSION, type: 'student.grid', classId, sealed: sealOutgoing(studentCipher, frame) })
  }, 1000)
}

function startFocusPublisher(): void {
  stopFocusPublisher()
  focusTimer = setInterval(() => {
    if (!studentCipher || !ws || ws.readyState !== WebSocket.OPEN || !classId) return
    if (ws.bufferedAmount > GRID_BUFFER_LIMIT_BYTES) return
    send({ v: PROTOCOL_VERSION, type: 'student.focus', classId, sealed: sealOutgoing(studentCipher, currentFullFrame()) })
  }, 333)
}

function subscribeRunSubmission(): void {
  unsubscribeRun?.()
  // Same hook initRunRecorder uses: replaySession is set once, on mission finalize.
  unsubscribeRun = useDroneStore.subscribe(
    (s) => s.replaySession,
    (session, prev) => {
      if (!session || session === prev || !studentCipher || !classId) return
      const submission: RunSubmission = { v: RUN_SUBMISSION_V, summary: buildRunSummary(session), student: { displayName } }
      send({ v: PROTOCOL_VERSION, type: 'student.run', classId, sealed: sealOutgoing(studentCipher, submission) })
    },
  )
}

function statusFromStore(s: ReturnType<typeof useDroneStore.getState>): GridStatus {
  if (s.replaySession) return s.ui.isReplayMode ? 2 : 3
  if (s.lifecycle === 'running' || s.lifecycle === 'paused') return 1
  return 0
}

function currentGridInput(): GridFrameInput {
  const s = useDroneStore.getState()
  return {
    elapsedSec: s.elapsedSec,
    status: statusFromStore(s),
    drones: s.drones,
    thermalContactCount: s.thermalContacts.length,
    eventCount: s.events.length,
  }
}

// Tier-B frame: reuse the exact FullMissionFrame the sim loop already assembled
// (what ArchivedReplay consumes) when present, else synthesize one from live state.
function currentFullFrame(): FullMissionFrame {
  const s = useDroneStore.getState()
  const last = s.replayFrames[s.replayFrames.length - 1]
  if (last) return last
  return {
    tick: s.tick, elapsedSec: s.elapsedSec, drones: s.drones,
    thermalContacts: s.thermalContacts, groundUnits: s.groundUnits, recoveryTeams: s.recoveryTeams,
    weatherState: s.weatherState, activeEventIds: [],
  }
}

// ── Teardown ────────────────────────────────────────────────────────────────

function stopGridPublisher(): void { if (gridTimer) { clearInterval(gridTimer); gridTimer = null } }
function stopFocusPublisher(): void { if (focusTimer) { clearInterval(focusTimer); focusTimer = null } }

export function teardown(): void {
  stopGridPublisher()
  stopFocusPublisher()
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectTries = 0
  unsubscribeRun?.()
  unsubscribeRun = null
  if (ws) {
    // Detach onclose first: a torn-down socket must not schedule a re-bind.
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try { ws.close() } catch { /* already closing */ }
    ws = null
  }
  studentCiphers.clear()
  lastSeqByStudent.clear()
  studentCipher = null
  instructorKeys = null
  instructorToken = null
  studentKeys = null
  classId = null
  outSeq = 0
}
