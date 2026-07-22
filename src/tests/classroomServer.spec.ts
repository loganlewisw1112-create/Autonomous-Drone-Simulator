import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { rm, rmdir } from 'node:fs/promises'
import { MAX_STUDENTS, MAX_CLASSES, MAX_MESSAGE_BYTES, HEARTBEAT_TIMEOUT_MS, CLASS_ID_ALPHABET, CLASS_ID_LENGTH } from '@/classroom/protocol'

// server/classroom.mjs is the only file in the project that handles untrusted input,
// and it is outside `src` — so it gets neither lint nor typecheck. Build plan §10 asks
// for exactly one integration test over it ("fake sockets: join, grid fan-out, focus
// on/off, leave") with no real network in CI. This is that test, plus a regression case
// for each security defect the relay shipped with.
//
// The relay is imported by URL rather than a literal specifier so tsc leaves the plain
// .mjs alone; importing it must not open a port (see the isMain guard at the bottom of
// classroom.mjs).
const relayUrl = new URL('../../server/classroom.mjs', import.meta.url).href
const runsDir = new URL('../../classroom-runs/', import.meta.url)

const CLASS_ID = 'B2CD3F'
const RUN_CLASS_ID = 'RVN999' // isolated: student.run writes a ciphertext backup to disk
const CONFIG = { kind: 'catalog', scenarioId: 'demo', variant: { seed: 7 } }
const SEALED = { iv: 'SEALED-IV', ct: 'SEALED-CT' }

interface WireMsg {
  v: number
  type: string
  classId?: string
  from?: string
  studentId?: string
  reason?: string
  instructorToken?: string
  classPubKey?: string
  config?: unknown
  sealed?: { iv: string; ct: string }
  students?: Array<{ studentId: string; displayName: string; studentPubKey: string }>
}

// The relay only ever calls send()/readyState on a socket and hangs role/classId/
// studentId off it, so this is the whole surface it needs.
class FakeSocket {
  readyState = 1 // WebSocket.OPEN — the relay's only liveness gate
  sent: WireMsg[] = []
  role?: string
  classId?: string
  studentId?: string

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as WireMsg)
  }

  ofType(type: string): WireMsg[] {
    return this.sent.filter((m) => m.type === type)
  }

  last(type?: string): WireMsg | undefined {
    const pool = type ? this.ofType(type) : this.sent
    return pool[pool.length - 1]
  }
}

interface ClassRecord {
  classPubKey: string
  config: unknown
  instructorSock: FakeSocket
  instructorToken: string
  focusedStudentId: string | null
  students: Map<string, { sock: FakeSocket; entry: { studentId: string } }>
}

interface Relay {
  classes: Map<string, ClassRecord>
  LIMITS: Record<string, number | string>
  handle(sock: FakeSocket, msg: Record<string, unknown>): void
  onClose(sock: FakeSocket): void
  isValidClassId(value: unknown): boolean
  resetRelayState(): void
}

let relay: Relay

beforeAll(async () => {
  relay = await import(/* @vite-ignore */ relayUrl) as unknown as Relay
})

beforeEach(() => relay.resetRelayState())

afterAll(async () => {
  // student.run persists a ciphertext crash-backup and persistRun is deliberately
  // fire-and-forget, so let the write land before removing what this spec created.
  // Best-effort: the directory is gitignored, and a cleanup race must not fail a suite.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(new URL(`${RUN_CLASS_ID}/`, runsDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    .catch(() => { /* Windows can hold the handle a moment longer; harmless */ })
  // rmdir only succeeds on an empty directory, so a real class's backups are never touched.
  await rmdir(runsDir).catch(() => { /* not empty, or never created */ })
})

// ── helpers ───────────────────────────────────────────────────────────────────

function create(sock: FakeSocket, classId = CLASS_ID, classPubKey = 'IPUB', instructorToken?: string) {
  relay.handle(sock, { v: 1, type: 'class.create', classId, classPubKey, config: CONFIG, ...(instructorToken ? { instructorToken } : {}) })
}

function tokenOf(sock: FakeSocket): string {
  const ok = sock.last('class.ok')
  if (!ok?.instructorToken) throw new Error('no class.ok — the class was never created')
  return ok.instructorToken
}

function join(sock: FakeSocket, name: string, classId = CLASS_ID): string {
  relay.handle(sock, { v: 1, type: 'student.join', classId, displayName: name, studentPubKey: `PUB-${name}` })
  const ok = sock.last('join.ok')
  if (!ok?.studentId) throw new Error(`join failed: ${ok?.reason ?? sock.last('join.err')?.reason ?? 'no reply'}`)
  return ok.studentId
}

