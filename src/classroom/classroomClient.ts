import { useDroneStore } from '@/store/droneStore'
import { buildRunSummary } from '@/account/runRecorder'
import { useClassroomStore } from '@/classroom/classroomStore'
import { loadClassMission } from '@/classroom/classroomMission'
import { generateKeyPair, SessionCipher, type KeyPair } from '@/classroom/sessionCrypto'
import { buildGridFrame, parseGridFrame, type GridFrame, type GridFrameInput, type GridStatus } from '@/classroom/gridFrame'
import {
  GRID_BUFFER_LIMIT_BYTES, PROTOCOL_VERSION, encodeEnvelope, decodeEnvelope, makeClassId,
} from '@/classroom/protocol'
import type { ClassConfig, ClassId, Envelope, StudentId } from '@/classroom/protocol'
import type { FullMissionFrame } from '@/types'

// WebSocket lifecycle + the Tier-A/Tier-B publishers. Subscribes to droneStore
// from OUTSIDE (exactly as initRunRecorder does) and is never imported by any
// store. Instructor and student paths share one module-level connection; only one
// runs per tab. All crypto keys live here, never in a store.

const RUN_SUBMISSION_V = 1

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

// Student
let studentKeys: KeyPair | null = null
let studentCipher: SessionCipher | null = null
let displayName = ''
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

  ws = new WebSocket(wsUrl())
  ws.onopen = () => {
    send({ v: PROTOCOL_VERSION, type: 'class.create', classId: id, classPubKey: instructorKeys!.publicKey, config })
    store.setInstructorClass(id, config)
  }
  ws.onmessage = (ev) => handleInstructorMessage(String(ev.data))
  ws.onclose = () => { if (useClassroomStore.getState().status === 'live') useClassroomStore.getState().setStatus('closed') }
  ws.onerror = () => useClassroomStore.getState().setStatus('error', 'connection failed')
  return id
}

function handleInstructorMessage(raw: string): void {
  let msg: Envelope
  try { msg = decodeEnvelope(raw) } catch { return }
  const store = useClassroomStore.getState()
  switch (msg.type) {
    case 'roster.update': {
      store.setRoster(msg.students)
      // Derive one cached AES key per student session; drop keys for those gone.
      const live = new Set(msg.students.map((s) => s.studentId))
      for (const id of studentCiphers.keys()) if (!live.has(id)) studentCiphers.delete(id)
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
      try { store.setFrame(msg.from, parseGridFrame(cipher.open<GridFrame>(msg.sealed))) } catch { /* undecryptable frame, skip */ }
      break
    }
    case 'student.focus': {
      if (!msg.from || msg.from !== store.focusedStudentId) return
      const cipher = studentCiphers.get(msg.from)
      if (!cipher) return
      try { store.setFocusFrame(cipher.open<FullMissionFrame>(msg.sealed)) } catch { /* skip */ }
      break
    }
    case 'student.run': {
      const cipher = msg.from ? studentCiphers.get(msg.from) : undefined
      if (!cipher || !msg.from) return
      try {
        const sub = cipher.open<RunSubmission>(msg.sealed)
        store.addRun({ studentId: msg.from, displayName: sub.student.displayName, summary: sub.summary, receivedAt: Date.now() })
      } catch { /* skip */ }
      break
    }
    case 'student.gone':
      studentCiphers.delete(msg.from)
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

// Wall-clock intervals, NOT the sim tick or rAF: the publisher must keep reporting
// while the sim is paused (exactly when the instructor most wants to know), and a
// background browser tab honestly pauses rAF but still fires setInterval.

function startGridPublisher(): void {
  stopGridPublisher()
  gridTimer = setInterval(() => {
    if (!studentCipher || !ws || ws.readyState !== WebSocket.OPEN || !classId) return
    if (ws.bufferedAmount > GRID_BUFFER_LIMIT_BYTES) return // backpressure: skip, never queue a stale frame
    const frame = buildGridFrame(currentGridInput())
    send({ v: PROTOCOL_VERSION, type: 'student.grid', classId, sealed: studentCipher.seal(frame) })
  }, 1000)
}

function startFocusPublisher(): void {
  stopFocusPublisher()
  focusTimer = setInterval(() => {
    if (!studentCipher || !ws || ws.readyState !== WebSocket.OPEN || !classId) return
    if (ws.bufferedAmount > GRID_BUFFER_LIMIT_BYTES) return
    send({ v: PROTOCOL_VERSION, type: 'student.focus', classId, sealed: studentCipher.seal(currentFullFrame()) })
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
      send({ v: PROTOCOL_VERSION, type: 'student.run', classId, sealed: studentCipher.seal(submission) })
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
  unsubscribeRun?.()
  unsubscribeRun = null
  if (ws) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try { ws.close() } catch { /* already closing */ }
    ws = null
  }
  studentCiphers.clear()
  studentCipher = null
  instructorKeys = null
  studentKeys = null
  classId = null
}
