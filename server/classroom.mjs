// Classroom WebSocket relay — store-and-forward for ciphertext ONLY.
//
// Security model (why this file never touches `sealed`):
//   - Every student payload arrives already encrypted to the instructor's key.
//     This relay routes envelopes by their plaintext string fields (type/classId)
//     and forwards the opaque `sealed` blob untouched. It must NEVER inspect,
//     parse, or open `sealed` — the crypto is the real trust boundary.
//   - The 6-char class code is the ONLY join token. Anyone on the LAN who knows
//     the code can join as a student; that is by design (it is a room name, not
//     a secret). But nobody — including this server or a LAN eavesdropper —
//     can read a student's work without the instructor tab's private key.
//   - "No auth" (build plan §5) applies to STUDENTS, not to becoming the
//     instructor. Whoever owns `classPubKey` receives every student's sealed
//     telemetry and graded submission, so re-binding a live class costs a
//     server-minted token — see onCreate.
//   - State is in-memory only; the persisted run backups are ciphertext on disk,
//     useless without the instructor key. Losing the process loses nothing that
//     was secret.

import http from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.argv[2] || process.env.PORT || 8080)

// Resolve relative to the repo root (this file lives in ./server).
const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const runsDir = fileURLToPath(new URL('../classroom-runs', import.meta.url))
// Gitignored school unlock material — written automatically on first typed code.
// Tests may point CLASSROOM_SECRETS_DIR at a temp folder so they never touch a
// developer's real local-secrets/.
const secretsDir = process.env.CLASSROOM_SECRETS_DIR
  ? path.resolve(process.env.CLASSROOM_SECRETS_DIR)
  : fileURLToPath(new URL('../local-secrets', import.meta.url))
const instructorHashPath = path.join(secretsDir, 'instructor-access-hash.txt')
const instructorCodePath = path.join(secretsDir, 'instructor-access-code.txt')

// Single source of truth for the guardrails and the class-code alphabet, shared with
// src/classroom/protocol.ts. This file is plain ESM JS and cannot import the TS module,
// so both sides read the same JSON rather than re-declaring literals — which is exactly
// how the server ended up enforcing MAX_STUDENTS while knowing nothing about the code
// alphabet, and therefore never validating a classId at all. Read synchronously and
// unguarded on purpose: a relay that cannot see its own limits must not boot.
export const LIMITS = JSON.parse(readFileSync(fileURLToPath(new URL('../src/classroom/limits.json', import.meta.url)), 'utf8'))
const {
  MAX_STUDENTS,
  MAX_CLASSES,
  MAX_MESSAGE_BYTES,
  MAX_COMMANDS_PER_SEC,
  HEARTBEAT_TIMEOUT_MS,
  INSTRUCTOR_RECONNECT_GRACE_MS,
  CLASS_ID_ALPHABET,
  CLASS_ID_LENGTH,
} = LIMITS
const HEARTBEAT_PING_MS = Math.floor(HEARTBEAT_TIMEOUT_MS / 2)

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
}

// classId -> { classPubKey, config, instructorSock, instructorToken, focusedStudentId,
//              students, commandTimestamps, cleanupTimer }
// students: studentId -> { sock, entry }
export const classes = new Map()

// Mirrors isValidClassId() in src/classroom/protocol.ts over the same shared alphabet.
// `typeof classId === 'string'` was the whole check before, which let `../../x` through
// to path.join() in persistRun and escape classroom-runs/.
export function isValidClassId(value) {
  return typeof value === 'string'
    && value.length === CLASS_ID_LENGTH
    && [...value].every((c) => CLASS_ID_ALPHABET.includes(c))
}

// Only send when the socket can actually take bytes; a half-closed peer is common.
function send(sock, msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
}

// The roster the instructor sees is exactly the stored entries (no secrets in them).
function sendRoster(cls, classId) {
  const students = [...cls.students.values()].map(s => s.entry)
  send(cls.instructorSock, { v: 1, type: 'roster.update', classId, students })
}