// Opens a class with one instructor and two students. Returns everything a case needs.
function classroom() {
  const instructor = new FakeSocket()
  create(instructor)
  const ada = new FakeSocket()
  const bo = new FakeSocket()
  const adaId = join(ada, 'Ada')
  const boId = join(bo, 'Bo')
  return { instructor, ada, bo, adaId, boId, token: tokenOf(instructor) }
}

// ── build plan §10: join · grid fan-out · focus on/off · leave ─────────────────

describe('classroom relay routing', () => {
  it('answers a join with the class key + config and pushes a roster to the instructor', () => {
    const instructor = new FakeSocket()
    create(instructor)
    const ada = new FakeSocket()
    const adaId = join(ada, 'Ada')

    const ok = ada.last('join.ok')!
    expect(ok.classId).toBe(CLASS_ID)
    expect(ok.classPubKey).toBe('IPUB')
    expect(ok.config).toEqual(CONFIG)
    expect(ada.role).toBe('student')

    const roster = instructor.last('roster.update')!
    expect(roster.students).toHaveLength(1)
    expect(roster.students![0]).toMatchObject({ studentId: adaId, displayName: 'Ada', studentPubKey: 'PUB-Ada' })
  })

  it('refuses a join for a class that is not running', () => {
    const ada = new FakeSocket()
    relay.handle(ada, { v: 1, type: 'student.join', classId: CLASS_ID, displayName: 'Ada', studentPubKey: 'PUB' })
    expect(ada.last('join.err')?.reason).toBe('no-such-class')
    expect(ada.role).toBeUndefined()
  })

  it('fans a grid frame to the instructor only, tagged and unopened', () => {
    const { instructor, ada, bo, adaId } = classroom()
    relay.handle(ada, { v: 1, type: 'student.grid', classId: CLASS_ID, sealed: SEALED })

    const grid = instructor.ofType('student.grid')
    expect(grid).toHaveLength(1)
    // `from` is server-assigned (a student cannot spoof another's id) and `sealed` is
    // forwarded by reference — the relay must never parse or re-encode the ciphertext.
    expect(grid[0]).toEqual({ v: 1, type: 'student.grid', classId: CLASS_ID, from: adaId, sealed: SEALED })
    // Peer students are never a fan-out target; only the instructor can decrypt anyway.
    expect(bo.ofType('student.grid')).toHaveLength(0)
  })

  it('ignores telemetry from a socket that never joined', () => {
    const { instructor } = classroom()
    const before = instructor.sent.length
    const lurker = new FakeSocket()
    relay.handle(lurker, { v: 1, type: 'student.grid', classId: CLASS_ID, sealed: SEALED })
    expect(instructor.sent).toHaveLength(before)
  })

  it('relays a run submission to the instructor', async () => {
    const instructor = new FakeSocket()
    create(instructor, RUN_CLASS_ID)
    const ada = new FakeSocket()
    const adaId = join(ada, 'Ada', RUN_CLASS_ID)

    relay.handle(ada, { v: 1, type: 'student.run', classId: RUN_CLASS_ID, sealed: SEALED })
    expect(instructor.last('student.run')).toEqual({ v: 1, type: 'student.run', classId: RUN_CLASS_ID, from: adaId, sealed: SEALED })
  })

  it('moves focus on and off exactly one student at a time', () => {
    const { instructor, ada, bo, adaId, boId } = classroom()

    relay.handle(instructor, { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    expect(ada.ofType('focus.on')).toHaveLength(1)
    expect(bo.sent.filter((m) => m.type.startsWith('focus'))).toHaveLength(0)

    // Switching focus must release the previous student — Tier B never scales with class size.
    relay.handle(instructor, { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: boId })
    expect(ada.ofType('focus.off')).toHaveLength(1)
    expect(bo.ofType('focus.on')).toHaveLength(1)

    relay.handle(instructor, { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: null })
    expect(bo.ofType('focus.off')).toHaveLength(1)
    expect(relay.classes.get(CLASS_ID)!.focusedStudentId).toBeNull()
  })

  it('ignores a focus command from anyone but the bound instructor socket', () => {
    const { ada, bo, adaId } = classroom()
    relay.handle(bo, { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    expect(ada.ofType('focus.on')).toHaveLength(0)
  })

  it('drops a leaving student from the roster and tells the instructor', () => {
    const { instructor, ada, adaId, boId } = classroom()
    relay.handle(ada, { v: 1, type: 'student.leave', classId: CLASS_ID })

    expect(instructor.last('student.gone')).toEqual({ v: 1, type: 'student.gone', classId: CLASS_ID, from: adaId })
    expect(instructor.last('roster.update')!.students!.map((s) => s.studentId)).toEqual([boId])
    expect(relay.classes.get(CLASS_ID)!.students.has(adaId)).toBe(false)
  })

  it('clears focus when the focused student disconnects', () => {
    const { instructor, ada, adaId } = classroom()
    relay.handle(instructor, { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    relay.onClose(ada)
    expect(relay.classes.get(CLASS_ID)!.focusedStudentId).toBeNull()
    expect(instructor.last('student.gone')?.from).toBe(adaId)
  })

  it('closes the class for every student when the instructor ends it', () => {
    const { instructor, ada, bo } = classroom()
    relay.handle(instructor, { v: 1, type: 'class.close', classId: CLASS_ID })
    expect(ada.ofType('class.closed')).toHaveLength(1)
    expect(bo.ofType('class.closed')).toHaveLength(1)
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

  it('rejects malformed frames without touching state', () => {
    const sock = new FakeSocket()
    for (const bad of [null, {}, { v: 2, type: 'class.create', classId: CLASS_ID }, { v: 1, type: 42 }, { v: 1, type: 'evil.exec', classId: CLASS_ID }]) {
      relay.handle(sock, bad as Record<string, unknown>)
    }
    expect(relay.classes.size).toBe(0)
    expect(sock.sent).toEqual([])
  })
})

// ── defect 1: instructor takeover / room seizure ──────────────────────────────

describe('classroom relay instructor binding', () => {
  it('mints an instructor token on creation and returns it to the creating socket only', () => {
    const instructor = new FakeSocket()
    create(instructor)
    const ok = instructor.last('class.ok')!
    expect(ok.instructorToken).toEqual(expect.any(String))
    expect(ok.instructorToken!.length).toBeGreaterThanOrEqual(32)
    expect(relay.classes.get(CLASS_ID)!.instructorToken).toBe(ok.instructorToken)

    // Two classes never share a token.
    const other = new FakeSocket()
    create(other, 'CLS002')
    expect(tokenOf(other)).not.toBe(ok.instructorToken)
  })

  it('refuses to re-bind a live class without the token, leaving the real instructor in place', () => {
    const { instructor, token } = classroom()
    const attacker = new FakeSocket()

    // The whole attack: hear "B2CD3F" read aloud, claim the room, and every student who
    // joins afterwards seals their telemetry and their graded run to the attacker's key.
    create(attacker, CLASS_ID, 'ATTACKER-PUB')

    expect(attacker.last('class.err')).toEqual({ v: 1, type: 'class.err', classId: CLASS_ID, reason: 'not-instructor' })
    expect(attacker.ofType('class.ok')).toHaveLength(0)
    expect(attacker.role).toBeUndefined()

    const cls = relay.classes.get(CLASS_ID)!
    expect(cls.instructorSock).toBe(instructor)
    expect(cls.classPubKey).toBe('IPUB')
    expect(cls.instructorToken).toBe(token)

    // The decisive assertion: a student joining after the attempt still receives the
    // real instructor's key, so their work is still sealed to the real instructor.
    const late = new FakeSocket()
    join(late, 'Late')
    expect(late.last('join.ok')!.classPubKey).toBe('IPUB')
  })

  it('refuses a wrong token and never leaks the right one', () => {
    const { instructor, token } = classroom()
    const attacker = new FakeSocket()
    create(attacker, CLASS_ID, 'ATTACKER-PUB', 'not-the-token')

    expect(attacker.last('class.err')?.reason).toBe('not-instructor')
    expect(JSON.stringify(attacker.sent)).not.toContain(token)
    expect(relay.classes.get(CLASS_ID)!.instructorSock).toBe(instructor)
    expect(relay.classes.get(CLASS_ID)!.classPubKey).toBe('IPUB')
  })

  it('lets the real instructor re-bind with the token and keeps the live roster', () => {
    const { instructor, adaId, boId, token } = classroom()
    const reconnected = new FakeSocket()
    create(reconnected, CLASS_ID, 'IPUB-2', token)

    expect(reconnected.last('class.ok')?.instructorToken).toBe(token)
    expect(reconnected.role).toBe('instructor')
    const cls = relay.classes.get(CLASS_ID)!
    expect(cls.instructorSock).toBe(reconnected)
    expect(cls.classPubKey).toBe('IPUB-2')
    expect(reconnected.last('roster.update')!.students!.map((s) => s.studentId)).toEqual([adaId, boId])

    // The superseded socket closing must not tear the room down.
    relay.onClose(instructor)
    expect(relay.classes.has(CLASS_ID)).toBe(true)
    expect(relay.classes.get(CLASS_ID)!.instructorSock).toBe(reconnected)
  })
})

// ── defect 2: path traversal in the run backup ────────────────────────────────

describe('classroom relay class id validation', () => {
  it('rejects ids that could escape the run-backup directory', () => {
    for (const evil of ['../../x', '..', 'a/../b', '..\\..\\x', '/etc/x', 'AEIOU1', 'B2CD3', 'B2CD3FF', '', 42, null, undefined]) {
      expect(relay.isValidClassId(evil), String(evil)).toBe(false)
    }
    expect(relay.isValidClassId(CLASS_ID)).toBe(true)
  })

  it('validates the class id on every websocket entry point, not just the two that key the map', () => {
    const types = [
      'class.create', 'class.focus', 'class.close',
      'student.join', 'student.grid', 'student.focus', 'student.run', 'student.leave',
    ]
    for (const type of types) {
      const sock = new FakeSocket()
      relay.handle(sock, {
        v: 1, type, classId: '../../x',
        classPubKey: 'PUB', config: CONFIG, sealed: SEALED, displayName: 'M', studentPubKey: 'P',
      })
      // Dropped outright: no room, no reply, no role — and nothing ever reaches the
      // path.join() in persistRun that a traversal id used to walk straight out of.
      expect(sock.sent, type).toEqual([])
      expect(sock.role, type).toBeUndefined()
      expect(sock.classId, type).toBeUndefined()
    }
    expect(relay.classes.size).toBe(0)
  })

  it('uses the same class-id predicate as the client protocol module', () => {
    expect(relay.LIMITS.CLASS_ID_ALPHABET).toBe(CLASS_ID_ALPHABET)
    expect(relay.LIMITS.CLASS_ID_LENGTH).toBe(CLASS_ID_LENGTH)
  })
})

// ── defect 5: unbounded class map + drifting limits ───────────────────────────

describe('classroom relay resource limits', () => {
  it('reads one shared limits file rather than re-declaring the literals', () => {
    // The server used to hard-code MAX_STUDENTS and MAX_MSG, so protocol.ts could change
    // and the relay would silently keep enforcing the old numbers.
    expect(relay.LIMITS.MAX_STUDENTS).toBe(MAX_STUDENTS)
    expect(relay.LIMITS.MAX_CLASSES).toBe(MAX_CLASSES)
    expect(relay.LIMITS.MAX_MESSAGE_BYTES).toBe(MAX_MESSAGE_BYTES)
    expect(relay.LIMITS.HEARTBEAT_TIMEOUT_MS).toBe(HEARTBEAT_TIMEOUT_MS)
  })

  it('caps the number of live classes so one LAN client cannot mint rooms forever', () => {
    for (let i = 0; i < MAX_CLASSES; i++) {
      const sock = new FakeSocket()
      create(sock, `CLS00${i}`)
      expect(sock.ofType('class.ok'), `class ${i}`).toHaveLength(1)
    }
    expect(relay.classes.size).toBe(MAX_CLASSES)

    const overflow = new FakeSocket()
    create(overflow, 'CLS999')
    expect(overflow.last('class.err')).toEqual({ v: 1, type: 'class.err', classId: 'CLS999', reason: 'server-full' })
    expect(relay.classes.size).toBe(MAX_CLASSES)
    expect(relay.classes.has('CLS999')).toBe(false)
  })

  it('still admits the cap-th student and refuses the next', () => {
    const instructor = new FakeSocket()
    create(instructor)
    for (let i = 0; i < MAX_STUDENTS; i++) join(new FakeSocket(), `S${i}`)
    expect(relay.classes.get(CLASS_ID)!.students.size).toBe(MAX_STUDENTS)

    const overflow = new FakeSocket()
    relay.handle(overflow, { v: 1, type: 'student.join', classId: CLASS_ID, displayName: 'Last', studentPubKey: 'P' })
    expect(overflow.last('join.err')?.reason).toBe('class-full')
  })

  it('frees a class slot when a class closes', () => {
    for (let i = 0; i < MAX_CLASSES; i++) create(new FakeSocket(), `CLS00${i}`)
    const first = relay.classes.get('CLS000')!.instructorSock
    relay.handle(first, { v: 1, type: 'class.close', classId: 'CLS000' })

    const fresh = new FakeSocket()
    create(fresh, 'CLS999')
    expect(fresh.ofType('class.ok')).toHaveLength(1)
  })
})
