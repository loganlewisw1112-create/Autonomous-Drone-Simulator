// Guardrail for the "admins get no class clock" change: every NON-admin classroom path keeps
// today's finite clock. These assertions must hold on the code before the change AND after it,
// except the two `null` cases marked below, which encode the new contract (before the change a
// bare `durationMinutes: null` fell through `?? 60` into a 60-minute class; after it, only a
// verified admin session may ask for it).
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

const testRoot = path.join(tmpdir(), `drone-nonadmin-class-guard-${process.pid}`)
mkdirSync(path.join(testRoot, 'secrets'), { recursive: true })
mkdirSync(path.join(testRoot, 'runs'), { recursive: true })
process.env.CLASSROOM_SECRETS_DIR = path.join(testRoot, 'secrets')
process.env.CLASSROOM_RUNS_DIR = path.join(testRoot, 'runs')
process.env.CLASSROOM_ADMIN_TOKEN = 'NONADMIN-GUARD-ADMIN-TOKEN'
process.env.CLASSROOM_TEST_SOCKET_AUTH = '1'

// The student-side restart test runs the real classroomClient, whose command validator would
// otherwise need a full drone world. Same approach as classroomCommandWire.spec.ts.
vi.mock('@/classroom/commandRegistry', () => ({
  validateInstructorCommand: (value: unknown) => {
    const command = value as { commandId?: unknown; kind?: unknown }
    return (command?.kind === 'pause' || command?.kind === 'restart') && typeof command.commandId === 'string'
      ? { ok: true, command: value }
      : { ok: false, code: 'unknown_command', message: 'Command is not allowed.' }
  },
  executeInstructorCommand: (command: { commandId: string; kind: string }) => ({
    ok: true, commandId: command.commandId, kind: command.kind, affectedDroneIds: [],
  }),
}))

const MIN = 60_000
const CLASS_ID = 'B2CD3F'
const CONFIG = { kind: 'catalog', scenarioId: 'demo', variant: { seed: 7 } }
const SEALED = { iv: 'SEALED-IV', ct: 'SEALED-CT' }

interface WireMsg {
  v: number
  type: string
  classId?: string
  reason?: string
  phase?: string
  instructorToken?: string
  activeUntil?: number
  debriefUntil?: number
  resumeToken?: string
  studentId?: string
}

class FakeSocket {
  readyState = 1
  sent: WireMsg[] = []
  role?: string
  classId?: string
  studentId?: string
  // Direct fake-socket seam (NODE_ENV=test only): a plain access-code instructor, never admin.
  instructorSessionAuthorized = true
  instructorSessionToken?: string
  connectionIp = '127.0.0.1'
  transportTrusted = true
  send(raw: string): void { this.sent.push(JSON.parse(raw) as WireMsg) }
  close(): void { /* not needed */ }
  ofType(type: string): WireMsg[] { return this.sent.filter((m) => m.type === type) }
  last(type?: string): WireMsg | undefined {
    const pool = type ? this.ofType(type) : this.sent
    return pool[pool.length - 1]
  }
}

interface ClassRecord { expiresAt: number; debriefUntil: number; phase: string; createdAt: number }
interface Relay {
  classes: Map<string, ClassRecord>
  handle(sock: FakeSocket, msg: Record<string, unknown>): void
  resetRelayState(): void
  handleInstructorAccessHttp(req: unknown, res: unknown): Promise<boolean>
  authenticateInstructorSocket(sock: FakeSocket, req: unknown): boolean
  setAdminPassTrustForTests(trust: { trustedPublicKeys: string[]; revokedPassIds: string[] } | null): void
  setRelayEntitlementForTests(claims: Record<string, unknown>, now?: number, sequence?: number): void
}

const relayUrl = new URL('../../server/classroom.mjs', import.meta.url).href
let relay: Relay

