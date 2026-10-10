import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ADMIN_PASS_PREFIX,
  adminPassSigningBytes,
  bytesToBase64Url,
} from '../../server/adminPassVerify.mjs'
import { generateKeyPair, publicKeyFingerprint, SessionCipher } from '@/classroom/sessionCrypto'
import { useClassroomStore } from '@/classroom/classroomStore'
import { stopTicking } from '@/sim/SimulationLoop'
import type { ClassConfig, ClassId, Sealed } from '@/classroom/protocol'

// Admin "no class time limit": a relay session minted from a verified signed admin pass may
// create a class with `durationMinutes: null`; every other session keeps 30..180 exactly.

const testRoot = path.join(tmpdir(), `drone-admin-unlimited-${process.pid}`)
mkdirSync(path.join(testRoot, 'secrets'), { recursive: true })
mkdirSync(path.join(testRoot, 'runs'), { recursive: true })
process.env.CLASSROOM_SECRETS_DIR = path.join(testRoot, 'secrets')
process.env.CLASSROOM_RUNS_DIR = path.join(testRoot, 'runs')
process.env.CLASSROOM_ADMIN_TOKEN = 'ADMIN-UNLIMITED-TOKEN'
process.env.CLASSROOM_TEST_SOCKET_AUTH = '1'

// Client side: accept `restart` so the gate under test is the time-limit gate, not validation.
vi.mock('@/classroom/commandRegistry', () => ({
  validateInstructorCommand: (value: unknown) => {
    const command = value as { commandId?: unknown; kind?: unknown }
    return (command?.kind === 'restart' || command?.kind === 'pause') && typeof command.commandId === 'string'
      ? { ok: true, command: value }
      : { ok: false, code: 'unknown_command', message: 'Command is not allowed.' }
  },
  executeInstructorCommand: (command: { commandId: string; kind: string }) => ({
    ok: true, commandId: command.commandId, kind: command.kind, affectedDroneIds: [],
  }),
}))

interface WireMsg {
  v: number
  type: string
  classId?: string
  reason?: string
  phase?: string
  activeUntil?: number
  instructorToken?: string
  studentId?: string
  commandKind?: string
  config?: unknown
  sealed?: Sealed
}

class FakeSocket {
  readyState = 1
  sent: WireMsg[] = []
  role?: string
  classId?: string
  studentId?: string
  instructorSessionAuthorized = false
  instructorSessionAdmin?: boolean
  instructorSessionToken?: string
  connectionIp = '127.0.0.1'
  transportTrusted = true
  send(raw: string): void { this.sent.push(JSON.parse(raw) as WireMsg) }
  close(): void { /* no-op */ }
  last(type: string): WireMsg | undefined {
    const pool = this.sent.filter((m) => m.type === type)
    return pool[pool.length - 1]
  }
}

interface Relay {
  classes: Map<string, { phase: string; expiresAt: number; debriefUntil: number; config: unknown }>
  handle(sock: FakeSocket, msg: Record<string, unknown>): void
  handleInstructorAccessHttp(req: unknown, res: unknown): Promise<boolean>
  authenticateInstructorSocket(sock: FakeSocket, req: unknown): boolean
  setAdminPassTrustForTests(trust: { trustedPublicKeys: string[]; revokedPassIds: string[] } | null): void
  setRelayEntitlementForTests(claims: Record<string, unknown>, now?: number, sequence?: number): void
  resetRelayState(): void
}

const relayUrl = new URL('../../server/classroom.mjs', import.meta.url).href
let relay: Relay

const trusted = ed25519.keygen()
const CLASS_ID = 'B2CD3F'
const MIN = 60_000
const HOUR = 60 * MIN
const BASE = { kind: 'catalog', scenarioId: 'demo', variant: { seed: 7 } }
const SEALED = { iv: 'IV', ct: 'CT' }

function signPass(passId = 'adm-unlimited-1') {
  const payload = { v: 1, email: 'owner@example.com', name: 'Owner', passId, issuedAt: Date.now() - 1000 }
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), trusted.secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}

function mockRes() {
  let status = 0
  let body = ''
  let headers: Record<string, string> = {}
  return {
    get status() { return status },
    get parsed() { return body ? JSON.parse(body) as Record<string, unknown> : null },
    get headers() { return headers },
    writeHead(code: number, next: Record<string, string> = {}) { status = code; headers = next },
    end(data?: string) { body = data ?? '' },
  }
}

