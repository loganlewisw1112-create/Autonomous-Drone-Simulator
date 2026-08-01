import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, readFileSync } from 'node:fs'
import { readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_STUDENTS, MAX_CLASSES, MAX_MESSAGE_BYTES, HEARTBEAT_TIMEOUT_MS, CLASS_ID_ALPHABET, CLASS_ID_LENGTH } from '@/classroom/protocol'

// Isolate instructor unlock file I/O from any real local-secrets/ on the machine.
// Must be set before the dynamic import of classroom.mjs below.
const testSecretsDir = path.join(tmpdir(), `drone-instructor-secrets-${process.pid}`)
const testRunsDir = path.join(tmpdir(), `drone-classroom-runs-${process.pid}`)
mkdirSync(testSecretsDir, { recursive: true })
process.env.CLASSROOM_SECRETS_DIR = testSecretsDir
process.env.CLASSROOM_RUNS_DIR = testRunsDir
process.env.CLASSROOM_ADMIN_TOKEN = 'TEST-ADMIN-TOKEN'
process.env.CLASSROOM_TEST_SOCKET_AUTH = '1'

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
const runsDir = new URL(`file:///${testRunsDir.replaceAll('\\', '/')}/`)

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
  classKeyFingerprint?: string
  config?: unknown
  commandKind?: string
  queued?: number
  unavailable?: number
  resumeToken?: string
  phase?: string
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
  joinCapabilityToken?: string
  instructorSessionAuthorized = true
  instructorSessionToken?: string
  connectionIp = '127.0.0.1'
  transportTrusted = true
  closed?: { code: number; reason: string }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as WireMsg)
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason }
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
  instructorSock: FakeSocket | null
  instructorToken: string
  focusedStudentId: string | null
  students: Map<string, { sock: FakeSocket; entry: { studentId: string } }>
  commandTimestamps: number[]
  cleanupTimer: ReturnType<typeof setTimeout> | null
  expiresAt: number
  debriefUntil: number
  phase: 'active' | 'debrief' | 'closed'
}

interface Relay {
  classes: Map<string, ClassRecord>
  LIMITS: Record<string, number | string>
  handle(sock: FakeSocket, msg: Record<string, unknown>): void
  onClose(sock: FakeSocket): void
  isValidClassId(value: unknown): boolean
  resetRelayState(): void
  handleHealthHttp(req: unknown, res: unknown): Promise<boolean>
  handleInstructorAccessHttp(req: unknown, res: unknown): Promise<boolean>
  handleJoinCapabilityHttp(req: unknown, res: unknown): Promise<boolean>
  setRelayEntitlementForTests(claims: Record<string, unknown>, now?: number, sequence?: number): void
  loadInstructorAccessHashFromDisk(): string | null
  validateUpgradeRequest(req: unknown, allowed?: Set<string>): { ok: boolean; reason?: string }
  authenticateInstructorSocket(sock: FakeSocket, req: unknown): boolean
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
  await rm(testSecretsDir, { recursive: true, force: true }).catch(() => { /* temp dir */ })
})

// ── helpers ───────────────────────────────────────────────────────────────────

function create(
  sock: FakeSocket,
  classId = CLASS_ID,
  classPubKey = 'IPUB',
  instructorToken?: string,
  graded?: boolean,
) {
  relay.handle(sock, {
    v: 3,
    type: 'class.create',
    classId,
    classPubKey,
    config: CONFIG,
    ...(instructorToken ? { instructorToken } : {}),
    ...(graded === undefined ? {} : { graded }),
  })
}

function tokenOf(sock: FakeSocket): string {
  const ok = sock.last('class.ok')
  if (!ok?.instructorToken) throw new Error('no class.ok — the class was never created')
  return ok.instructorToken
}

function authorizeOneClass(now = Date.now(), usableForMs = 4 * 60 * 60_000) {
  relay.setRelayEntitlementForTests({
    sub: 'licensed-evaluator',
    exp: Math.floor((now + usableForMs) / 1000),
    offlineUntil: Math.floor((now + usableForMs) / 1000),
    maxConcurrentClasses: 1,
  }, now)
}