// Constant-time token compare. Length is not secret (it is always 43 base64url chars),
// but timingSafeEqual throws on a length mismatch, so screen for that first.
function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function bindInstructor(sock, cls, classId) {
  if (cls.cleanupTimer) {
    clearTimeout(cls.cleanupTimer)
    cls.cleanupTimer = null
  }
  sock.role = 'instructor'
  sock.classId = classId
  send(sock, { v: 1, type: 'class.ok', classId, instructorToken: cls.instructorToken })
  sendRoster(cls, classId)
}

// class.create is both "open a room" and "my instructor tab reconnected". The second
// case is the dangerous one: it used to accept ANY socket that named a live classId and
// silently reassigned instructorSock/classPubKey/config, so anyone who heard the six
// characters read aloud could seize the room — and every student who joined afterwards
// sealed their telemetry AND their graded submission to the attacker's key. That is a
// direct contradiction of the E2EE guarantee in §4, so re-binding now costs the
// 256-bit token the server mints at creation and hands only to the creating socket.
// Students still need no credential of any kind (§5) — only instructors do.
function onCreate(sock, msg) {
  const { classId, classPubKey, config } = msg
  const cls = classes.get(classId)

  if (cls) {
    if (!tokenMatches(cls.instructorToken, msg.instructorToken)) {
      return send(sock, { v: 1, type: 'class.err', classId, reason: 'not-instructor' })
    }
    // Legitimate reconnect: proven same instructor, new socket. Keep the live roster.
    cls.instructorSock = sock
    if (classPubKey) cls.classPubKey = classPubKey
    if (config !== undefined) cls.config = config
    return bindInstructor(sock, cls, classId)
  }

  // Nothing capped the class map, so any LAN client could mint rooms until the process
  // died — MAX_STUDENTS bounded a class but nothing bounded the number of classes.
  if (classes.size >= MAX_CLASSES) {
    return send(sock, { v: 1, type: 'class.err', classId, reason: 'server-full' })
  }

  const created = {
    classPubKey,
    config,
    instructorSock: sock,
    instructorToken: crypto.randomBytes(32).toString('base64url'),
    focusedStudentId: null,
    students: new Map(),
    commandTimestamps: [],
    cleanupTimer: null,
  }
  classes.set(classId, created)
  bindInstructor(sock, created, classId)
}

function onJoin(sock, msg) {
  const { classId, displayName, studentPubKey, accountId } = msg
  const cls = classes.get(classId)
  if (!cls) return send(sock, { v: 1, type: 'join.err', classId, reason: 'no-such-class' })
  if (cls.students.size >= MAX_STUDENTS) return send(sock, { v: 1, type: 'join.err', classId, reason: 'class-full' })
  const studentId = crypto.randomUUID().slice(0, 8)
  const entry = {
    studentId,
    displayName,
    joinedAt: Date.now(),
    studentPubKey,
    ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
  }
  cls.students.set(studentId, { sock, entry })
  sock.role = 'student'
  sock.classId = classId
  sock.studentId = studentId
  send(sock, { v: 1, type: 'join.ok', classId, studentId, classPubKey: cls.classPubKey, config: cls.config })
  sendRoster(cls, classId)
}

// Ciphertext crash-backup for the instructor tab. Best-effort: a disk fault must
// never take down the relay, so failures are swallowed after logging.
//
// This is the one place that turns network input into a filesystem path. classId is
// already validated at the WS entry point and studentId is a server-minted UUID slice,
// but both are re-checked here and the resolved path is proven to stay inside
// classroom-runs/ — the same containment test the static file handler applies to dist/.
async function persistRun(classId, studentId, envelope) {
  if (!isValidClassId(classId) || !/^[0-9a-f-]{1,36}$/.test(String(studentId))) return
  try {
    const dir = path.join(runsDir, classId)
    if (!dir.startsWith(runsDir + path.sep)) return
    const file = path.join(dir, `${studentId}-${Date.now()}.json`)
    if (!file.startsWith(dir + path.sep)) return
    await mkdir(dir, { recursive: true })
    await writeFile(file, JSON.stringify(envelope))
  } catch (err) {
    console.error('run backup failed', err)
  }
}