function mockReq(method: string, url: string, payload?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const raw = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0)
  return {
    method,
    url,
    headers: payload
      ? { 'content-type': 'application/json', 'content-length': String(raw.length), ...headers }
      : headers,
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() { if (raw.length) yield raw },
  }
}

async function cookieFor(body: Record<string, unknown>): Promise<string> {
  const res = mockRes()
  await relay.handleInstructorAccessHttp(mockReq('POST', '/api/instructor-access/session', body), res)
  expect(res.status).toBe(200)
  return res.headers['set-cookie'].split(';')[0]
}

/** A socket authenticated the real way (session cookie), not through the fake-socket seam. */
function socketWithCookie(cookie: string): FakeSocket {
  const sock = new FakeSocket()
  expect(relay.authenticateInstructorSocket(sock, mockReq('GET', '/', undefined, { cookie }))).toBe(true)
  return sock
}

function authorize(now: number, usableForMs: number) {
  const exp = Math.floor((now + usableForMs) / 1000)
  heartbeat(exp, now)
  return exp * 1000
}

/** The desktop host re-syncs the same licence inside the 90 s heartbeat window. */
function heartbeat(expSeconds: number, now = Date.now()) {
  relay.setRelayEntitlementForTests({
    sub: 'licensed-evaluator', exp: expSeconds, offlineUntil: expSeconds, maxConcurrentClasses: 2,
  }, now)
}

function create(sock: FakeSocket, config: Record<string, unknown>, classId = CLASS_ID) {
  relay.handle(sock, { v: 3, type: 'class.create', classId, classPubKey: 'IPUB', config })
}

function join(sock: FakeSocket, name: string): string {
  relay.handle(sock, {
    v: 3, type: 'student.join', classId: CLASS_ID, displayName: name, studentPubKey: `PUB-${name}`,
  })
  const ok = sock.last('join.ok')
  if (!ok?.studentId) throw new Error(`join failed: ${sock.last('join.err')?.reason}`)
  return ok.studentId
}

beforeAll(async () => {
  relay = await import(/* @vite-ignore */ relayUrl) as unknown as Relay
})

beforeEach(() => {
  relay.resetRelayState()
  relay.setAdminPassTrustForTests({ trustedPublicKeys: [bytesToBase64Url(trusted.publicKey)], revokedPassIds: [] })
})

afterEach(() => {
  vi.useRealTimers()
  relay.resetRelayState()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
  delete process.env.CLASSROOM_SECRETS_DIR
  delete process.env.CLASSROOM_RUNS_DIR
  delete process.env.CLASSROOM_ADMIN_TOKEN
  delete process.env.CLASSROOM_TEST_SOCKET_AUTH
})