beforeAll(async () => {
  relay = await import(/* @vite-ignore */ relayUrl) as unknown as Relay
})
beforeEach(() => relay.resetRelayState())
afterEach(() => { vi.useRealTimers() })
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 100))
  await rm(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => { /* temp dir */ })
  delete process.env.CLASSROOM_SECRETS_DIR
  delete process.env.CLASSROOM_RUNS_DIR
  delete process.env.CLASSROOM_ADMIN_TOKEN
  delete process.env.CLASSROOM_TEST_SOCKET_AUTH
})

// ── helpers ───────────────────────────────────────────────────────────────────

function create(sock: FakeSocket, extra: Record<string, unknown> = {}, config: unknown = CONFIG, classId = CLASS_ID) {
  relay.handle(sock, { v: 3, type: 'class.create', classId, classPubKey: 'IPUB', config, ...extra })
}

const withDuration = (durationMinutes: unknown) => ({ ...CONFIG, durationMinutes })

/** Keeps the relay's entitlement heartbeat fresh (it goes stale after 90 s) with a fixed expiry. */
function heartbeat(now: number, expiresAt: number) {
  relay.setRelayEntitlementForTests({
    sub: 'guard-licence',
    exp: Math.floor(expiresAt / 1000),
    offlineUntil: Math.floor(expiresAt / 1000),
    maxConcurrentClasses: 1,
  }, now)
}

function joinStudent(name: string, classId = CLASS_ID) {
  const sock = new FakeSocket()
  relay.handle(sock, { v: 3, type: 'student.join', classId, displayName: name, studentPubKey: `PUB-${name}` })
  return sock
}