// student.grid / student.focus / student.run: tag with `from` and hand to the
// instructor. `sealed` is forwarded by reference, never opened.
function onStudentMsg(sock, msg) {
  const cls = classes.get(sock.classId)
  if (!cls || sock.role !== 'student' || msg.classId !== sock.classId) return
  const from = sock.studentId
  const student = from && cls.students.get(from)
  if (!student || student.sock !== sock) return
  if (msg.type === 'student.run' || msg.type === 'student.session') persistRun(sock.classId, from, msg)
  const type = msg.type === 'student.ack' ? 'student.ack' : msg.type
  send(cls.instructorSock, { v: 1, type, classId: sock.classId, from, sealed: msg.sealed })
}

// Sliding one-second window, scoped to the class. Only an authenticated command to
// a live named student consumes capacity; malformed targets and token probes do not
// let an attacker exhaust the instructor's budget. Over-limit commands are dropped
// deterministically before any student receives bytes.
function consumeCommandCapacity(cls, now = Date.now()) {
  const cutoff = now - 1000
  cls.commandTimestamps = cls.commandTimestamps.filter(stamp => stamp > cutoff)
  if (cls.commandTimestamps.length >= MAX_COMMANDS_PER_SEC) return false
  cls.commandTimestamps.push(now)
  return true
}

// Instructor -> one named student. The relay authenticates and routes only; the
// sealed command remains opaque and is forwarded unchanged, without the instructor
// token or target id attached to the student-visible envelope.
function onClassCommand(sock, msg) {
  const cls = classes.get(msg.classId)
  if (!cls || cls.instructorSock !== sock || sock.role !== 'instructor') return
  if (!tokenMatches(cls.instructorToken, msg.instructorToken)) return
  if (typeof msg.studentId !== 'string') return
  const target = cls.students.get(msg.studentId)
  if (!target) return
  if (!consumeCommandCapacity(cls)) return
  send(target.sock, { v: 1, type: 'command', classId: msg.classId, sealed: msg.sealed })
}

function onFocus(sock, msg) {
  const cls = classes.get(sock.classId)
  if (!cls || cls.instructorSock !== sock) return
  const prev = cls.focusedStudentId
  const next = msg.studentId ?? null
  if (prev === next) return
  cls.focusedStudentId = next
  const prevStudent = prev && cls.students.get(prev)
  if (prevStudent) send(prevStudent.sock, { v: 1, type: 'focus.off', classId: sock.classId })
  const nextStudent = next && cls.students.get(next)
  if (nextStudent) send(nextStudent.sock, { v: 1, type: 'focus.on', classId: sock.classId })
}

function removeStudent(sock) {
  const cls = classes.get(sock.classId)
  const studentId = sock.studentId
  if (!cls || !studentId || !cls.students.has(studentId)) return
  cls.students.delete(studentId)
  if (cls.focusedStudentId === studentId) cls.focusedStudentId = null
  send(cls.instructorSock, { v: 1, type: 'student.gone', classId: sock.classId, from: studentId })
  sendRoster(cls, sock.classId)
}

function closeClass(classId) {
  const cls = classes.get(classId)
  if (!cls) return
  if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  for (const { sock } of cls.students.values()) send(sock, { v: 1, type: 'class.closed', classId })
  classes.delete(classId)
}

function onClassClose(sock) {
  const cls = classes.get(sock.classId)
  if (cls && cls.instructorSock === sock) closeClass(sock.classId)
}

export function onClose(sock) {
  if (sock.role === 'student') removeStudent(sock)
  else if (sock.role === 'instructor') {
    // Keep the room and roster through a temporary instructor disconnect so the
    // server-minted token can rebind the tab. Cleanup is bounded; explicit
    // class.close still calls closeClass immediately.
    const cls = classes.get(sock.classId)
    if (cls && cls.instructorSock === sock) {
      cls.instructorSock = null
      if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
      cls.cleanupTimer = setTimeout(() => {
        if (classes.get(sock.classId) === cls && cls.instructorSock === null) closeClass(sock.classId)
      }, INSTRUCTOR_RECONNECT_GRACE_MS)
      cls.cleanupTimer.unref?.()
    }
  }
}

