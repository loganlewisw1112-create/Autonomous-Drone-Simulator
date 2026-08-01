// Classroom protocol-v2 relay. Mission data remains opaque ciphertext; the relay
// owns instructor authorization, transport admission, routing and bounded backups.

import http from 'node:http'
import https from 'node:https'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

/**
 * @typedef {WebSocket & {
 *   instructorSessionAuthorized?: boolean,
 *   instructorSessionToken?: string,
 *   connectionIp: string,
 *   transportTrusted: boolean,
 *   isAlive: boolean,
 *   lastPong: number,
 *   messageTokens: number,
 *   messageTokenAt: number,
 *   role?: string,
 *   classId?: string,
 *   studentId?: string
 * }} ClassroomSocket
 */

const PORT = Number(process.argv[2] || process.env.PORT || 8080)
const PROTOCOL_VERSION = 2
const SESSION_COOKIE = 'dsim_instructor_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const VERIFY_WINDOW_MS = 15 * 60 * 1000
const VERIFY_PER_IP = 5
const VERIFY_GLOBAL = 30
const MAX_SOCKETS = 96
const MAX_SOCKETS_PER_IP = 12
const MAX_UPGRADES_PER_IP_PER_MIN = 30
const HANDSHAKE_TIMEOUT_MS = 10_000
const MESSAGE_RATE_PER_SEC = 16
const MESSAGE_BURST = 24
const BACKUP_WRITES_PER_MIN = 4
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BACKUP_QUOTA_BYTES = 256 * 1024 * 1024
const SCRYPT_PARAMS = Object.freeze({
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
})

const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const runsDir = process.env.CLASSROOM_RUNS_DIR
  ? path.resolve(process.env.CLASSROOM_RUNS_DIR)
  : fileURLToPath(new URL('../classroom-runs', import.meta.url))
const secretsDir = process.env.CLASSROOM_SECRETS_DIR
  ? path.resolve(process.env.CLASSROOM_SECRETS_DIR)
  : fileURLToPath(new URL('../local-secrets', import.meta.url))
const instructorVerifierPath = path.join(secretsDir, 'instructor-access-v2.json')
const legacyInstructorHashPath = path.join(secretsDir, 'instructor-access-hash.txt')
const legacyInstructorCodePath = path.join(secretsDir, 'instructor-access-code.txt')
const provisionLockPath = path.join(secretsDir, '.instructor-provision.lock')
const administratorTokenWasGenerated = !process.env.CLASSROOM_ADMIN_TOKEN
const administratorToken = process.env.CLASSROOM_ADMIN_TOKEN
  || crypto.randomBytes(32).toString('base64url')

export const LIMITS = JSON.parse(readFileSync(
  fileURLToPath(new URL('../src/classroom/limits.json', import.meta.url)),
  'utf8',
))
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
// Read-only acceptance surface for live relay boundary tests. Production code
// continues to consume the module constants directly.
export const RELAY_BOUNDARIES = Object.freeze({
  MAX_SOCKETS,
  MAX_SOCKETS_PER_IP,
  MAX_UPGRADES_PER_IP_PER_MIN,
  MAX_MESSAGE_BYTES,
  HANDSHAKE_TIMEOUT_MS,
  MESSAGE_RATE_PER_SEC,
  MESSAGE_BURST,
  BACKUP_WRITES_PER_MIN,
  BACKUP_RETENTION_MS,
  BACKUP_QUOTA_BYTES,
})
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

const STATIC_SECURITY_HEADERS = Object.freeze({
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    "font-src 'self' data: https://tiles.openfreemap.org",
    "connect-src 'self' https://tiles.openfreemap.org",
    "worker-src 'self' blob:",
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
})

// classId -> live relay state. No decrypted mission data is ever stored here.
export const classes = new Map()
const instructorSessions = new Map()
const failedVerificationsByIp = new Map()
let failedVerificationsGlobal = []
const backupWriteTimes = new Map()
let credentialMigrationDeletionFailureForTests = null

export function isValidClassId(value) {
  return typeof value === 'string'
    && value.length === CLASS_ID_LENGTH
    && [...value].every(char => CLASS_ID_ALPHABET.includes(char))
}

function isLoopbackAddress(value) {
  const address = String(value || '').toLowerCase()
  return address === '::1'
    || address === '127.0.0.1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
}

function requestIp(req) {
  const actual = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || '')
  const testIp = req?.headers?.['x-classroom-test-ip']
  if (
    process.env.NODE_ENV === 'test'
    && process.env.CLASSROOM_TEST_SPOOF_IP === '1'
    && isLoopbackAddress(actual)
    && typeof testIp === 'string'
    && /^[0-9a-f:.]{3,45}$/i.test(testIp)
  ) {
    return testIp
  }
  return actual
}

