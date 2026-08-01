import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rm,
  stat,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import { WebSocket, type WebSocketServer } from 'ws'

const testRoot = path.join(tmpdir(), `drone-relay-boundaries-${process.pid}`)
const testSecretsDir = path.join(testRoot, 'secrets')
const testRunsDir = path.join(testRoot, 'runs')
mkdirSync(testSecretsDir, { recursive: true })
mkdirSync(testRunsDir, { recursive: true })
process.env.CLASSROOM_SECRETS_DIR = testSecretsDir
process.env.CLASSROOM_RUNS_DIR = testRunsDir
process.env.CLASSROOM_ADMIN_TOKEN = 'BOUNDARY-ADMIN-TOKEN'
process.env.CLASSROOM_TEST_SOCKET_AUTH = '1'
process.env.CLASSROOM_TEST_SPOOF_IP = '1'

interface BoundaryValues {
  MAX_SOCKETS: number
  MAX_SOCKETS_PER_IP: number
  MAX_UPGRADES_PER_IP_PER_MIN: number
  MAX_MESSAGE_BYTES: number
  HANDSHAKE_TIMEOUT_MS: number
  MESSAGE_RATE_PER_SEC: number
  MESSAGE_BURST: number
  BACKUP_WRITES_PER_MIN: number
  BACKUP_RETENTION_MS: number
  BACKUP_QUOTA_BYTES: number
}

interface Relay {
  RELAY_BOUNDARIES: BoundaryValues
  classes: Map<string, unknown>
  handle(sock: FakeSocket, msg: Record<string, unknown>): void
  handleInstructorAccessHttp(req: unknown, res: unknown): Promise<boolean>
  injectCredentialMigrationDeletionFailureForTests(fileName?: string | null): void
  resetRelayState(): void
  startRelay(port?: number): {
    server: Server
    wss: WebSocketServer
  }
}

interface WireMessage {
  type: string
  studentId?: string
  reason?: string
}

class FakeSocket {
  readyState = WebSocket.OPEN
  sent: WireMessage[] = []
  role?: string
  classId?: string
  studentId?: string
  instructorSessionAuthorized = true
  connectionIp = '127.0.0.1'
  transportTrusted = true

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as WireMessage)
  }

  close(): void {}

  last(type: string): WireMessage | undefined {
    return this.sent.filter((message) => message.type === type).at(-1)
  }
}

const relayUrl = new URL('../../server/classroom.mjs', import.meta.url).href
let relay: Relay

beforeAll(async () => {
  relay = await import(/* @vite-ignore */ relayUrl) as unknown as Relay
})

beforeEach(async () => {
  relay.resetRelayState()
  await rm(testSecretsDir, { recursive: true, force: true })
  await rm(testRunsDir, { recursive: true, force: true })
  await mkdir(testSecretsDir, { recursive: true })
  await mkdir(testRunsDir, { recursive: true })
})

afterEach(() => {
  relay.resetRelayState()
})

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true })
  delete process.env.CLASSROOM_SECRETS_DIR
  delete process.env.CLASSROOM_RUNS_DIR
  delete process.env.CLASSROOM_ADMIN_TOKEN
  delete process.env.CLASSROOM_TEST_SOCKET_AUTH
  delete process.env.CLASSROOM_TEST_SPOOF_IP
})

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
  options: {
    ip?: string
    headers?: Record<string, string>
    body?: Record<string, unknown>
  } = {},
) {
  return {
    method,
    url,
    headers: options.headers ?? {},
    socket: { remoteAddress: options.ip ?? '127.0.0.1', encrypted: false },
    async *[Symbol.asyncIterator]() {
      if (options.body) yield Buffer.from(JSON.stringify(options.body))
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for relay side effect')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

function openClassWithStudent(classId = 'RVN999') {
  const instructor = new FakeSocket()
  relay.handle(instructor, {
    v: 3,
    type: 'class.create',
    classId,
    classPubKey: 'INSTRUCTOR-PUBLIC-KEY',
    config: { kind: 'catalog', scenarioId: 'demo', variant: { seed: 17 } },
  })
  const student = new FakeSocket()
  relay.handle(student, {
    v: 3,
    type: 'student.join',
    classId,
    displayName: 'Boundary Student',
    studentPubKey: 'STUDENT-PUBLIC-KEY',
  })
  const studentId = student.last('join.ok')?.studentId
  if (!studentId) throw new Error('student did not join')
  return { instructor, student, studentId, classId }
}

function submitRun(student: FakeSocket, classId: string): void {
  relay.handle(student, {
    v: 3,
    type: 'student.run',
    classId,
    sealed: { iv: 'BOUNDARY-IV', ct: 'BOUNDARY-CIPHERTEXT' },
  })
}

async function startLiveRelay() {
  const instance = relay.startRelay(0)
  if (!instance.server.listening) await once(instance.server, 'listening')
  const address = instance.server.address()
  if (!address || typeof address === 'string') throw new Error('relay has no TCP address')
  const authority = `127.0.0.1:${address.port}`
  return {
    ...instance,
    url: `ws://${authority}`,
    origin: `http://${authority}`,
  }
}

function connect(url: string, origin: string, sourceIp?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Origin: origin,
        ...(sourceIp ? { 'X-Classroom-Test-IP': sourceIp } : {}),
      },
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
    socket.once('unexpected-response', (_request, response) => {
      response.resume()
      reject(new Error(`unexpected HTTP ${response.statusCode}`))
    })
  })
}