describe('admin-pass relay session: no class time limit', () => {
  it('accepts durationMinutes:null and keeps the class active past 180 min, ending only at the licence bound', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'))
    const start = Date.now()
    const bound = authorize(start, 6 * HOUR) // licence ends at +6h
    const admin = socketWithCookie(await cookieFor({ adminPass: signPass() }))

    create(admin, { ...BASE, durationMinutes: null })
    const ok = admin.last('class.ok')
    expect(ok?.classId).toBe(CLASS_ID)
    expect(admin.last('class.err')).toBeUndefined()
    // activeUntil = licence bound minus the 15-minute debrief, NOT now + 60/180 min.
    expect(ok?.activeUntil).toBe(bound - 15 * MIN)
    expect(relay.classes.get(CLASS_ID)!.expiresAt).toBe(bound - 15 * MIN)
    expect(relay.classes.get(CLASS_ID)!.config).toMatchObject({ durationMinutes: null })

    // 61 min: the nominal default would have ended the class.
    vi.setSystemTime(start + 61 * MIN)
    heartbeat(bound / 1000)
    const late = new FakeSocket()
    late.instructorSessionAuthorized = true
    const studentId = join(late, 'Ada')
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('active')

    // 181 min and 300 min: still active, restart still relayed (not 'command-not-allowed-during-debrief').
    for (const minutes of [181, 300]) {
      vi.setSystemTime(start + minutes * MIN)
      heartbeat(bound / 1000)
      relay.handle(admin, {
        v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: ok!.instructorToken,
        commandKind: 'restart', items: [{ studentId, sealed: SEALED }],
      })
      expect(relay.classes.get(CLASS_ID)!.phase).toBe('active')
      expect(admin.last('class.err')?.reason).toBeUndefined()
    }

    // Just past the licence-derived bound: scheduled-end -> debrief.
    vi.setSystemTime(bound - 15 * MIN + 1_000)
    heartbeat(bound / 1000)
    const after = new FakeSocket()
    after.instructorSessionAuthorized = true
    relay.handle(after, { v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Bo', studentPubKey: 'PUB-Bo' })
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('debrief')
  })

  it('refuses a null duration when the licence bound (minus debrief) is already past', async () => {
    const now = Date.now()
    authorize(now, 10 * MIN) // 10 min left < 15 min debrief
    const admin = socketWithCookie(await cookieFor({ adminPass: signPass() }))
    create(admin, { ...BASE, durationMinutes: null })
    expect(admin.last('class.err')?.reason).toBe('insufficient-entitlement-time')
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

  it('still lets an admin session pick a normal 30-180 duration, and still validates it', async () => {
    const now = Date.now()
    authorize(now, 6 * HOUR)
    const admin = socketWithCookie(await cookieFor({ adminPass: signPass() }))
    create(admin, { ...BASE, durationMinutes: 90 })
    expect(admin.last('class.ok')?.activeUntil).toBeGreaterThanOrEqual(now + 90 * MIN)
    expect(admin.last('class.ok')?.activeUntil).toBeLessThan(now + 90 * MIN + 5_000)
    for (const [index, bad] of [29, 181, Number.NaN, 'x'].entries()) {
      create(admin, { ...BASE, durationMinutes: bad }, `B2CD4${'0123'[index]}`)
      expect(admin.last('class.err')?.reason).toBe('invalid-class-duration')
    }
  })
})

describe('non-admin sessions never get an unlimited class', () => {
  it('rejects durationMinutes:null from a fake-socket (non-admin) session', () => {
    authorize(Date.now(), 6 * HOUR)
    const sock = new FakeSocket()
    sock.instructorSessionAuthorized = true // instructor session, admin flag NOT set
    create(sock, { ...BASE, durationMinutes: null })
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  it('rejects durationMinutes:null from a real access-code session', async () => {
    authorize(Date.now(), 6 * HOUR)
    await relay.handleInstructorAccessHttp(
      mockReq('POST', '/api/instructor-access/provision', { code: 'Rotate Safely 2026' }, {
        'x-classroom-admin-token': 'ADMIN-UNLIMITED-TOKEN',
      }),
      mockRes(),
    )
    const sock = socketWithCookie(await cookieFor({ code: 'Rotate Safely 2026' }))
    create(sock, { ...BASE, durationMinutes: null })
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  it('keeps 30..180 validation and the 60 min default for non-admin sessions', () => {
    const now = Date.now()
    authorize(now, 6 * HOUR)
    const sock = new FakeSocket()
    sock.instructorSessionAuthorized = true
    for (const [index, bad] of [29, 181, Number.NaN, 'abc', -5].entries()) {
      create(sock, { ...BASE, durationMinutes: bad }, `B2CF${index}F`)
      expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    }
    create(sock, BASE) // durationMinutes omitted -> 60
    const until = sock.last('class.ok')!.activeUntil!
    expect(until).toBeGreaterThanOrEqual(now + 60 * MIN)
    expect(until).toBeLessThan(now + 60 * MIN + 5_000)
  })

  it('a non-admin 60 min class still enters debrief at 61 min (contrast)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T08:00:00.000Z'))
    const bound = authorize(Date.now(), 6 * HOUR)
    const sock = new FakeSocket()
    sock.instructorSessionAuthorized = true
    create(sock, BASE)
    vi.advanceTimersByTime(61 * MIN)
    heartbeat(bound / 1000)
    const ada = new FakeSocket()
    ada.instructorSessionAuthorized = true
    relay.handle(ada, { v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Ada', studentPubKey: 'PUB' })
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('debrief')
  })

  it('does not honour a client-supplied admin flag on the wire', () => {
    authorize(Date.now(), 6 * HOUR)
    const sock = new FakeSocket()
    sock.instructorSessionAuthorized = true
    relay.handle(sock, {
      v: 3, type: 'class.create', classId: CLASS_ID, classPubKey: 'IPUB',
      admin: true, instructorSessionAdmin: true, config: { ...BASE, durationMinutes: null, admin: true },
    })
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
  })
})

// ── client: restart gate on the student side ──────────────────────────────────

const CS_CLASS_ID: ClassId = 'B2CD3F'
const STUDENT_ID = 'stu-ada'

function configWith(durationMinutes: number | null | undefined): ClassConfig {
  return {
    kind: 'catalog',
    scenarioId: 'demo_basic',
    variant: {
      seed: 7, timeOfDay: 'day', season: 'summer',
      weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
    },
    ...(durationMinutes === undefined ? {} : { durationMinutes }),
  }
}

class FakeWs {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWs.OPEN
  bufferedAmount = 0
  sent: Array<{ type: string; studentPubKey?: string; sealed?: Sealed }> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public readonly url: string) { wsSockets.push(this) }
  send(raw: string): void { this.sent.push(JSON.parse(raw)) }
  close(): void { this.readyState = FakeWs.CLOSED }
  deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }) }
}

let wsSockets: FakeWs[] = []
let client: typeof import('@/classroom/classroomClient')

async function liveStudent(config: ClassConfig) {
  client.joinClass(CS_CLASS_ID, 'Ada', true)
  const socket = wsSockets[0]
  socket.onopen?.()
  const instructor = generateKeyPair()
  const studentPubKey = socket.sent[0].studentPubKey!
  socket.deliver({
    v: 3, type: 'join.ok', classId: CS_CLASS_ID, studentId: STUDENT_ID,
    classPubKey: instructor.publicKey,
    classKeyFingerprint: publicKeyFingerprint(instructor.publicKey),
    config,
  })
  await vi.waitFor(() => expect(useClassroomStore.getState().status).toBe('live'))
  return { socket, cipher: SessionCipher.forInstructor(instructor.secretKey, studentPubKey, CS_CLASS_ID) }
}

describe('client restart gate honours an explicit null duration', () => {
  beforeEach(async () => {
    wsSockets = []
    vi.stubGlobal('WebSocket', FakeWs)
    vi.stubEnv('VITE_CLASSROOM_WS_URL', 'ws://relay.test')
    client = await import('@/classroom/classroomClient')
    client.teardown()
    useClassroomStore.getState().reset()
  })

  afterEach(() => {
    client.teardown()
    stopTicking()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function restartAfter61Min(durationMinutes: number | null | undefined) {
    const { socket, cipher } = await liveStudent(configWith(durationMinutes))
    // Students do not set sessionStartedAt today; pin it 61 minutes in the past so the gate is live.
    useClassroomStore.setState({ sessionStartedAt: Date.now() - 61 * MIN })
    socket.deliver({
      v: 3, type: 'command', classId: CS_CLASS_ID, commandKind: 'restart',
      sealed: cipher.seal(
        { seq: 1, body: { commandId: 'cmd-restart', kind: 'restart' } },
        { direction: 'instructor-to-student', type: 'class.command' },
      ),
    })
    const ack = socket.sent.filter((m) => m.type === 'student.ack')
    expect(ack).toHaveLength(1)
    return cipher.open(ack[0].sealed!, { direction: 'student-to-instructor', type: 'student.ack' }) as {
      body: { ok: boolean; code?: string; message?: string }
    }
  }

  it('does not reject restart for a null-duration class 61 minutes in', async () => {
    const ack = await restartAfter61Min(null)
    expect(ack.body.ok).toBe(true)
    expect(useClassroomStore.getState().commandRejects).toBe(0)
  })

  it('still rejects restart for an undefined-duration (60 min default) class at 61 minutes', async () => {
    const ack = await restartAfter61Min(undefined)
    expect(ack.body).toMatchObject({ ok: false, code: 'rejected' })
    expect(ack.body.message).toMatch(/Class time limit reached/)
  })

  it('still rejects restart for an explicit 60 min class at 61 minutes', async () => {
    const ack = await restartAfter61Min(60)
    expect(ack.body).toMatchObject({ ok: false, code: 'rejected' })
  })
})