// A socket's role is fixed by its first meaningful message.
export function handle(sock, msg) {
  if (!msg || msg.v !== 1 || typeof msg.type !== 'string') return
  // Validate the classId at EVERY entry point, not only the two that key the class map
  // with it. Drop silently rather than echoing a reason: a well-formed client cannot
  // produce a malformed code (JoinGate gates on the same predicate), so anything that
  // arrives here is hostile and gets no oracle.
  if (msg.classId !== undefined && !isValidClassId(msg.classId)) return
  switch (msg.type) {
    case 'class.create': return onCreate(sock, msg)
    case 'class.command': return onClassCommand(sock, msg)
    case 'class.focus': return onFocus(sock, msg)
    case 'class.close': return onClassClose(sock)
    case 'student.join': return onJoin(sock, msg)
    case 'student.grid':
    case 'student.focus':
    case 'student.run':
    case 'student.session':
    case 'student.ack': return onStudentMsg(sock, msg)
    case 'student.leave': return removeStudent(sock)
  }
}

// Serving the built app from the same origin lets students just open the URL.
async function serveStatic(req, res) {
  try {
    const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname)
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    const filePath = path.join(distDir, rel)
    // Reject path traversal that would escape dist.
    if (filePath !== distDir && !filePath.startsWith(distDir + path.sep)) {
      res.writeHead(403)
      return res.end('forbidden')
    }
    const data = await readFile(filePath)
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readRequestBody(req, limit = 4096) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read the school unlock digest from gitignored local-secrets (if present). */
export function loadInstructorAccessHashFromDisk() {
  try {
    if (!existsSync(instructorHashPath)) return null
    const lines = readFileSync(instructorHashPath, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase()
    }
  } catch {
    return null
  }
  return null
}

function hashAccessCode(code) {
  const normalized = String(code).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim()
  if (!normalized) return null
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}

function codesMatchExpected(code, expectedHash) {
  if (!expectedHash || typeof code !== 'string') return false
  const normalized = code.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim()
  if (!normalized) return false
  const asHex = normalized.toLowerCase()
  if (/^[0-9a-f]{64}$/.test(asHex)) {
    const a = Buffer.from(asHex, 'utf8')
    const b = Buffer.from(expectedHash, 'utf8')
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const digest = hashAccessCode(normalized)
  if (!digest) return false
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(expectedHash, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * Health probe for the desktop shell / web Yes dialog.
 *   GET/HEAD /api/health → { ok: true, service: 'classroom-relay' }
 */
export async function handleHealthHttp(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname !== '/api/health') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    return true
  }
  sendJson(res, 200, { ok: true, service: 'classroom-relay' })
  return true
}

/**
 * Option A unlock APIs:
 *   GET    /api/instructor-access           → { configured }
 *   POST   /api/instructor-access/verify    → { ok }  (never returns the hash)
 *   POST   /api/instructor-access/provision → first writer wins; 409 if already set
 *   DELETE /api/instructor-access           → intentional admin reset of disk secrets
 */
export async function handleInstructorAccessHttp(req, res) {
  const url = new URL(req.url || '/', 'http://x')
  if (!url.pathname.startsWith('/api/instructor-access')) return false

  if (url.pathname === '/api/instructor-access' && req.method === 'GET') {
    sendJson(res, 200, { configured: loadInstructorAccessHashFromDisk() !== null })
    return true
  }

  if (url.pathname === '/api/instructor-access' && req.method === 'DELETE') {
    try {
      if (existsSync(instructorHashPath)) await unlink(instructorHashPath)
      if (existsSync(instructorCodePath)) await unlink(instructorCodePath)
    } catch (err) {
      console.error('instructor-access reset failed', err)
      sendJson(res, 500, { ok: false, error: 'reset-failed' })
      return true
    }
    sendJson(res, 200, { ok: true })
    return true
  }

  if (url.pathname === '/api/instructor-access/verify' && req.method === 'POST') {
    const raw = await readRequestBody(req)
    if (raw === null) {
      sendJson(res, 413, { ok: false, error: 'too-large' })
      return true
    }
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return true
    }
    const expected = loadInstructorAccessHashFromDisk()
    if (!expected) {
      sendJson(res, 404, { ok: false, error: 'not-configured' })
      return true
    }
    sendJson(res, 200, { ok: codesMatchExpected(body?.code, expected) })
    return true
  }

  if (url.pathname === '/api/instructor-access/provision' && req.method === 'POST') {
    const raw = await readRequestBody(req)
    if (raw === null) {
      sendJson(res, 413, { ok: false, error: 'too-large' })
      return true
    }
    let body
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad-json' })
      return true
    }
    const existing = loadInstructorAccessHashFromDisk()
    if (existing) {
      sendJson(res, 409, { ok: false, error: 'already-configured' })
      return true
    }
    const hash = typeof body?.hash === 'string' ? body.hash.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      sendJson(res, 400, { ok: false, error: 'bad-hash' })
      return true
    }
    try {
      await mkdir(secretsDir, { recursive: true })
      const hashContents = [
        '# School instructor unlock digest (SHA-256 hex). Auto-written on first typed code.',
        '# Do not commit this folder. Delete this file (or DELETE /api/instructor-access) to reset.',
        hash,
        '',
      ].join('\n')
      await writeFile(instructorHashPath, hashContents, { encoding: 'utf8', flag: 'wx' })
      if (typeof body?.code === 'string' && body.code.trim()) {
        const plaintext = body.code.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').trim()
        // Optional local-admin recovery only — never required of the instructor UI.
        await writeFile(
          instructorCodePath,
          [
            '# Optional plaintext recovery for this machine. Gitignored. Never commit.',
            plaintext,
            '',
          ].join('\n'),
          { encoding: 'utf8', flag: 'wx' },
        ).catch(() => { /* recovery file is best-effort */ })
      }
    } catch (err) {
      if (err && (err.code === 'EEXIST' || loadInstructorAccessHashFromDisk())) {
        sendJson(res, 409, { ok: false, error: 'already-configured' })
        return true
      }
      console.error('instructor-access provision failed', err)
      sendJson(res, 500, { ok: false, error: 'provision-failed' })
      return true
    }
    sendJson(res, 201, { ok: true })
    return true
  }

  sendJson(res, 404, { ok: false, error: 'not-found' })
  return true
}