function rejectedStatus(
  url: string,
  origin: string,
  sourceIp?: string,
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        Origin: origin,
        ...(sourceIp ? { 'X-Classroom-Test-IP': sourceIp } : {}),
      },
    })
    socket.once('open', () => {
      socket.close()
      reject(new Error('connection unexpectedly opened'))
    })
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode
      response.resume()
      resolve(status)
    })
    socket.once('error', reject)
  })
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return
  const closed = once(socket, 'close')
  socket.close()
  await closed
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function closeLiveRelay(instance: {
  server: Server
  wss: WebSocketServer
}): Promise<void> {
  for (const client of instance.wss.clients) client.terminate()
  await new Promise<void>((resolve) => instance.wss.close(() => resolve()))
  if (instance.server.listening) {
    await new Promise<void>((resolve, reject) => {
      instance.server.close((error) => error ? reject(error) : resolve())
    })
  }
}

describe('credential reset failure acceptance', () => {
  it('returns reset-failed when a credential path cannot be deleted', async () => {
    const undeletablePath = path.join(testSecretsDir, 'instructor-access-code.txt')
    await mkdir(undeletablePath)
    try {
      const response = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/reset', {
          headers: { 'x-classroom-admin-token': 'BOUNDARY-ADMIN-TOKEN' },
        }),
        response,
      )

      expect(response.status).toBe(500)
      expect(response.parsed).toEqual({ ok: false, error: 'reset-failed' })
      expect(response.headers['set-cookie']).toContain('Max-Age=0')
      expect(existsSync(undeletablePath)).toBe(true)
    } finally {
      await rm(undeletablePath, { recursive: true, force: true })
    }
  })
})

describe('credential migration rollback acceptance', () => {
  it('keeps plaintext authoritative and removes v2 when plaintext deletion fails', async () => {
    const legacyPath = path.join(testSecretsDir, 'instructor-access-code.txt')
    const verifierPath = path.join(testSecretsDir, 'instructor-access-v2.json')
    await writeFile(legacyPath, '# legacy recovery\nLegacy School Code\n', 'utf8')
    relay.injectCredentialMigrationDeletionFailureForTests('instructor-access-code.txt')

    const response = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', {
        body: { code: 'Legacy School Code' },
      }),
      response,
    )

    expect(response.status).toBe(500)
    expect(response.parsed).toEqual({ ok: false, error: 'verification-failed' })
    expect(await readFile(legacyPath, 'utf8')).toContain('Legacy School Code')
    expect(existsSync(verifierPath)).toBe(false)
  })

  it('keeps the legacy hash and removes v2 when hash deletion fails', async () => {
    const legacyPath = path.join(testSecretsDir, 'instructor-access-hash.txt')
    const verifierPath = path.join(testSecretsDir, 'instructor-access-v2.json')
    const code = 'Legacy Hash Code'
    const legacyNormalized = code.replace(/\s+/g, '')
    const hash = createHash('sha256').update(legacyNormalized, 'utf8').digest('hex')
    await writeFile(legacyPath, `${hash}\n`, 'utf8')
    relay.injectCredentialMigrationDeletionFailureForTests('instructor-access-hash.txt')

    const response = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', {
        body: { code },
      }),
      response,
    )

    expect(response.status).toBe(500)
    expect(response.parsed).toEqual({ ok: false, error: 'verification-failed' })
    expect((await readFile(legacyPath, 'utf8')).trim()).toBe(hash)
    expect(existsSync(verifierPath)).toBe(false)
  })
})