interface HttpRes { status: number; headers: Record<string, string>; parsed: Record<string, unknown> | null }
function mockRes() {
  let status = 0
  let body = ''
  let headers: Record<string, string> = {}
  return {
    get status() { return status },
    get headers() { return headers },
    get parsed() { return body ? JSON.parse(body) as Record<string, unknown> : null },
    writeHead(code: number, next: Record<string, string> = {}) { status = code; headers = next },
    end(data?: string) { body = data ?? '' },
  } as HttpRes & { writeHead: (c: number, h?: Record<string, string>) => void; end: (d?: string) => void }
}
function mockReq(method: string, url: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const raw = Buffer.from(body ? JSON.stringify(body) : '')
  return {
    method, url,
    headers: { 'content-type': 'application/json', 'content-length': String(raw.length), ...headers },
    socket: { remoteAddress: '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() { if (raw.length) yield raw },
  }
}
async function http(method: string, url: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = mockRes()
  await relay.handleInstructorAccessHttp(mockReq(method, url, body, headers), res)
  return res
}

/** A real (non-seam) instructor socket authenticated by the access-code session cookie. */
async function accessCodeSocket(code = 'Guard Access Code 2026'): Promise<FakeSocket> {
  await http('POST', '/api/instructor-access/provision', { code }, { 'x-classroom-admin-token': 'NONADMIN-GUARD-ADMIN-TOKEN' })
  const login = await http('POST', '/api/instructor-access/session', { code })
  expect(login.status).toBe(200)
  const cookie = login.headers['set-cookie'].split(';')[0]
  const sock = new FakeSocket()
  sock.instructorSessionAuthorized = false
  expect(relay.authenticateInstructorSocket(sock, mockReq('GET', '/', undefined, { cookie }))).toBe(true)
  return sock
}

const trusted = ed25519.keygen()
const stranger = ed25519.keygen()
const trustedPub = bytesToBase64Url(trusted.publicKey)
function sign(payload: Record<string, unknown>, secretKey = trusted.secretKey) {
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}
const claims = { v: 1, email: 'owner@example.com', name: 'Owner', passId: 'adm-guard-1', issuedAt: Date.now() - 1000 }

// ── 1. durations an access-code instructor can ask for ────────────────────────

describe('non-admin instructor: class duration is always finite and validated', () => {
  const REJECTED: Array<[string, unknown]> = [
    ["'unlimited'", 'unlimited'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['29 (below the 30 minimum)', 29],
    ['181 (above the 180 maximum)', 181],
    ['1e9', 1e9],
    ['0', 0],
    ['-60', -60],
    ["''", ''],
    ['an object', { minutes: 60 }],
  ]

  it.each(REJECTED)('seam session sending durationMinutes %s gets invalid-class-duration and no class', (_label, value) => {
    const sock = new FakeSocket()
    create(sock, {}, withDuration(value))
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(sock.ofType('class.ok')).toHaveLength(0)
    expect(relay.classes.size).toBe(0)
  })

  it.each(REJECTED)('real access-code session sending durationMinutes %s gets invalid-class-duration', async (_label, value) => {
    const sock = await accessCodeSocket()
    create(sock, {}, withDuration(value))
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  // NEW CONTRACT: fails on the pre-change relay (null fell through `?? 60`), must pass after it.
  it('seam session sending durationMinutes null gets invalid-class-duration', () => {
    const sock = new FakeSocket()
    create(sock, {}, withDuration(null))
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  // NEW CONTRACT, as above, over a genuine access-code cookie session.
  it('real access-code session sending durationMinutes null gets invalid-class-duration', async () => {
    const sock = await accessCodeSocket()
    create(sock, {}, withDuration(null))
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  it.each([30, 60, 90, 180])('accepts %i minutes and stamps exactly that finite window + 15-minute debrief', (minutes) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-10-10T12:00:00.000Z')
    vi.setSystemTime(t0)
    heartbeat(t0, t0 + 6 * 60 * MIN)
    const sock = new FakeSocket()
    create(sock, {}, withDuration(minutes))
    expect(sock.last('class.ok')?.classId).toBe(CLASS_ID)
    const cls = relay.classes.get(CLASS_ID)!
    expect(cls.expiresAt).toBe(t0 + minutes * MIN)
    expect(cls.debriefUntil).toBe(t0 + (minutes + 15) * MIN)
    expect(Number.isFinite(cls.expiresAt)).toBe(true)
    expect(cls.phase).toBe('active')
  })

  it('a class created with no duration at all is the 60-minute default', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-10-10T12:00:00.000Z')
    vi.setSystemTime(t0)
    heartbeat(t0, t0 + 6 * 60 * MIN)
    const sock = new FakeSocket()
    create(sock)
    expect(relay.classes.get(CLASS_ID)!.expiresAt).toBe(t0 + 60 * MIN)
  })

  it('a finite class still has to fit inside the licence entitlement', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-10-10T12:00:00.000Z')
    vi.setSystemTime(t0)
    heartbeat(t0, t0 + 44 * MIN)
    const sock = new FakeSocket()
    create(sock, {}, withDuration(30))
    expect(sock.last('class.err')?.reason).toBe('insufficient-entitlement-time')
  })
})

// ── 2. the clock actually runs for a non-admin class ──────────────────────────

describe('non-admin class: scheduled end, debrief, close', () => {
  it('a 60-minute class stays active at 59:59, enters debrief "scheduled-end" at 60:00, closes 15 minutes later', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-10-10T12:00:00.000Z')
    vi.setSystemTime(t0)
    const entitlementEnd = t0 + 6 * 60 * MIN
    heartbeat(t0, entitlementEnd)

    const instructor = new FakeSocket()
    create(instructor, {}, withDuration(60))
    expect(instructor.last('class.ok')).toBeDefined()
    const ada = joinStudent('Ada')
    expect(ada.last('join.ok')).toBeDefined()
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('active')

    vi.setSystemTime(t0 + 60 * MIN - 1_000)
    heartbeat(Date.now(), entitlementEnd)
    const early = joinStudent('Early')
    expect(early.last('join.ok')).toBeDefined()
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('active')
    expect(instructor.ofType('class.state').filter((m) => m.reason === 'scheduled-end')).toHaveLength(0)

    vi.setSystemTime(t0 + 60 * MIN)
    heartbeat(Date.now(), entitlementEnd)
    const late = joinStudent('Late')
    expect(late.last('join.err')?.reason).toBe('class-not-accepting-new-students')
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('debrief')
    const ended = instructor.ofType('class.state').filter((m) => m.reason === 'scheduled-end')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ phase: 'debrief', activeUntil: t0 + 60 * MIN, debriefUntil: t0 + 75 * MIN })
    expect(ada.ofType('class.state').some((m) => m.reason === 'scheduled-end')).toBe(true)

    // Debrief permits recovery commands only: a restart (new mission) stays refused.
    const token = instructor.last('class.ok')!.instructorToken
    const adaId = ada.last('join.ok')!.studentId
    instructor.sent.length = 0
    relay.handle(instructor, {
      v: 3, type: 'class.command.batch', classId: CLASS_ID, instructorToken: token,
      commandKind: 'restart', items: [{ studentId: adaId, sealed: SEALED }],
    })
    expect(instructor.last('class.err')?.reason).toBe('command-not-allowed-during-debrief')

    vi.setSystemTime(t0 + 75 * MIN)
    heartbeat(Date.now(), entitlementEnd)
    joinStudent('Afterwards')
    expect(relay.classes.has(CLASS_ID)).toBe(false)
  })

  it('a real access-code class (cookie session) ends on the same schedule', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.parse('2026-10-10T12:00:00.000Z')
    vi.setSystemTime(t0)
    const entitlementEnd = t0 + 6 * 60 * MIN
    heartbeat(t0, entitlementEnd)
    const instructor = await accessCodeSocket()
    create(instructor, {}, withDuration(60))
    expect(instructor.last('class.ok')).toBeDefined()
    expect(relay.classes.get(CLASS_ID)!.expiresAt).toBe(t0 + 60 * MIN)

    vi.setSystemTime(t0 + 60 * MIN)
    heartbeat(Date.now(), entitlementEnd)
    joinStudent('Late')
    expect(relay.classes.get(CLASS_ID)!.phase).toBe('debrief')
    expect(instructor.ofType('class.state').some((m) => m.reason === 'scheduled-end')).toBe(true)
  })
})

// ── 3. nothing a client can send makes a session admin ────────────────────────

describe('admin-ness cannot be minted from the wire or from a bad pass', () => {
  it('forged, tampered, revoked and expired passes get 401 invalid-admin-pass and no cookie', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [trustedPub], revokedPassIds: ['adm-revoked'] })
    const [prefix, , sig] = sign(claims).split('.')
    const edited = `${prefix}.${bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, email: 'x@y.zz' })))}.${sig}`
    const bad: Array<[string, unknown]> = [
      ['signed by a stranger', sign(claims, stranger.secretKey)],
      ['edited payload', edited],
      ['revoked passId', sign({ ...claims, passId: 'adm-revoked' })],
      ['expired', sign({ ...claims, expiresAt: Date.now() - 1 })],
      ['garbage', 'DSA1.bad.bad'],
      ['non-string', { pass: sign(claims) }],
      ['empty string', ''],
    ]
    for (const [label, adminPass] of bad) {
      relay.resetRelayState()
      relay.setAdminPassTrustForTests({ trustedPublicKeys: [trustedPub], revokedPassIds: ['adm-revoked'] })
      const res = await http('POST', '/api/instructor-access/session', { adminPass })
      expect(res.status, label).toBe(401)
      expect(res.parsed, label).toEqual({ ok: false, error: 'invalid-admin-pass' })
      expect(res.headers['set-cookie'], label).toBeUndefined()
    }
  })

  it('the shipped production trust refuses a throwaway-signed pass', async () => {
    relay.setAdminPassTrustForTests(null)
    const res = await http('POST', '/api/instructor-access/session', { adminPass: sign(claims) })
    expect(res.status).toBe(401)
    expect(res.parsed).toEqual({ ok: false, error: 'invalid-admin-pass' })
  })

  it('a bad pass sent with a valid access code does not fall back to the code path', async () => {
    const code = 'Guard Access Code 2026'
    await http('POST', '/api/instructor-access/provision', { code }, { 'x-classroom-admin-token': 'NONADMIN-GUARD-ADMIN-TOKEN' })
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [trustedPub], revokedPassIds: [] })
    const res = await http('POST', '/api/instructor-access/session', { code, adminPass: sign(claims, stranger.secretKey) })
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('a valid pass sent over the WebSocket (class.create fields, config fields, class.* messages) changes nothing', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [trustedPub], revokedPassIds: [] })
    const validPass = sign(claims)
    const spoofs: Array<Record<string, unknown>> = [
      { adminPass: validPass },
      { admin: true },
      { isAdmin: true },
      { instructorSessionAdmin: true },
      { session: { admin: true } },
      { adminEmail: 'owner@example.com' },
    ]
    for (const spoof of spoofs) {
      for (const sock of [new FakeSocket(), await accessCodeSocket()]) {
        // Spoof fields at the message level and inside config; duration null must still be refused.
        create(sock, spoof, { ...withDuration(null), ...spoof })
        expect(sock.last('class.err')?.reason, JSON.stringify(spoof)).toBe('invalid-class-duration')
        expect(relay.classes.size).toBe(0)
      }
    }
    // Unknown message types carrying admin material are ignored without creating a session or a class.
    const sock = new FakeSocket()
    for (const type of ['admin.elevate', 'instructor.admin', 'class.admin', 'auth.admin']) {
      relay.handle(sock, { v: 3, type, adminPass: validPass, admin: true })
    }
    create(sock, {}, withDuration(null))
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
    expect(relay.classes.size).toBe(0)
  })

  it('a socket admin property is not copied from the wire: only the server-side session decides', async () => {
    // Wire fields can never write onto the socket object itself.
    const sock = new FakeSocket()
    create(sock, { instructorSessionAdmin: true, instructorSessionAuthorized: true, role: 'admin' }, withDuration(29))
    expect((sock as unknown as Record<string, unknown>).instructorSessionAdmin).toBeUndefined()
    expect(sock.last('class.err')?.reason).toBe('invalid-class-duration')
  })

  it('an access-code session stays non-admin even after a valid-pass login from the same address', async () => {
    relay.setAdminPassTrustForTests({ trustedPublicKeys: [trustedPub], revokedPassIds: [] })
    const codeSock = await accessCodeSocket()
    const adminLogin = await http('POST', '/api/instructor-access/session', { adminPass: sign(claims) })
    expect(adminLogin.status).toBe(200)
    create(codeSock, {}, withDuration(181))
    expect(codeSock.last('class.err')?.reason).toBe('invalid-class-duration')
    create(codeSock, {}, withDuration(null), 'B2CD4F')
    expect(codeSock.last('class.err')?.reason).toBe('invalid-class-duration')
  })
})