function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function send(sock, msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
}

function fingerprintPublicKey(publicKey) {
  return crypto.createHash('sha256')
    .update(Buffer.from(String(publicKey), 'base64'))
    .digest('base64url')
}

function sendRoster(cls, classId) {
  const students = [...cls.students.values()].map(student => student.entry)
  send(cls.instructorSock, {
    v: PROTOCOL_VERSION,
    type: 'roster.update',
    classId,
    students,
  })
}

function bindInstructor(sock, cls, classId) {
  if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  cls.cleanupTimer = null
  sock.role = 'instructor'
  sock.classId = classId
  send(sock, {
    v: PROTOCOL_VERSION,
    type: 'class.ok',
    classId,
    instructorToken: cls.instructorToken,
  })
  sendRoster(cls, classId)
}

function onCreate(sock, msg) {
  const { classId, classPubKey, config } = msg
  if (!activeInstructorSocketSession(sock)) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'class.err',
      classId,
      reason: 'instructor-session-required',
    })
  }
  const insecureDevelopmentAllowed = process.env.CLASSROOM_ALLOW_INSECURE_LAN === '1'
    && msg.graded === false
  if (sock.transportTrusted === false && !insecureDevelopmentAllowed) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'class.err',
      classId,
      reason: 'secure-transport-required',
    })
  }

  const cls = classes.get(classId)
  if (cls) {
    if (!tokenMatches(cls.instructorToken, msg.instructorToken)) {
      return send(sock, {
        v: PROTOCOL_VERSION,
        type: 'class.err',
        classId,
        reason: 'not-instructor',
      })
    }
    cls.instructorSock = sock
    if (classPubKey) {
      cls.classPubKey = classPubKey
      cls.classKeyFingerprint = fingerprintPublicKey(classPubKey)
    }
    if (config !== undefined) cls.config = config
    return bindInstructor(sock, cls, classId)
  }

  if (classes.size >= MAX_CLASSES) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'class.err',
      classId,
      reason: 'server-full',
    })
  }

  const durationMinutes = Number(config?.durationMinutes ?? 60)
  if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 180) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'class.err',
      classId,
      reason: 'invalid-class-duration',
    })
  }

  const created = {
    classPubKey,
    classKeyFingerprint: fingerprintPublicKey(classPubKey),
    config,
    graded: msg.graded !== false,
    instructorSock: sock,
    instructorToken: crypto.randomBytes(32).toString('base64url'),
    focusedStudentId: null,
    students: new Map(),
    commandTimestamps: [],
    cleanupTimer: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + durationMinutes * 60_000,
  }
  classes.set(classId, created)
  bindInstructor(sock, created, classId)
}

function onJoin(sock, msg) {
  const { classId, displayName, studentPubKey, accountId } = msg
  const cls = classes.get(classId)
  if (!cls) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'join.err',
      classId,
      reason: 'no-such-class',
    })
  }
  if (Date.now() >= cls.expiresAt) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'join.err',
      classId,
      reason: 'class-time-limit-reached',
    })
  }
  if (sock.transportTrusted === false && process.env.CLASSROOM_ALLOW_INSECURE_LAN !== '1') {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'join.err',
      classId,
      reason: 'secure-transport-required',
    })
  }
  if (cls.students.size >= MAX_STUDENTS) {
    return send(sock, {
      v: PROTOCOL_VERSION,
      type: 'join.err',
      classId,
      reason: 'class-full',
    })
  }
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
  send(sock, {
    v: PROTOCOL_VERSION,
    type: 'join.ok',
    classId,
    studentId,
    classPubKey: cls.classPubKey,
    classKeyFingerprint: cls.classKeyFingerprint,
    config: cls.config,
  })
  sendRoster(cls, classId)
}

function backupWarning(classId, reason) {
  const cls = classes.get(classId)
  send(cls?.instructorSock, {
    v: PROTOCOL_VERSION,
    type: 'backup.warn',
    classId,
    reason,
  })
}

function consumeBackupCapacity(classId, studentId, now = Date.now()) {
  const key = `${classId}:${studentId}`
  const cutoff = now - 60_000
  const timestamps = (backupWriteTimes.get(key) || []).filter(stamp => stamp > cutoff)
  if (timestamps.length >= BACKUP_WRITES_PER_MIN) {
    backupWriteTimes.set(key, timestamps)
    return false
  }
  timestamps.push(now)
  backupWriteTimes.set(key, timestamps)
  return true
}

async function directoryBytes(directory) {
  let total = 0
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(child)
    else total += (await stat(child).catch(() => null))?.size || 0
  }
  return total
}