describe('global instructor verification limit', () => {
  it('blocks verification after 30 failures distributed across distinct loopback IPs', async () => {
    const code = 'Global Limit Code 2026'
    const provision = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/provision', {
        headers: { 'x-classroom-admin-token': 'BOUNDARY-ADMIN-TOKEN' },
        body: { code },
      }),
      provision,
    )
    expect(provision.status).toBe(201)

    for (let attempt = 0; attempt < 30; attempt++) {
      const response = mockHttpRes()
      await relay.handleInstructorAccessHttp(
        mockHttpReq('POST', '/api/instructor-access/session', {
          ip: `127.0.0.${attempt + 1}`,
          body: { code: 'Incorrect Global Code' },
        }),
        response,
      )
      expect(response.status).toBe(401)
    }

    const blocked = mockHttpRes()
    await relay.handleInstructorAccessHttp(
      mockHttpReq('POST', '/api/instructor-access/session', {
        ip: '127.0.1.1',
        body: { code },
      }),
      blocked,
    )
    expect(blocked.status).toBe(429)
    expect(blocked.parsed).toEqual({ ok: false, error: 'rate-limited' })
  })
})

describe('live relay WebSocket limits', () => {
  it('rejects a payload larger than the configured pre-allocation limit', async () => {
    const live = await startLiveRelay()
    try {
      const socket = await connect(live.url, live.origin)
      const closed = once(socket, 'close')
      socket.send(Buffer.alloc(relay.RELAY_BOUNDARIES.MAX_MESSAGE_BYTES + 1))
      const [code] = await closed
      expect(code).toBe(1009)
    } finally {
      await closeLiveRelay(live)
    }
  })

  it('rejects the next concurrent connection from an IP at the per-IP cap', async () => {
    const live = await startLiveRelay()
    const sockets: WebSocket[] = []
    try {
      for (let index = 0; index < relay.RELAY_BOUNDARIES.MAX_SOCKETS_PER_IP; index++) {
        sockets.push(await connect(live.url, live.origin))
      }
      expect(await rejectedStatus(live.url, live.origin)).toBe(429)
    } finally {
      await Promise.all(sockets.map(closeSocket))
      await closeLiveRelay(live)
    }
  })

  it('rejects the next connection when 96 sockets are active across distinct IPs', async () => {
    const live = await startLiveRelay()
    const sockets: WebSocket[] = []
    try {
      for (let index = 0; index < relay.RELAY_BOUNDARIES.MAX_SOCKETS; index++) {
        sockets.push(await connect(live.url, live.origin, `198.51.100.${index + 1}`))
      }
      expect(
        await rejectedStatus(live.url, live.origin, '203.0.113.1'),
      ).toBe(429)
    } finally {
      await Promise.all(sockets.map(closeSocket))
      await closeLiveRelay(live)
    }
  })

  it('rejects an IP after the rolling upgrade budget is consumed', async () => {
    const live = await startLiveRelay()
    try {
      for (let index = 0; index < relay.RELAY_BOUNDARIES.MAX_UPGRADES_PER_IP_PER_MIN; index++) {
        const socket = await connect(live.url, live.origin)
        await closeSocket(socket)
      }
      expect(await rejectedStatus(live.url, live.origin)).toBe(429)
    } finally {
      await closeLiveRelay(live)
    }
  })

  it('closes a socket that exhausts the message burst', async () => {
    const live = await startLiveRelay()
    try {
      const socket = await connect(live.url, live.origin)
      const closed = once(socket, 'close')
      for (let index = 0; index <= relay.RELAY_BOUNDARIES.MESSAGE_BURST; index++) {
        socket.send('{}')
      }
      const [code, reason] = await closed
      expect(code).toBe(4008)
      expect(reason.toString()).toBe('message-rate-limit')
    } finally {
      await closeLiveRelay(live)
    }
  })

  it('refills exactly 16 message tokens after one sustained second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
    const live = await startLiveRelay()
    try {
      const socket = await connect(live.url, live.origin)
      const message = JSON.stringify({ v: 3, type: 'unknown' })
      for (let index = 0; index < relay.RELAY_BOUNDARIES.MESSAGE_BURST; index++) {
        socket.send(message)
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(socket.readyState).toBe(WebSocket.OPEN)

      vi.setSystemTime(new Date('2026-07-28T12:00:01.000Z'))
      const closed = once(socket, 'close')
      for (let index = 0; index <= relay.RELAY_BOUNDARIES.MESSAGE_RATE_PER_SEC; index++) {
        socket.send(message)
      }
      const [code, reason] = await closed
      expect(code).toBe(4008)
      expect(reason.toString()).toBe('message-rate-limit')
    } finally {
      await closeLiveRelay(live)
      vi.useRealTimers()
    }
  })

  it('closes a socket that never completes its role handshake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const live = await startLiveRelay()
    try {
      const socket = await connect(live.url, live.origin)
      const closed = once(socket, 'close')
      await vi.advanceTimersByTimeAsync(relay.RELAY_BOUNDARIES.HANDSHAKE_TIMEOUT_MS)
      const [code, reason] = await closed
      expect(code).toBe(4002)
      expect(reason.toString()).toBe('handshake-timeout')
    } finally {
      await closeLiveRelay(live)
      vi.useRealTimers()
    }
  })
})