// ── 4. student-side restart after the class limit ─────────────────────────────

interface ClientEnvelope {
  v: 3
  type: string
  classId: ClassId
  studentPubKey?: string
  sealed?: Sealed
}

describe('classroomClient: restart after the class limit stays rejected for a numeric-duration class', () => {
  class FakeWs {
    static readonly OPEN = 1
    static readonly CLOSED = 3
    readyState = FakeWs.OPEN
    bufferedAmount = 0
    sent: ClientEnvelope[] = []
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(public readonly url: string) { sockets.push(this) }
    send(raw: string): void { this.sent.push(JSON.parse(raw) as ClientEnvelope) }
    close(): void { this.readyState = FakeWs.CLOSED }
    deliver(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) }) }
  }
  let sockets: FakeWs[] = []
  let client: typeof import('@/classroom/classroomClient')

  beforeEach(async () => {
    sockets = []
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

  const STUDENT_ID = 'stu-ada'
  const variant = {
    seed: 7, timeOfDay: 'day', season: 'summer', weatherSeverity: 0, commsDegradation: 0,
    thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  } as const

  async function liveStudent(config: ClassConfig) {
    client.joinClass(CLASS_ID, 'Ada', true)
    const socket = sockets[0]
    socket.onopen?.()
    const instructor = generateKeyPair()
    const studentPubKey = socket.sent[0].studentPubKey!
    socket.deliver({
      v: 3, type: 'join.ok', classId: CLASS_ID, studentId: STUDENT_ID,
      classPubKey: instructor.publicKey,
      classKeyFingerprint: publicKeyFingerprint(instructor.publicKey),
      config,
    })
    await vi.waitFor(() => expect(useClassroomStore.getState().status).toBe('live'))
    return { socket, cipher: SessionCipher.forInstructor(instructor.secretKey, studentPubKey, CLASS_ID) }
  }

  function deliverCommand(socket: FakeWs, cipher: SessionCipher, seq: number, commandId: string, kind: 'restart' | 'pause') {
    socket.deliver({
      v: 3, type: 'command', classId: CLASS_ID, commandKind: kind,
      sealed: cipher.seal({ seq, body: { commandId, kind } }, { direction: 'instructor-to-student', type: 'class.command' }),
    })
  }

  function ackFor(socket: FakeWs, cipher: SessionCipher, commandId: string) {
    return socket.sent
      .filter((m) => m.type === 'student.ack')
      .map((m) => cipher.open<{ commandId: string; ok: boolean; code?: string; message?: string }>(m.sealed!, {
        direction: 'student-to-instructor', type: 'student.ack',
      }))
      .map((p) => (p as unknown as { body: { commandId: string; ok: boolean; code?: string; message?: string } }).body)
      .find((b) => b.commandId === commandId)
  }

  it.each([30, 60, 180])('refuses a restart once the %i-minute window has elapsed, with the time-limit message', async (minutes) => {
    const { socket, cipher } = await liveStudent({ kind: 'catalog', scenarioId: 'demo_basic', variant, durationMinutes: minutes })
    // The class clock reading the client consults (set by the instructor build; set directly here).
    useClassroomStore.setState({ sessionStartedAt: Date.now() - minutes * MIN - 1_000 })

    deliverCommand(socket, cipher, 1, 'cmd-restart', 'restart')
    const ack = ackFor(socket, cipher, 'cmd-restart')
    expect(ack).toMatchObject({ ok: false, code: 'rejected' })
    expect(ack?.message).toContain('Class time limit reached')
    expect(useClassroomStore.getState().interventions).toHaveLength(0)
  })

  it('still executes a restart inside the window and a non-restart command after it', async () => {
    const { socket, cipher } = await liveStudent({ kind: 'catalog', scenarioId: 'demo_basic', variant, durationMinutes: 30 })
    useClassroomStore.setState({ sessionStartedAt: Date.now() - 5 * MIN })
    deliverCommand(socket, cipher, 1, 'cmd-inside', 'restart')
    expect(ackFor(socket, cipher, 'cmd-inside')).toMatchObject({ ok: true })

    useClassroomStore.setState({ sessionStartedAt: Date.now() - 31 * MIN })
    deliverCommand(socket, cipher, 2, 'cmd-pause', 'pause')
    expect(ackFor(socket, cipher, 'cmd-pause')).toMatchObject({ ok: true })
  })

  it('a class with no durationMinutes in its config is held to the 60-minute default', async () => {
    const { socket, cipher } = await liveStudent({ kind: 'catalog', scenarioId: 'demo_basic', variant })
    useClassroomStore.setState({ sessionStartedAt: Date.now() - 61 * MIN })
    deliverCommand(socket, cipher, 1, 'cmd-restart', 'restart')
    expect(ackFor(socket, cipher, 'cmd-restart')).toMatchObject({ ok: false, code: 'rejected' })
  })
})