async function handleHttp(req, res) {
  if (await handleHealthHttp(req, res)) return
  if (await handleInstructorAccessHttp(req, res)) return
  return serveStatic(req, res)
}

export function startRelay(port = PORT) {
  const server = http.createServer((req, res) => {
    void handleHttp(req, res)
  })
  const wss = new WebSocketServer({ server })

  wss.on('connection', sock => {
    sock.isAlive = true
    sock.lastPong = Date.now()
    sock.on('pong', () => {
      sock.isAlive = true
      sock.lastPong = Date.now()
    })
    sock.on('message', raw => {
      // Ignore oversize frames outright — never let one bad frame crash the relay.
      if (raw.length > MAX_MESSAGE_BYTES) return
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      try {
        handle(sock, msg)
      } catch (err) {
        console.error('handler error', err)
      }
    })
    sock.on('close', () => onClose(sock))
    sock.on('error', () => {})
  })

  // Heartbeat: ping every HEARTBEAT_PING_MS, drop a socket silent for the full timeout.
  // isAlive flips false on each ping and true on the pong that answers it; lastPong
  // gates the cutoff.
  const beat = setInterval(() => {
    const now = Date.now()
    for (const sock of wss.clients) {
      if (!sock.isAlive && now - sock.lastPong > HEARTBEAT_TIMEOUT_MS) {
        sock.terminate()
        continue
      }
      sock.isAlive = false
      sock.ping()
    }
  }, HEARTBEAT_PING_MS)
  wss.on('close', () => clearInterval(beat))

  server.listen(port, () => {
    console.log(`Classroom relay on http://localhost:${port}`)
    // Print a LAN join URL per non-internal IPv4 so students can find the room.
    for (const nets of Object.values(os.networkInterfaces())) {
      for (const net of nets || []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`Classroom relay on http://${net.address}:${port}`)
      }
    }
  })

  return { server, wss }
}

// Drops all rooms. Test-only: the routing spec drives `handle`/`onClose` with fake
// sockets (build plan §10 requires the WS test to stay offline) and needs a clean map
// between cases.
export function resetRelayState() {
  for (const cls of classes.values()) if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  classes.clear()
}

// Bind a port only when run directly (`node server/classroom.mjs`). Importing this
// module — which the routing tests do — must not open a socket or leave a heartbeat
// timer running.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startRelay(PORT)
}