function join(sock: FakeSocket, name: string, classId = CLASS_ID): string {
  relay.handle(sock, { v: 3, type: 'student.join', classId, displayName: name, studentPubKey: `PUB-${name}` })
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
    relay.handle(ada, { v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Ada', studentPubKey: 'PUB' })
    expect(ada.last('join.err')?.reason).toBe('no-such-class')
    expect(ada.role).toBeUndefined()
  })

  it('fans a grid frame to the instructor only, tagged and unopened', () => {
    const { instructor, ada, bo, adaId } = classroom()
    relay.handle(ada, { v: 3, type: 'student.grid', classId: CLASS_ID, sealed: SEALED })

    const grid = instructor.ofType('student.grid')
    expect(grid).toHaveLength(1)
    // `from` is server-assigned (a student cannot spoof another's id) and `sealed` is
    // forwarded by reference — the relay must never parse or re-encode the ciphertext.
    expect(grid[0]).toEqual({ v: 3, type: 'student.grid', classId: CLASS_ID, from: adaId, sealed: SEALED })
    // Peer students are never a fan-out target; only the instructor can decrypt anyway.
    expect(bo.ofType('student.grid')).toHaveLength(0)
  })

  it('routes an authenticated sealed command only to its named student', () => {
    const { instructor, ada, bo, adaId, token } = classroom()
    relay.handle(instructor, {
      v: 3,
      type: 'class.command.batch',
      classId: CLASS_ID,
      instructorToken: token,
      commandKind: 'pause',
      items: [{ studentId: adaId, sealed: SEALED }],
    })

    expect(ada.last('command')).toEqual({ v: 3, type: 'command', classId: CLASS_ID, commandKind: 'pause', sealed: SEALED })
    expect(bo.ofType('command')).toHaveLength(0)
    expect(ada.last('command')).not.toHaveProperty('instructorToken')
    expect(ada.last('command')).not.toHaveProperty('studentId')
    expect(ada.last('command')).not.toHaveProperty('from')
  })

  it('rejects commands without the active instructor socket and correct token', () => {
    const { instructor, ada, bo, adaId, token } = classroom()
    const attacker = new FakeSocket()
    const sendCommand = (sock: FakeSocket, instructorToken?: string) => relay.handle(sock, {
      v: 3,
      type: 'class.command.batch',
      classId: CLASS_ID,
      instructorToken,
      commandKind: 'pause',
      items: [{ studentId: adaId, sealed: SEALED }],
    })

    sendCommand(instructor)
    sendCommand(instructor, 'wrong-token')
    sendCommand(attacker, token)
    sendCommand(bo, token)
    relay.handle(instructor, {
      v: 3,
      type: 'class.command.batch',
      classId: CLASS_ID,
      instructorToken: token,
      commandKind: 'pause',
      items: [],
    })
    expect(ada.ofType('command')).toHaveLength(0)
    expect(bo.ofType('command')).toHaveLength(0)
  })

  it('routes acknowledgements only from the authenticated joined student', () => {
    const { instructor, ada, bo, adaId } = classroom()
    relay.handle(ada, { v: 3, type: 'student.ack', classId: CLASS_ID, from: 'spoofed-student', sealed: SEALED })

    expect(instructor.last('student.ack')).toEqual({
      v: 3,
      type: 'student.ack',
      classId: CLASS_ID,
      from: adaId,
      sealed: SEALED,
    })
    expect(bo.ofType('student.ack')).toHaveLength(0)

    relay.handle(ada, { v: 3, type: 'student.leave', classId: CLASS_ID })
    relay.handle(ada, { v: 3, type: 'student.ack', classId: CLASS_ID, sealed: { iv: 'LATE', ct: 'LATE' } })
    const acknowledgements = instructor.ofType('student.ack')
    expect(acknowledgements).toHaveLength(1)

    const lurker = new FakeSocket()
    relay.handle(lurker, { v: 3, type: 'student.ack', classId: CLASS_ID, sealed: SEALED })
    expect(instructor.ofType('student.ack')).toHaveLength(1)
  })

  it('ignores telemetry from a socket that never joined', () => {
    const { instructor } = classroom()
    const before = instructor.sent.length
    const lurker = new FakeSocket()
    relay.handle(lurker, { v: 3, type: 'student.grid', classId: CLASS_ID, sealed: SEALED })
    expect(instructor.sent).toHaveLength(before)
  })

  it('relays a run submission to the instructor', async () => {
    const instructor = new FakeSocket()
    create(instructor, RUN_CLASS_ID)
    const ada = new FakeSocket()
    const adaId = join(ada, 'Ada', RUN_CLASS_ID)

    relay.handle(ada, { v: 3, type: 'student.run', classId: RUN_CLASS_ID, sealed: SEALED })
    expect(instructor.last('student.run')).toEqual({ v: 3, type: 'student.run', classId: RUN_CLASS_ID, from: adaId, sealed: SEALED })
  })

  it('rate-limits encrypted backup writes without interrupting live forwarding', () => {
    const instructor = new FakeSocket()
    create(instructor, RUN_CLASS_ID)
    const ada = new FakeSocket()
    join(ada, 'Ada', RUN_CLASS_ID)
    for (let index = 0; index < 5; index++) {
      relay.handle(ada, {
        v: 3,
        type: 'student.run',
        classId: RUN_CLASS_ID,
        sealed: { iv: `IV-${index}`, ct: `CT-${index}` },
      })
    }
    expect(instructor.ofType('student.run')).toHaveLength(5)
    expect(instructor.last('backup.warn')).toMatchObject({
      v: 3,
      classId: RUN_CLASS_ID,
      reason: 'rate-limited',
    })
  })

  it('moves focus on and off exactly one student at a time', () => {
    const { instructor, ada, bo, adaId, boId } = classroom()

    relay.handle(instructor, { v: 3, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    expect(ada.ofType('focus.on')).toHaveLength(1)
    expect(bo.sent.filter((m) => m.type.startsWith('focus'))).toHaveLength(0)

    // Switching focus must release the previous student — Tier B never scales with class size.
    relay.handle(instructor, { v: 3, type: 'class.focus', classId: CLASS_ID, studentId: boId })
    expect(ada.ofType('focus.off')).toHaveLength(1)
    expect(bo.ofType('focus.on')).toHaveLength(1)

    relay.handle(instructor, { v: 3, type: 'class.focus', classId: CLASS_ID, studentId: null })
    expect(bo.ofType('focus.off')).toHaveLength(1)
    expect(relay.classes.get(CLASS_ID)!.focusedStudentId).toBeNull()
  })

  it('ignores a focus command from anyone but the bound instructor socket', () => {
    const { ada, bo, adaId } = classroom()
    relay.handle(bo, { v: 3, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    expect(ada.ofType('focus.on')).toHaveLength(0)
  })

  it('drops a leaving student from the roster and tells the instructor', () => {
    const { instructor, ada, adaId, boId } = classroom()
    relay.handle(ada, { v: 3, type: 'student.leave', classId: CLASS_ID })

    expect(instructor.last('student.gone')).toEqual({ v: 3, type: 'student.gone', classId: CLASS_ID, from: adaId })
    expect(instructor.last('roster.update')!.students!.map((s) => s.studentId)).toEqual([boId])
    expect(relay.classes.get(CLASS_ID)!.students.has(adaId)).toBe(false)
  })

  it('clears focus when the focused student disconnects', () => {
    const { instructor, ada, adaId } = classroom()
    relay.handle(instructor, { v: 3, type: 'class.focus', classId: CLASS_ID, studentId: adaId })
    relay.onClose(ada)
    expect(relay.classes.get(CLASS_ID)!.focusedStudentId).toBeNull()
    expect(instructor.ofType('student.gone')).toHaveLength(0)
  })

  it('closes the class for every student when the instructor ends it', () => {
    const { instructor, ada, bo } = classroom()
    relay.handle(instructor, { v: 3, type: 'class.close', classId: CLASS_ID })
    expect(ada.ofType('class.closed')).toHaveLength(1)
    expect(bo.ofType('class.closed')).toHaveLength(1)
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

  it('rejects malformed frames without touching state', () => {
    const sock = new FakeSocket()
    for (const bad of [null, {}, { v: 1, type: 'class.create', classId: CLASS_ID }, { v: 3, type: 42 }, { v: 3, type: 'evil.exec', classId: CLASS_ID }]) {
      relay.handle(sock, bad as Record<string, unknown>)
    }
    expect(relay.classes.size).toBe(0)
    expect(sock.sent).toEqual([])
    expect(sock.closed).toEqual({ code: 4001, reason: 'refresh-required' })
  })
})

// ── defect 1: instructor takeover / room seizure ──────────────────────────────

describe('classroom relay instructor binding', () => {
  it('requires relay-authenticated instructor authority before creating a room', () => {
    const unauthenticated = new FakeSocket()
    unauthenticated.instructorSessionAuthorized = false
    create(unauthenticated)
    expect(unauthenticated.last('class.err')).toEqual({
      v: 3,
      type: 'class.err',
      classId: CLASS_ID,
      reason: 'instructor-session-required',
    })
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

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

    expect(attacker.last('class.err')).toEqual({ v: 3, type: 'class.err', classId: CLASS_ID, reason: 'not-instructor' })
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

  it('retains a class through a temporary instructor disconnect and cancels cleanup on token rebind', () => {
    vi.useFakeTimers()
    try {
      const { instructor, ada, token } = classroom()
      relay.onClose(instructor)

      const cls = relay.classes.get(CLASS_ID)!
      expect(cls.instructorSock).toBeNull()
      expect(relay.classes.has(CLASS_ID)).toBe(true)
      expect(ada.ofType('class.closed')).toHaveLength(0)

      vi.advanceTimersByTime(Number(relay.LIMITS.INSTRUCTOR_RECONNECT_GRACE_MS) - 1)
      expect(relay.classes.has(CLASS_ID)).toBe(true)

      const reconnected = new FakeSocket()
      create(reconnected, CLASS_ID, 'IPUB-REBOUND', token)
      expect(reconnected.ofType('class.ok')).toHaveLength(1)
      vi.advanceTimersByTime(Number(relay.LIMITS.INSTRUCTOR_RECONNECT_GRACE_MS) + 1)
      expect(relay.classes.has(CLASS_ID)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up a disconnected instructor class after the bounded grace period', () => {
    vi.useFakeTimers()
    try {
      const { instructor, ada, bo } = classroom()
      relay.onClose(instructor)

      vi.advanceTimersByTime(Number(relay.LIMITS.INSTRUCTOR_RECONNECT_GRACE_MS))
      expect(relay.classes.has(CLASS_ID)).toBe(false)
      expect(ada.ofType('class.closed')).toHaveLength(1)
      expect(bo.ofType('class.closed')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
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
      'class.create', 'class.command', 'class.focus', 'class.close',
      'student.join', 'student.grid', 'student.focus', 'student.run', 'student.session', 'student.ack', 'student.leave',
    ]
    for (const type of types) {
      const sock = new FakeSocket()
      relay.handle(sock, {
        v: 3, type, classId: '../../x',
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
  it('validates same-origin Host and Origin before websocket admission', () => {
    const allowed = new Set(['127.0.0.1', '192.168.1.20'])
    const request = (host: string, origin?: string, ip = '192.168.1.44') => ({
      headers: { host, ...(origin ? { origin } : {}) },
      socket: { remoteAddress: ip },
    })
    expect(relay.validateUpgradeRequest(
      request('192.168.1.20:8080', 'http://192.168.1.20:8080'),
      allowed,
    )).toEqual({ ok: true })
    expect(relay.validateUpgradeRequest(
      request('192.168.1.20:8080', 'http://evil.test'),
      allowed,
    )).toMatchObject({ ok: false, reason: 'cross-origin' })
    expect(relay.validateUpgradeRequest(
      request('evil.test:8080', 'http://evil.test:8080'),
      allowed,
    )).toMatchObject({ ok: false, reason: 'untrusted-host' })
    expect(relay.validateUpgradeRequest(
      request('127.0.0.1:8080', undefined, '127.0.0.1'),
      allowed,
    )).toMatchObject({ ok: false, reason: 'missing-origin' })
  })

  it('refuses insecure non-loopback classroom traffic by default', () => {
    const instructor = new FakeSocket()
    instructor.transportTrusted = false
    create(instructor)
    expect(instructor.last('class.err')?.reason).toBe('secure-transport-required')
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

  it('allows only ungraded classes under the explicit insecure development override', () => {
    process.env.CLASSROOM_ALLOW_INSECURE_LAN = '1'
    try {
      const graded = new FakeSocket()
      graded.transportTrusted = false
      create(graded, CLASS_ID, 'IPUB', undefined, true)
      expect(graded.last('class.err')?.reason).toBe('secure-transport-required')

      const ungraded = new FakeSocket()
      ungraded.transportTrusted = false
      create(ungraded, 'B2CD4F', 'IPUB', undefined, false)
      expect(ungraded.last('class.ok')?.classId).toBe('B2CD4F')
    } finally {
      delete process.env.CLASSROOM_ALLOW_INSECURE_LAN
    }
  })

  it('reads one shared limits file rather than re-declaring the literals', () => {
    // The server used to hard-code MAX_STUDENTS and MAX_MSG, so protocol.ts could change
    // and the relay would silently keep enforcing the old numbers.
    expect(relay.LIMITS.MAX_STUDENTS).toBe(MAX_STUDENTS)
    expect(relay.LIMITS.MAX_CLASSES).toBe(MAX_CLASSES)
    expect(relay.LIMITS.MAX_MESSAGE_BYTES).toBe(MAX_MESSAGE_BYTES)
    expect(relay.LIMITS.HEARTBEAT_TIMEOUT_MS).toBe(HEARTBEAT_TIMEOUT_MS)
    expect(relay.LIMITS.MAX_COMMANDS_PER_SEC).toBeGreaterThan(0)
    expect(relay.LIMITS.INSTRUCTOR_RECONNECT_GRACE_MS).toBeGreaterThan(0)
  })

  it('rate-limits authenticated commands in a deterministic sliding one-second window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      const { instructor, ada, adaId, token } = classroom()
      const cap = Number(relay.LIMITS.MAX_COMMANDS_PER_SEC)
      for (let index = 0; index < cap + 3; index++) {
        relay.handle(instructor, {
          v: 3,
          type: 'class.command.batch',
          classId: CLASS_ID,
          instructorToken: token,
          commandKind: 'pause',
          items: [{ studentId: adaId, sealed: { iv: `IV-${index}`, ct: `CT-${index}` } }],
        })
      }
      expect(ada.ofType('command')).toHaveLength(cap)
      expect(ada.last('command')?.sealed).toEqual({ iv: `IV-${cap - 1}`, ct: `CT-${cap - 1}` })

      vi.advanceTimersByTime(999)
      relay.handle(instructor, {
        v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: token,
        commandKind: 'pause', items: [{ studentId: adaId, sealed: SEALED }],
      })
      expect(ada.ofType('command')).toHaveLength(cap)

      vi.advanceTimersByTime(1)
      relay.handle(instructor, {
        v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: token,
        commandKind: 'pause', items: [{ studentId: adaId, sealed: SEALED }],
      })
      expect(ada.ofType('command')).toHaveLength(cap + 1)
    } finally {
      vi.useRealTimers()
    }
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
    expect(overflow.last('class.err')).toEqual({ v: 3, type: 'class.err', classId: 'CLS999', reason: 'server-full' })
    expect(relay.classes.size).toBe(MAX_CLASSES)
    expect(relay.classes.has('CLS999')).toBe(false)
  })

  it('still admits the cap-th student and refuses the next', () => {
    const instructor = new FakeSocket()
    create(instructor)
    for (let i = 0; i < MAX_STUDENTS; i++) join(new FakeSocket(), `S${i}`)
    expect(relay.classes.get(CLASS_ID)!.students.size).toBe(MAX_STUDENTS)

    const overflow = new FakeSocket()
    relay.handle(overflow, { v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Last', studentPubKey: 'P' })
    expect(overflow.last('join.err')?.reason).toBe('class-full')
  })

  it('frees a class slot when a class closes', () => {
    for (let i = 0; i < MAX_CLASSES; i++) create(new FakeSocket(), `CLS00${i}`)
    const first = relay.classes.get('CLS000')!.instructorSock
    relay.handle(first!, { v: 3, type: 'class.close', classId: 'CLS000' })

    const fresh = new FakeSocket()
    create(fresh, 'CLS999')
    expect(fresh.ofType('class.ok')).toHaveLength(1)
  })
})

describe('classroom protocol-v3 entitlement and continuity', () => {
  it('enforces one concurrent class for a licensed evaluator', () => {
    authorizeOneClass()
    const first = new FakeSocket()
    const second = new FakeSocket()
    create(first, CLASS_ID)
    create(second, 'CLS999')
    expect(first.ofType('class.ok')).toHaveLength(1)
    expect(second.last('class.err')?.reason).toBe('licence-class-limit')
  })

  it('requires the selected duration plus the 15-minute debrief to fit the entitlement', () => {
    const now = Date.now()
    authorizeOneClass(now, 44 * 60_000)
    const instructor = new FakeSocket()
    relay.handle(instructor, {
      v: 3, type: 'class.create', classId: CLASS_ID, classPubKey: 'IPUB',
      config: { ...CONFIG, durationMinutes: 30 },
    })
    expect(instructor.last('class.err')?.reason).toBe('insufficient-entitlement-time')
  })

  it('delivers one validated batch to exactly 40 students and reports the result', () => {
    authorizeOneClass()
    const instructor = new FakeSocket()
    create(instructor)
    const students = Array.from({ length: MAX_STUDENTS }, (_, index) => {
      const sock = new FakeSocket()
      const studentId = join(sock, `Student ${index + 1}`)
      return { sock, studentId }
    })
    relay.handle(instructor, {
      v: 3,
      type: 'class.command.batch',
      classId: CLASS_ID,
      instructorToken: tokenOf(instructor),
      commandKind: 'pause',
      items: students.map(({ studentId }, index) => ({
        studentId,
        sealed: { iv: `IV-${index}`, ct: `CT-${index}` },
      })),
    })
    expect(students.every(({ sock }) => sock.ofType('command').length === 1)).toBe(true)
    expect(instructor.last('class.command.result')).toMatchObject({ queued: 40, unavailable: 0 })

    const overflow = new FakeSocket()
    relay.handle(overflow, {
      v: 3, type: 'student.join', classId: CLASS_ID,
      displayName: 'Student 41', studentPubKey: 'PUB-41',
    })
    expect(overflow.last('join.err')?.reason).toBe('class-full')
  })

  it('reserves a disconnected seat and resumes it with the same student id', () => {
    authorizeOneClass()
    const instructor = new FakeSocket()
    create(instructor)
    const original = new FakeSocket()
    const studentId = join(original, 'Ada')
    const resumeToken = original.last('join.ok')!.resumeToken!
    relay.onClose(original)

    const resumed = new FakeSocket()
    relay.handle(resumed, {
      v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Ada',
      studentPubKey: 'PUB-Ada', resumeToken,
    })
    expect(resumed.last('join.ok')?.studentId).toBe(studentId)
    expect(relay.classes.get(CLASS_ID)!.students.size).toBe(1)
  })

  it('moves to debrief when authority becomes stale and permits only recovery commands', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    try {
      authorizeOneClass(10_000)
      const { instructor, ada, adaId, token } = classroom()
      vi.advanceTimersByTime(90_001)
      relay.handle(instructor, {
        v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: token,
        commandKind: 'restart', items: [{ studentId: adaId, sealed: SEALED }],
      })
      expect(relay.classes.get(CLASS_ID)!.phase).toBe('debrief')
      expect(instructor.last('class.err')?.reason).toBe('command-not-allowed-during-debrief')
      relay.handle(instructor, {
        v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: token,
        commandKind: 'rtb_all', items: [{ studentId: adaId, sealed: SEALED }],
      })
      expect(ada.last('command')?.commandKind).toBe('rtb_all')
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── relay-authoritative instructor access ─────────────────────────────────────

function mockHttpRes() {
  let status = 0
  let body = ''
  let headers: Record<string, string> = {}
  return {
    get status() { return status },
    get parsed() { return body ? JSON.parse(body) as Record<string, unknown> : null },
    get headers() { return headers },
    writeHead(code: number, nextHeaders: Record<string, string> = {}) {
      status = code
      headers = nextHeaders
    },
    end(data?: string) { body = data ?? '' },
  }
}

function mockHttpReq(
  method: string,
  url: string,
  payload?: Record<string, unknown>,
  options: { ip?: string; headers?: Record<string, string> } = {},
) {
  const raw = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : Buffer.alloc(0)
  return {
    method,
    url,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.ip ?? '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() {
      if (raw.length) yield raw
    },
  }
}

describe('classroom health HTTP API', () => {
  it('returns classroom-relay health for GET /api/health', async () => {
    const res = mockHttpRes()
    expect(await relay.handleHealthHttp(mockHttpReq('GET', '/api/health'), res)).toBe(true)
    expect(res.status).toBe(200)
    expect(res.parsed).toEqual({ ok: true, service: 'classroom-relay', protocol: 3 })
  })

  it('ignores non-health paths', async () => {
    const res = mockHttpRes()
    expect(await relay.handleHealthHttp(mockHttpReq('GET', '/api/instructor-access/status'), res)).toBe(false)
    expect(res.status).toBe(0)
  })
})

describe('classroom instructor access HTTP API', () => {
  beforeEach(async () => {
    const res = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/reset', undefined, {
        headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
      }),
      res,
    )
  })

  it('keeps every instructor administration endpoint loopback-only', async () => {
    const response = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('GET', '/api/instructor-access/status', undefined, { ip: '192.168.1.44' }),
      response,
    )
    expect(response.status).toBe(403)
    expect(response.parsed).toEqual({ ok: false, error: 'loopback-only' })
  })

  it('never prints an Electron-supplied administrator token', () => {
    const source = readFileSync(new URL('../../server/classroom.mjs', import.meta.url), 'utf8')
    expect(source).toMatch(
      /if \(administratorTokenWasGenerated\) \{\s*console\.log\(`[^`]*\$\{administratorToken\}`\)\s*\}/,
    )
  })

  it('requires the process administrator token and stores only a scrypt verifier', async () => {
    const get1 = mockHttpRes()
    expect(await relay.handleInstructorAccessHttp(
      mockHttpReq('GET', '/api/instructor-access/status'),
      get1,
    )).toBe(true)
    expect(get1.status).toBe(200)
    expect(get1.parsed).toEqual({ configured: false, authenticated: false })

    const unauthorized = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/provision', { code: 'School Code 2026' }),
      unauthorized,
    )
    expect(unauthorized.status).toBe(401)

    const provision = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/provision', { code: 'School Code 2026' }, {
        headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
      }),
      provision,
    )
    expect(provision.status).toBe(201)
    expect(relay.loadInstructorAccessHashFromDisk()).toBeNull()
    const verifier = await readFile(path.join(testSecretsDir, 'instructor-access-v2.json'), 'utf8')
    expect(verifier).toContain('"kdf": "scrypt"')
    expect(verifier).not.toContain('School Code 2026')

    const get2 = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('GET', '/api/instructor-access/status'),
      get2,
    )
    expect(get2.parsed).toEqual({ configured: true, authenticated: false })
  })

  it('issues an eight-hour HttpOnly session cookie only after verification', async () => {
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/provision', { code: 'Verify Me 2026' }, {
        headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
      }),
      mockHttpRes(),
    )

    const bad = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', { code: 'Incorrect 2026' }),
      bad,
    )
    expect(bad.status).toBe(401)

    const ok = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', { code: 'Verify Me 2026' }),
      ok,
    )
    expect(ok.status).toBe(200)
    expect(ok.headers['set-cookie']).toContain('HttpOnly')
    expect(ok.headers['set-cookie']).toContain('SameSite=Strict')
    expect(ok.headers['set-cookie']).toContain('Max-Age=28800')

    const cookie = ok.headers['set-cookie'].split(';')[0]
    const status = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('GET', '/api/instructor-access/status', undefined, {
        headers: { cookie },
      }),
      status,
    )
    expect(status.parsed).toEqual({ configured: true, authenticated: true })
  })

  it('rechecks connected instructor sockets after expiry and administrator reset', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'))
    try {
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/provision', { code: 'Rotate Safely 2026' }, {
          headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
        }),
        mockHttpRes(),
      )
      const login = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/session', { code: 'Rotate Safely 2026' }),
        login,
      )
      const cookie = login.headers['set-cookie'].split(';')[0]
      const socket = new FakeSocket()
      socket.instructorSessionAuthorized = false
      expect(relay.authenticateInstructorSocket(
        socket,
        mockHttpReq('GET', '/', undefined, { headers: { cookie } }),
      )).toBe(true)

      create(socket, 'B2CD4F')
      expect(socket.last('class.ok')?.classId).toBe('B2CD4F')

      vi.advanceTimersByTime(8 * 60 * 60 * 1000 + 1)
      create(socket, 'B2CD5F')
      expect(socket.last('class.err')?.reason).toBe('instructor-session-required')

      const relogin = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/session', { code: 'Rotate Safely 2026' }),
        relogin,
      )
      const freshCookie = relogin.headers['set-cookie'].split(';')[0]
      expect(relay.authenticateInstructorSocket(
        socket,
        mockHttpReq('GET', '/', undefined, { headers: { cookie: freshCookie } }),
      )).toBe(true)
      const reset = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/reset', undefined, {
          headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
        }),
        reset,
      )
      expect(reset.status).toBe(200)
      create(socket, 'B2CD6F')
      expect(socket.last('class.err')?.reason).toBe('instructor-session-required')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rate-limits failed verification per IP after five attempts', async () => {
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/provision', { code: 'Verify Me 2026' }, {
        headers: { 'x-classroom-admin-token': 'TEST-ADMIN-TOKEN' },
      }),
      mockHttpRes(),
    )
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/session', { code: 'Wrong Code 2026' }),
        response,
      )
      expect(response.status).toBe(401)
    }
    const limited = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', { code: 'Verify Me 2026' }),
      limited,
    )
    expect(limited.status).toBe(429)
  })

  it('migrates a legacy plaintext recovery file and deletes plaintext', async () => {
    await writeFile(
      path.join(testSecretsDir, 'instructor-access-code.txt'),
      '# legacy recovery\nLegacy School Code\n',
      'utf8',
    )
    const response = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', { code: 'Legacy School Code' }),
      response,
    )
    expect(response.status).toBe(200)
    await expect(readFile(
      path.join(testSecretsDir, 'instructor-access-code.txt'),
      'utf8',
    )).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(
      path.join(testSecretsDir, 'instructor-access-v2.json'),
      'utf8',
    )).toContain('"version": 2')
  })
})