describe('filesystem backup pruning acceptance', () => {
  it('warns and continues forwarding when active backups leave quota unpruneable', async () => {
    const active = openClassWithStudent('RVN995')
    const activeDirectory = path.join(testRunsDir, active.classId)
    const quotaOccupant = path.join(activeDirectory, 'active-quota.json')
    const attemptedBackup = path.join(activeDirectory, `${active.studentId}.json`)
    await mkdir(activeDirectory)
    await writeFile(quotaOccupant, '')
    await truncate(
      quotaOccupant,
      relay.RELAY_BOUNDARIES.BACKUP_QUOTA_BYTES + 1_024,
    )

    submitRun(active.student, active.classId)
    expect(active.instructor.last('student.run')).toBeDefined()
    await waitFor(() => active.instructor.last('backup.warn')?.reason === 'quota-limited')

    expect(active.instructor.last('backup.warn')).toMatchObject({
      type: 'backup.warn',
      reason: 'quota-limited',
    })
    expect(existsSync(quotaOccupant)).toBe(true)
    expect(existsSync(attemptedBackup)).toBe(false)
  })

  it('starts the retention window when a class closes, not at its last backup write', async () => {
    const closedClass = openClassWithStudent('RVN997')
    submitRun(closedClass.student, closedClass.classId)
    const closedDirectory = path.join(testRunsDir, closedClass.classId)
    const closedBackup = path.join(closedDirectory, `${closedClass.studentId}.json`)
    await waitFor(() => existsSync(closedBackup))

    const expired = new Date(Date.now() - relay.RELAY_BOUNDARIES.BACKUP_RETENTION_MS - 1_000)
    await utimes(closedDirectory, expired, expired)
    const closedAt = Date.now()
    relay.handle(closedClass.instructor, {
      v: 3,
      type: 'class.close',
      classId: closedClass.classId,
    })

    expect((await stat(closedDirectory)).mtimeMs).toBeGreaterThanOrEqual(closedAt - 1_000)

    const currentClass = openClassWithStudent('RVN996')
    submitRun(currentClass.student, currentClass.classId)
    const currentBackup = path.join(
      testRunsDir,
      currentClass.classId,
      `${currentClass.studentId}.json`,
    )
    await waitFor(() => existsSync(currentBackup))

    expect(existsSync(closedBackup)).toBe(true)
    expect(existsSync(currentBackup)).toBe(true)
  })

  it('removes closed class backups older than the retention window before persisting', async () => {
    const oldClassDirectory = path.join(testRunsDir, 'CLD111')
    await mkdir(oldClassDirectory)
    await writeFile(path.join(oldClassDirectory, 'old.json'), 'old ciphertext')
    const expired = new Date(Date.now() - relay.RELAY_BOUNDARIES.BACKUP_RETENTION_MS - 1_000)
    await utimes(oldClassDirectory, expired, expired)

    const { student, studentId, classId } = openClassWithStudent()
    submitRun(student, classId)
    const current = path.join(testRunsDir, classId, `${studentId}.json`)
    await waitFor(() => !existsSync(oldClassDirectory) && existsSync(current))

    expect(existsSync(oldClassDirectory)).toBe(false)
    expect(existsSync(current)).toBe(true)
  })

  it('prunes the oldest closed class when logical backup size exceeds quota', async () => {
    const oldest = path.join(testRunsDir, 'CLD222')
    const newer = path.join(testRunsDir, 'CLD333')
    await mkdir(oldest)
    await mkdir(newer)
    await writeFile(path.join(oldest, 'large.json'), '')
    await truncate(
      path.join(oldest, 'large.json'),
      relay.RELAY_BOUNDARIES.BACKUP_QUOTA_BYTES + 1_024,
    )
    await writeFile(path.join(newer, 'small.json'), 'newer ciphertext')
    const now = Date.now()
    await utimes(oldest, new Date(now - 120_000), new Date(now - 120_000))
    await utimes(newer, new Date(now - 60_000), new Date(now - 60_000))

    const { student, studentId, classId } = openClassWithStudent('RVN998')
    submitRun(student, classId)
    const current = path.join(testRunsDir, classId, `${studentId}.json`)
    await waitFor(() => !existsSync(oldest) && existsSync(current))

    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(newer)).toBe(true)
    expect(existsSync(current)).toBe(true)
  })
})