async function closedClassDirectories() {
  const entries = await readdir(runsDir, { withFileTypes: true }).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || classes.has(entry.name)) continue
    const directory = path.join(runsDir, entry.name)
    const info = await stat(directory).catch(() => null)
    if (info) candidates.push({ directory, mtimeMs: info.mtimeMs })
  }
  return candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
}

async function pruneBackups(now = Date.now()) {
  const closed = await closedClassDirectories()
  for (const candidate of closed) {
    if (candidate.mtimeMs < now - BACKUP_RETENTION_MS) {
      await rm(candidate.directory, { recursive: true, force: true }).catch(() => {})
    }
  }
  let bytes = await directoryBytes(runsDir)
  if (bytes <= BACKUP_QUOTA_BYTES) return bytes
  for (const candidate of await closedClassDirectories()) {
    const removed = await directoryBytes(candidate.directory)
    await rm(candidate.directory, { recursive: true, force: true }).catch(() => {})
    bytes = Math.max(0, bytes - removed)
    if (bytes <= BACKUP_QUOTA_BYTES) break
  }
  return bytes
}

async function atomicWrite(file, contents, options = {}) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, contents, options)
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function persistRun(classId, studentId, envelope) {
  if (!isValidClassId(classId) || !/^[0-9a-f-]{1,36}$/.test(String(studentId))) return
  if (!consumeBackupCapacity(classId, studentId)) {
    backupWarning(classId, 'rate-limited')
    return
  }
  const directory = path.resolve(runsDir, classId)
  const file = path.resolve(directory, `${studentId}.json`)
  if (!directory.startsWith(path.resolve(runsDir) + path.sep) || !file.startsWith(directory + path.sep)) return

  try {
    await pruneBackups()
    await atomicWrite(file, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
    const bytes = await pruneBackups()
    if (bytes > BACKUP_QUOTA_BYTES) {
      await unlink(file).catch(() => {})
      backupWarning(classId, 'quota-limited')
    }
  } catch (error) {
    console.error('run backup failed', error instanceof Error ? error.message : 'unknown')
    backupWarning(classId, 'write-failed')
  }
}

function onStudentMsg(sock, msg) {
  const cls = classes.get(sock.classId)
  if (!cls || sock.role !== 'student' || msg.classId !== sock.classId) return
  const from = sock.studentId
  const student = from && cls.students.get(from)
  if (!student || student.sock !== sock) return
  if (msg.type === 'student.run' || msg.type === 'student.session') {
    void persistRun(sock.classId, from, msg)
  }
  send(cls.instructorSock, {
    v: PROTOCOL_VERSION,
    type: msg.type,
    classId: sock.classId,
    from,
    sealed: msg.sealed,
  })
}

function consumeCommandCapacity(cls, now = Date.now()) {
  const cutoff = now - 1000
  cls.commandTimestamps = cls.commandTimestamps.filter(stamp => stamp > cutoff)
  if (cls.commandTimestamps.length >= MAX_COMMANDS_PER_SEC) return false
  cls.commandTimestamps.push(now)
  return true
}

function onClassCommand(sock, msg) {
  const cls = classes.get(msg.classId)
  if (!cls || cls.instructorSock !== sock || sock.role !== 'instructor') return
  if (!tokenMatches(cls.instructorToken, msg.instructorToken)) return
  if (typeof msg.studentId !== 'string') return
  const target = cls.students.get(msg.studentId)
  if (!target || !consumeCommandCapacity(cls)) return
  send(target.sock, {
    v: PROTOCOL_VERSION,
    type: 'command',
    classId: msg.classId,
    sealed: msg.sealed,
  })
}

function onFocus(sock, msg) {
  const cls = classes.get(sock.classId)
  if (!cls || cls.instructorSock !== sock) return
  const previous = cls.focusedStudentId
  const next = msg.studentId ?? null
  if (previous === next) return
  cls.focusedStudentId = next
  const previousStudent = previous && cls.students.get(previous)
  if (previousStudent) {
    send(previousStudent.sock, {
      v: PROTOCOL_VERSION,
      type: 'focus.off',
      classId: sock.classId,
    })
  }
  const nextStudent = next && cls.students.get(next)
  if (nextStudent) {
    send(nextStudent.sock, {
      v: PROTOCOL_VERSION,
      type: 'focus.on',
      classId: sock.classId,
    })
  }
}

function removeStudent(sock) {
  const cls = classes.get(sock.classId)
  const studentId = sock.studentId
  if (!cls || !studentId || !cls.students.has(studentId)) return
  cls.students.delete(studentId)
  backupWriteTimes.delete(`${sock.classId}:${studentId}`)
  if (cls.focusedStudentId === studentId) cls.focusedStudentId = null
  send(cls.instructorSock, {
    v: PROTOCOL_VERSION,
    type: 'student.gone',
    classId: sock.classId,
    from: studentId,
  })
  sendRoster(cls, sock.classId)
}

function closeClass(classId) {
  const cls = classes.get(classId)
  if (!cls) return
  if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  for (const { sock } of cls.students.values()) {
    send(sock, { v: PROTOCOL_VERSION, type: 'class.closed', classId })
  }
  classes.delete(classId)
  try {
    const directory = path.resolve(runsDir, classId)
    if (directory.startsWith(path.resolve(runsDir) + path.sep)) {
      const closedAt = new Date()
      utimesSync(directory, closedAt, closedAt)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('backup closure timestamp failed', error instanceof Error ? error.message : 'unknown')
    }
  }
}

function onClassClose(sock) {
  const cls = classes.get(sock.classId)
  if (cls && cls.instructorSock === sock) closeClass(sock.classId)
}

export function onClose(sock) {
  if (sock.role === 'student') {
    removeStudent(sock)
    return
  }
  if (sock.role !== 'instructor') return
  const cls = classes.get(sock.classId)
  if (!cls || cls.instructorSock !== sock) return
  cls.instructorSock = null
  if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  cls.cleanupTimer = setTimeout(() => {
    if (classes.get(sock.classId) === cls && cls.instructorSock === null) {
      closeClass(sock.classId)
    }
  }, INSTRUCTOR_RECONNECT_GRACE_MS)
  cls.cleanupTimer.unref?.()
}

export function handle(sock, msg) {
  if (!msg || msg.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') {
    if (msg?.v === 1) sock.close?.(4001, 'refresh-required')
    return
  }
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

function securityHeaders(req, api = false) {
  const headers = {
    ...STATIC_SECURITY_HEADERS,
    ...(api ? { 'cache-control': 'no-store, max-age=0' } : {}),
  }
  if (req?.socket?.encrypted) {
    headers['strict-transport-security'] = 'max-age=31536000'
  }
  return headers
}

async function serveStatic(req, res) {
  try {
    const urlPath = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname)
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    const file = path.resolve(distDir, relative)
    if (file !== path.resolve(distDir) && !file.startsWith(path.resolve(distDir) + path.sep)) {
      res.writeHead(403, securityHeaders(req))
      return res.end('forbidden')
    }
    const data = await readFile(file)
    const contentType = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'
    const cache = path.basename(file) === 'index.html'
      ? 'no-store, max-age=0'
      : 'public, max-age=31536000, immutable'
    res.writeHead(200, {
      ...securityHeaders(req),
      'cache-control': cache,
      'content-type': contentType,
    })
    res.end(data)
  } catch {
    res.writeHead(404, securityHeaders(req))
    res.end('not found')
  }
}

function sendJson(req, res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders(req, true),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
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

async function readJsonBody(req, res) {
  const raw = await readRequestBody(req)
  if (raw === null) {
    sendJson(req, res, 413, { ok: false, error: 'too-large' })
    return null
  }
  try {
    return JSON.parse(raw || '{}')
  } catch {
    sendJson(req, res, 400, { ok: false, error: 'bad-json' })
    return null
  }
}

function normalizeAccessCode(value) {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
  const length = [...normalized].length
  return length >= 12 && length <= 128 ? normalized : null
}

function normalizeLegacyAccessCode(value) {
  if (typeof value !== 'string') return null
  const normalized = value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, '')
    .trim()
  return normalized || null
}

function scrypt(code, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(code, salt, 32, SCRYPT_PARAMS, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

async function makeVerifier(code, allowLegacy = false) {
  const normalized = allowLegacy
    ? String(code).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    : normalizeAccessCode(code)
  if (!normalized || [...normalized].length > 128) return null
  const salt = crypto.randomBytes(16)
  const derived = await scrypt(normalized, salt)
  return {
    version: 2,
    kdf: 'scrypt',
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    maxmem: SCRYPT_PARAMS.maxmem,
    salt: salt.toString('base64'),
    hash: derived.toString('base64'),
  }
}

function validVerifier(value) {
  return value
    && value.version === 2
    && value.kdf === 'scrypt'
    && value.N === SCRYPT_PARAMS.N
    && value.r === SCRYPT_PARAMS.r
    && value.p === SCRYPT_PARAMS.p
    && value.maxmem === SCRYPT_PARAMS.maxmem
    && typeof value.salt === 'string'
    && typeof value.hash === 'string'
}

export function loadInstructorAccessVerifierFromDisk() {
  try {
    if (!existsSync(instructorVerifierPath)) return null
    const parsed = JSON.parse(readFileSync(instructorVerifierPath, 'utf8'))
    return validVerifier(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Legacy diagnostic export retained for migration tests and administrators.
export function loadInstructorAccessHashFromDisk() {
  try {
    if (!existsSync(legacyInstructorHashPath)) return null
    const lines = readFileSync(legacyInstructorHashPath, 'utf8').split(/\r?\n/)
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

function legacyPlaintextFromDisk() {
  try {
    if (!existsSync(legacyInstructorCodePath)) return null
    const lines = readFileSync(legacyInstructorCodePath, 'utf8').split(/\r?\n/)
    return lines.find(line => line.trim() && !line.trim().startsWith('#'))?.trim() || null
  } catch {
    return null
  }
}

async function writeVerifier(verifier) {
  await atomicWrite(
    instructorVerifierPath,
    `${JSON.stringify(verifier, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

export function injectCredentialMigrationDeletionFailureForTests(fileName = null) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('credential migration fault injection is test-only')
  }
  credentialMigrationDeletionFailureForTests = fileName
}

async function deleteMigratedCredential(file) {
  if (
    process.env.NODE_ENV === 'test'
    && credentialMigrationDeletionFailureForTests === path.basename(file)
  ) {
    const error = Object.assign(
      new Error('injected credential migration deletion failure'),
      { code: 'EACCES' },
    )
    throw error
  }
  try {
    await unlink(file)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function rollbackMigratedVerifier() {
  try {
    await unlink(instructorVerifierPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function migratePlaintextCredential() {
  if (loadInstructorAccessVerifierFromDisk()) return false
  const plaintext = legacyPlaintextFromDisk()
  if (!plaintext) return false
  const verifier = await makeVerifier(plaintext, true)
  if (!verifier) return false
  await writeVerifier(verifier)
  try {
    // Delete the optional hash first so the plaintext source is still available
    // if either cleanup step fails.
    await deleteMigratedCredential(legacyInstructorHashPath)
    await deleteMigratedCredential(legacyInstructorCodePath)
  } catch (error) {
    await rollbackMigratedVerifier()
    throw error
  }
  return true
}

async function verifyCredential(code) {
  await migratePlaintextCredential()
  const verifier = loadInstructorAccessVerifierFromDisk()
  if (verifier) {
    const normalized = String(code || '').normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
    if (!normalized || [...normalized].length > 128) return false
    const actual = await scrypt(normalized, Buffer.from(verifier.salt, 'base64'))
    const expected = Buffer.from(verifier.hash, 'base64')
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  }

  const legacyHash = loadInstructorAccessHashFromDisk()
  const legacyCode = normalizeLegacyAccessCode(code)
  if (!legacyHash || !legacyCode) return false
  const actual = crypto.createHash('sha256').update(legacyCode, 'utf8').digest()
  const expected = Buffer.from(legacyHash, 'hex')
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false
  const upgraded = await makeVerifier(code, true)
  if (!upgraded) return false
  await writeVerifier(upgraded)
  try {
    await deleteMigratedCredential(legacyInstructorCodePath)
    await deleteMigratedCredential(legacyInstructorHashPath)
  } catch (error) {
    await rollbackMigratedVerifier()
    throw error
  }
  return true
}

function credentialConfigured() {
  return Boolean(
    loadInstructorAccessVerifierFromDisk()
    || loadInstructorAccessHashFromDisk()
    || legacyPlaintextFromDisk(),
  )
}

function cookieMap(req) {
  const values = new Map()
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1) continue
    values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
  }
  return values
}

function instructorSession(req, now = Date.now()) {
  const token = cookieMap(req).get(SESSION_COOKIE)
  const session = token && instructorSessions.get(token)
  if (!session) return null
  if (session.expiresAt <= now) {
    instructorSessions.delete(token)
    return null
  }
  return { token, ...session }
}

function activeInstructorSocketSession(sock, now = Date.now()) {
  // Direct fake-socket tests do not perform an HTTP upgrade. This flag is never
  // enabled by the CLI/Electron launchers and cannot be supplied over the wire.
  if (
    process.env.CLASSROOM_TEST_SOCKET_AUTH === '1'
    && sock.instructorSessionAuthorized === true
  ) {
    return { token: 'test-only', ip: sock.connectionIp || 'test', expiresAt: now + 1 }
  }
  const token = sock.instructorSessionToken
  const session = token && instructorSessions.get(token)
  if (!session) return null
  if (session.expiresAt <= now) {
    instructorSessions.delete(token)
    return null
  }
  if (session.ip !== sock.connectionIp) return null
  return { token, ...session }
}

export function authenticateInstructorSocket(sock, req) {
  const session = instructorSession(req)
  sock.connectionIp = requestIp(req)
  if (!session || session.ip !== sock.connectionIp) {
    delete sock.instructorSessionToken
    return false
  }
  sock.instructorSessionToken = session.token
  return true
}

function mintInstructorSession(ip, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('base64url')
  instructorSessions.set(token, { ip, expiresAt: now + SESSION_TTL_MS })
  return token
}

function sessionCookie(token, secure = false) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function clearSessionCookie(secure = false) {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

function failedVerificationLimited(ip, now = Date.now()) {
  const cutoff = now - VERIFY_WINDOW_MS
  failedVerificationsGlobal = failedVerificationsGlobal.filter(stamp => stamp > cutoff)
  const perIp = (failedVerificationsByIp.get(ip) || []).filter(stamp => stamp > cutoff)
  failedVerificationsByIp.set(ip, perIp)
  return perIp.length >= VERIFY_PER_IP || failedVerificationsGlobal.length >= VERIFY_GLOBAL
}

function recordFailedVerification(ip, now = Date.now()) {
  const existing = failedVerificationsByIp.get(ip) || []
  existing.push(now)
  failedVerificationsByIp.set(ip, existing)
  failedVerificationsGlobal.push(now)
}

function adminAuthorized(req) {
  return tokenMatches(administratorToken, req?.headers?.['x-classroom-admin-token'])
}

function revokeInstructorAuthority() {
  instructorSessions.clear()
  for (const classId of [...classes.keys()]) closeClass(classId)
}

async function deleteCredentialFiles() {
  for (const credentialPath of [
    instructorVerifierPath,
    legacyInstructorHashPath,
    legacyInstructorCodePath,
  ]) {
    try {
      await unlink(credentialPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

export async function handleHealthHttp(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname !== '/api/health') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(req, res, 405, { ok: false, error: 'method-not-allowed' })
    return true
  }
  sendJson(req, res, 200, { ok: true, service: 'classroom-relay', protocol: PROTOCOL_VERSION })
  return true
}

export async function handleInstructorAccessHttp(req, res) {
  const url = new URL(req.url || '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/instructor-access')) return false
  if (!isLoopbackAddress(requestIp(req))) {
    sendJson(req, res, 403, { ok: false, error: 'loopback-only' })
    return true
  }

  if (url.pathname === '/api/instructor-access/status' && req.method === 'GET') {
    await migratePlaintextCredential().catch(() => {})
    sendJson(req, res, 200, {
      configured: credentialConfigured(),
      authenticated: instructorSession(req) !== null,
    })
    return true
  }

  if (url.pathname === '/api/instructor-access/session' && req.method === 'POST') {
    const ip = requestIp(req)
    if (failedVerificationLimited(ip)) {
      sendJson(req, res, 429, { ok: false, error: 'rate-limited' })
      return true
    }
    const body = await readJsonBody(req, res)
    if (!body) return true
    let verified
    try {
      verified = await verifyCredential(body.code)
    } catch {
      sendJson(req, res, 500, { ok: false, error: 'verification-failed' })
      return true
    }
    if (!verified) {
      recordFailedVerification(ip)
      sendJson(req, res, 401, { ok: false, error: 'invalid-code' })
      return true
    }
    const token = mintInstructorSession(ip)
    sendJson(req, res, 200, { ok: true }, {
      'set-cookie': sessionCookie(token, req.socket?.encrypted === true),
    })
    return true
  }

  if (url.pathname === '/api/instructor-access/logout' && req.method === 'POST') {
    const session = instructorSession(req)
    if (session) instructorSessions.delete(session.token)
    sendJson(req, res, 200, { ok: true }, {
      'set-cookie': clearSessionCookie(req.socket?.encrypted === true),
    })
    return true
  }

  if (url.pathname === '/api/instructor-access/provision' && req.method === 'POST') {
    if (!adminAuthorized(req)) {
      sendJson(req, res, 401, { ok: false, error: 'administrator-token-required' })
      return true
    }
    if (credentialConfigured()) {
      sendJson(req, res, 409, { ok: false, error: 'already-configured' })
      return true
    }
    const body = await readJsonBody(req, res)
    if (!body) return true
    const verifier = await makeVerifier(body.code).catch(() => null)
    if (!verifier) {
      sendJson(req, res, 400, { ok: false, error: 'invalid-code-policy' })
      return true
    }
    let lockOwned = false
    try {
      await mkdir(secretsDir, { recursive: true })
      await writeFile(provisionLockPath, String(process.pid), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      lockOwned = true
      if (credentialConfigured()) {
        sendJson(req, res, 409, { ok: false, error: 'already-configured' })
        return true
      }
      await writeVerifier(verifier)
      await unlink(legacyInstructorCodePath).catch(() => {})
      await unlink(legacyInstructorHashPath).catch(() => {})
      sendJson(req, res, 201, { ok: true })
    } catch (error) {
      if (error?.code === 'EEXIST') {
        sendJson(req, res, 409, { ok: false, error: 'provision-in-progress' })
        return true
      }
      sendJson(req, res, 500, { ok: false, error: 'provision-failed' })
    } finally {
      if (lockOwned) await unlink(provisionLockPath).catch(() => {})
    }
    return true
  }

  if (url.pathname === '/api/instructor-access/rotate' && req.method === 'POST') {
    if (!adminAuthorized(req)) {
      sendJson(req, res, 401, { ok: false, error: 'administrator-token-required' })
      return true
    }
    const body = await readJsonBody(req, res)
    if (!body) return true
    const verifier = await makeVerifier(body.code).catch(() => null)
    if (!verifier) {
      sendJson(req, res, 400, { ok: false, error: 'invalid-code-policy' })
      return true
    }
    try {
      await writeVerifier(verifier)
      await unlink(legacyInstructorCodePath).catch(() => {})
      await unlink(legacyInstructorHashPath).catch(() => {})
      revokeInstructorAuthority()
      sendJson(req, res, 200, { ok: true }, {
        'set-cookie': clearSessionCookie(req.socket?.encrypted === true),
      })
    } catch {
      sendJson(req, res, 500, { ok: false, error: 'rotate-failed' })
    }
    return true
  }

  if (url.pathname === '/api/instructor-access/reset' && req.method === 'POST') {
    if (!adminAuthorized(req)) {
      sendJson(req, res, 401, { ok: false, error: 'administrator-token-required' })
      return true
    }
    revokeInstructorAuthority()
    try {
      await deleteCredentialFiles()
      sendJson(req, res, 200, { ok: true }, {
        'set-cookie': clearSessionCookie(req.socket?.encrypted === true),
      })
    } catch {
      sendJson(req, res, 500, { ok: false, error: 'reset-failed' }, {
        'set-cookie': clearSessionCookie(req.socket?.encrypted === true),
      })
    }
    return true
  }

  sendJson(req, res, 404, { ok: false, error: 'not-found' })
  return true
}

async function handleHttp(req, res) {
  if (await handleHealthHttp(req, res)) return
  if (await handleInstructorAccessHttp(req, res)) return
  return serveStatic(req, res)
}

function allowedHostnames() {
  const names = new Set(['localhost', '127.0.0.1', '[::1]'])
  for (const networks of Object.values(os.networkInterfaces())) {
    for (const network of networks || []) {
      if (network.family === 'IPv4') names.add(network.address.toLowerCase())
    }
  }
  return names
}

export function validateUpgradeRequest(req, allowed = allowedHostnames()) {
  const host = String(req?.headers?.host || '').toLowerCase()
  if (!host) return { ok: false, reason: 'missing-host' }
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return { ok: false, reason: 'invalid-host' }
  }
  if (!allowed.has(hostname) && !allowed.has(`[${hostname}]`)) {
    return { ok: false, reason: 'untrusted-host' }
  }

  const origin = req?.headers?.origin
  if (!origin) {
    const allowedMissing = process.env.CLASSROOM_ALLOW_MISSING_ORIGIN === '1'
      && isLoopbackAddress(requestIp(req))
    return allowedMissing
      ? { ok: true }
      : { ok: false, reason: 'missing-origin' }
  }
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== host) {
      return { ok: false, reason: 'cross-origin' }
    }
  } catch {
    return { ok: false, reason: 'invalid-origin' }
  }
  return { ok: true }
}

function consumeMessageToken(sock, now = Date.now()) {
  const elapsedSeconds = Math.max(0, now - sock.messageTokenAt) / 1000
  sock.messageTokens = Math.min(
    MESSAGE_BURST,
    sock.messageTokens + elapsedSeconds * MESSAGE_RATE_PER_SEC,
  )
  sock.messageTokenAt = now
  if (sock.messageTokens < 1) return false
  sock.messageTokens -= 1
  return true
}

export function startRelay(port = PORT, options = {}) {
  const requestHandler = (req, res) => {
    void handleHttp(req, res)
  }
  const server = options.server || (options.tls
    ? https.createServer({
        key: options.tls.key,
        cert: options.tls.cert,
      }, requestHandler)
    : http.createServer(requestHandler))
  const secureTransport = options.tls != null
  const activeByIp = new Map()
  const upgradesByIp = new Map()
  const allowedHosts = allowedHostnames()
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
    verifyClient(info, callback) {
      const admission = validateUpgradeRequest(info.req, allowedHosts)
      if (!admission.ok) return callback(false, 403, admission.reason)
      const ip = requestIp(info.req)
      const now = Date.now()
      const cutoff = now - 60_000
      const upgrades = (upgradesByIp.get(ip) || []).filter(stamp => stamp > cutoff)
      if (
        wss.clients.size >= MAX_SOCKETS
        || (activeByIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP
        || upgrades.length >= MAX_UPGRADES_PER_IP_PER_MIN
      ) {
        return callback(false, 429, 'connection-limit')
      }
      upgrades.push(now)
      upgradesByIp.set(ip, upgrades)
      callback(true)
    },
  })

  wss.on('connection', (sock, req) => {
    /** @type {ClassroomSocket} */
    const client = /** @type {ClassroomSocket} */ (/** @type {unknown} */ (sock))
    const ip = requestIp(req)
    activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1)
    authenticateInstructorSocket(client, req)
    const encrypted = /** @type {import('node:tls').TLSSocket} */ (
      /** @type {unknown} */ (req.socket)
    ).encrypted === true
    client.transportTrusted = encrypted
    client.isAlive = true
    client.lastPong = Date.now()
    client.messageTokens = MESSAGE_BURST
    client.messageTokenAt = Date.now()
    const handshakeTimer = setTimeout(() => {
      if (!client.role) client.close(4002, 'handshake-timeout')
    }, HANDSHAKE_TIMEOUT_MS)
    handshakeTimer.unref?.()

    client.on('pong', () => {
      client.isAlive = true
      client.lastPong = Date.now()
    })
    client.on('message', raw => {
      if (!consumeMessageToken(client)) {
        client.close(4008, 'message-rate-limit')
        return
      }
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      try {
        handle(client, msg)
        if (client.role) clearTimeout(handshakeTimer)
      } catch (error) {
        console.error('handler error', error instanceof Error ? error.message : 'unknown')
      }
    })
    client.on('close', () => {
      clearTimeout(handshakeTimer)
      activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1))
      onClose(client)
    })
    client.on('error', () => {})
  })

  const beat = setInterval(() => {
    const now = Date.now()
    for (const rawSocket of wss.clients) {
      /** @type {ClassroomSocket} */
      const sock = /** @type {ClassroomSocket} */ (
        /** @type {unknown} */ (rawSocket)
      )
      if (!sock.isAlive && now - sock.lastPong > HEARTBEAT_TIMEOUT_MS) {
        sock.terminate()
        continue
      }
      sock.isAlive = false
      sock.ping()
    }
  }, HEARTBEAT_PING_MS)
  wss.on('close', () => clearInterval(beat))

  if (!options.server) {
    server.listen(port, () => {
      const protocol = secureTransport ? 'https' : 'http'
      console.log(`Classroom relay on ${protocol}://localhost:${port}`)
      for (const networks of Object.values(os.networkInterfaces())) {
        for (const network of networks || []) {
          if (network.family === 'IPv4' && !network.internal) {
            console.log(`Classroom relay on ${protocol}://${network.address}:${port}`)
          }
        }
      }
    })
  }

  return { server, wss, administratorToken }
}

export function resetRelayState() {
  for (const cls of classes.values()) {
    if (cls.cleanupTimer) clearTimeout(cls.cleanupTimer)
  }
  classes.clear()
  instructorSessions.clear()
  failedVerificationsByIp.clear()
  failedVerificationsGlobal = []
  backupWriteTimes.clear()
  credentialMigrationDeletionFailureForTests = null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const insecureDevelopment = process.env.CLASSROOM_ALLOW_INSECURE_LAN === '1'
    && process.env.CLASSROOM_TLS === '0'
  let tls
  if (!insecureDevelopment) {
    const { ensureClassroomCertificates } = await import('./classroomTls.mjs')
    const applicationData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), '.local', 'share')
    const tlsDirectory = path.resolve(
      process.env.CLASSROOM_TLS_DIR
        || path.join(applicationData, 'Autonomous Drone Simulator Classroom', 'tls'),
    )
    const hosts = []
    for (const networks of Object.values(os.networkInterfaces())) {
      for (const network of networks || []) {
        if (network.family === 'IPv4' && !network.internal) hosts.push(network.address)
      }
    }
    const certificates = await ensureClassroomCertificates({
      directory: tlsDirectory,
      hosts,
    })
    tls = {
      key: certificates.leafPrivateKeyPem,
      cert: `${certificates.leafCertificatePem}\n${certificates.caCertificatePem}`,
    }
    console.log(`[classroom] install this CA certificate on student profiles: ${certificates.caCertificatePath}`)
  } else {
    console.warn('[classroom] INSECURE DEVELOPMENT MODE — graded/live LAN classes are disabled')
  }
  if (administratorTokenWasGenerated) {
    console.log(`[classroom] local administrator token (store securely): ${administratorToken}`)
  }
  startRelay(PORT, { tls })
}
