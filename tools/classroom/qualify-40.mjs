import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLASS_ID = 'LD4T40'
const STUDENT_COUNT = 40
const DEFAULT_DURATION_SECONDS = 600

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

const durationSeconds = Number(option('--duration-seconds', DEFAULT_DURATION_SECONDS))
if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) {
  throw new Error('--duration-seconds must be an integer from 1 through 3600')
}
const outputPath = path.resolve(ROOT, option(
  '--output',
  path.join('outputs', 'qualification', `classroom-40-${new Date().toISOString().replaceAll(':', '-')}.json`),
))

const temporary = await mkdtemp(path.join(os.tmpdir(), 'adms-classroom-qualification-'))
const adminToken = randomBytes(32).toString('base64url')
process.env.CLASSROOM_ADMIN_TOKEN = adminToken
process.env.CLASSROOM_SECRETS_DIR = path.join(temporary, 'secrets')
process.env.CLASSROOM_RUNS_DIR = path.join(temporary, 'runs')
process.env.NODE_ENV = 'test'

const [{ ensureClassroomCertificates }, relay] = await Promise.all([
  import('../../server/classroomTls.mjs'),
  import('../../server/classroom.mjs'),
])

let relayServer
let relayWebSocketServer
const sockets = []
const expectedCloseSockets = new WeakSet()
const unexpectedClosures = []
const unhandledErrors = []

/**
 * @param {WebSocket} socket
 * @param {string} type
 * @param {(message: Record<string, any>) => boolean} [predicate]
 * @param {number} [timeoutMs]
 */
function waitForMessage(socket, type, predicate = () => true, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), timeoutMs)
    const onMessage = (raw) => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.type === type && predicate(message)) finish(null, message)
    }
    const onClose = (code, reason) => finish(new Error(`Socket closed (${code}: ${reason}) before ${type}`))
    function finish(error, value) {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      if (error) reject(error)
      else resolve(value)
    }
    socket.on('message', onMessage)
    socket.once('close', onClose)
  })
}

function openSocket(url, protocols, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, options)
    const fail = (error) => reject(error)
    socket.once('error', fail)
    socket.once('open', () => {
      socket.off('error', fail)
      sockets.push(socket)
      socket.on('error', error => unhandledErrors.push(error.message))
      socket.on('close', (code, reason) => {
        if (!expectedCloseSockets.has(socket)) unexpectedClosures.push({ code, reason: reason.toString() })
      })
      resolve(socket)
    })
  })
}

function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  expectedCloseSockets.add(socket)
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      socket.terminate()
      resolve()
    }, 2_000)
    socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.close(1000, 'qualification-transition')
  })
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)]
}

async function requestJson(port, ca, pathname, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'localhost',
      port,
      path: pathname,
      method: payload ? 'POST' : 'GET',
      ca,
      rejectUnauthorized: true,
      headers: {
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...headers,
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* reported below */ }
        resolve({ status: response.statusCode, body: parsed, headers: response.headers })
      })
    })
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function mintCapability(port, ca, studentPubKey, resumeToken) {
  const response = await requestJson(port, ca, '/api/classroom/join-capability', {
    classId: CLASS_ID,
    studentPubKey,
    ...(resumeToken ? { resumeToken } : {}),
  })
  if (response.status !== 200 || typeof response.body?.capability !== 'string') {
    throw new Error(`Join capability failed (${response.status}: ${response.body?.error || 'invalid response'})`)
  }
  return response.body.capability
}

async function joinStudent(port, ca, index, resume) {
  const studentPubKey = resume?.studentPubKey || Buffer.alloc(32, index + 1).toString('base64')
  const capability = await mintCapability(port, ca, studentPubKey, resume?.resumeToken)
  const socket = await openSocket(
    `wss://localhost:${port}`,
    ['adms-classroom-v3', capability],
    { ca, rejectUnauthorized: true, origin: `https://localhost:${port}` },
  )
  const joined = waitForMessage(socket, 'join.ok')
  socket.send(JSON.stringify({
    v: 3,
    type: 'student.join',
    classId: CLASS_ID,
    displayName: `Student ${String(index + 1).padStart(2, '0')}`,
    studentPubKey,
    capability,
    ...(resume?.resumeToken ? { resumeToken: resume.resumeToken } : {}),
  }))
  const response = await joined
  return {
    index,
    socket,
    studentPubKey,
    studentId: response.studentId,
    resumeToken: response.resumeToken,
  }
}

async function main() {
  const tls = await ensureClassroomCertificates({ directory: path.join(temporary, 'tls') })
  relay.resetRelayState()
  const now = Date.now()
  relay.setRelayEntitlementForTests({
    sub: 'local-qualification-only',
    exp: Math.floor((now + 4 * 60 * 60_000) / 1000),
    offlineUntil: Math.floor((now + 4 * 60 * 60_000) / 1000),
    maxConcurrentClasses: 1,
  }, now)
  const started = relay.startRelay(0, {
    tls: { key: tls.leafPrivateKeyPem, cert: tls.leafCertificatePem },
  })
  relayServer = started.server
  relayWebSocketServer = started.wss
  if (!relayServer.listening) await new Promise(resolve => relayServer.once('listening', resolve))
  const address = relayServer.address()
  const port = typeof address === 'object' && address ? address.port : null
  if (!port) throw new Error('Relay did not bind a TCP port')

  const instructorCode = 'Local Qualification 2026'
  const provision = await requestJson(port, tls.caCertificatePem, '/api/instructor-access/provision', {
    code: instructorCode,
  }, { 'x-classroom-admin-token': adminToken })
  if (provision.status !== 201) throw new Error(`Instructor provisioning failed: ${provision.status}`)
  const login = await requestJson(port, tls.caCertificatePem, '/api/instructor-access/session', {
    code: instructorCode,
  })
  if (login.status !== 200) throw new Error(`Instructor login failed: ${login.status}`)
  const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0]
  if (!cookie) throw new Error('Instructor login did not return a session cookie')

  const instructor = await openSocket(
    `wss://localhost:${port}`,
    ['adms-classroom-v3'],
    { ca: tls.caCertificatePem, rejectUnauthorized: true, origin: `https://localhost:${port}`, headers: { cookie } },
  )
  let telemetryReceived = 0
  let submissionsReceived = 0
  let acknowledgementsReceived = 0
  let backupWarnings = 0
  instructor.on('message', raw => {
    let message
    try { message = JSON.parse(raw.toString()) } catch { return }
    if (message.type === 'student.grid') telemetryReceived++
    if (message.type === 'student.run') submissionsReceived++
    if (message.type === 'student.ack') acknowledgementsReceived++
    if (message.type === 'backup.warn') backupWarnings++
  })
  const classReady = waitForMessage(instructor, 'class.ok')
  instructor.send(JSON.stringify({
    v: 3,
    type: 'class.create',
    classId: CLASS_ID,
    classPubKey: Buffer.alloc(32, 201).toString('base64'),
    config: { kind: 'catalog', scenarioId: 'load-qualification', durationMinutes: 60 },
  }))
  const classState = await classReady

  let students = []
  for (let index = 0; index < STUDENT_COUNT; index++) students.push(await joinStudent(port, tls.caCertificatePem, index))

  const overflowKey = Buffer.alloc(32, 99).toString('base64')
  const overflowCapability = await mintCapability(port, tls.caCertificatePem, overflowKey)
  const overflow = await openSocket(
    `wss://localhost:${port}`,
    ['adms-classroom-v3', overflowCapability],
    { ca: tls.caCertificatePem, rejectUnauthorized: true, origin: `https://localhost:${port}` },
  )
  const overflowRejected = waitForMessage(overflow, 'join.err')
  overflow.send(JSON.stringify({
    v: 3, type: 'student.join', classId: CLASS_ID, displayName: 'Student 41',
    studentPubKey: overflowKey, capability: overflowCapability,
  }))
  const overflowResult = await overflowRejected
  await closeSocket(overflow)

  const expectedTelemetry = STUDENT_COUNT * durationSeconds
  for (let second = 0; second < durationSeconds; second++) {
    const tickStarted = Date.now()
    for (const student of students) {
      student.socket.send(JSON.stringify({
        v: 3, type: 'student.grid', classId: CLASS_ID,
        sealed: { iv: `grid-${second}`, ct: `student-${student.index}` },
      }))
    }
    const remaining = 1000 - (Date.now() - tickStarted)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
  }

  const focused = students[0]
  const focusOn = waitForMessage(focused.socket, 'focus.on')
  instructor.send(JSON.stringify({ v: 3, type: 'class.focus', classId: CLASS_ID, studentId: focused.studentId }))
  await focusOn
  focused.socket.send(JSON.stringify({
    v: 3, type: 'student.focus', classId: CLASS_ID, sealed: { iv: 'focus', ct: 'stable' },
  }))
  await waitForMessage(instructor, 'student.focus', message => message.from === focused.studentId)

  const commandKind = 'pause'
  const commandStarted = Date.now()
  const commandReceipts = students.map(student => waitForMessage(
    student.socket,
    'command',
    message => message.commandKind === commandKind,
  ).then(() => Date.now() - commandStarted))
  const commandResult = waitForMessage(instructor, 'class.command.result')
  instructor.send(JSON.stringify({
    v: 3,
    type: 'class.command.batch',
    classId: CLASS_ID,
    instructorToken: classState.instructorToken,
    commandKind,
    items: students.map(student => ({
      studentId: student.studentId,
      sealed: { iv: `command-${student.index}`, ct: commandKind },
    })),
  }))
  const [deliveryResult, commandLatencies] = await Promise.all([commandResult, Promise.all(commandReceipts)])
  for (const student of students) {
    student.socket.send(JSON.stringify({
      v: 3, type: 'student.ack', classId: CLASS_ID,
      sealed: { iv: `ack-${student.index}`, ct: commandKind },
    }))
  }
  const acknowledgementDeadline = Date.now() + 10_000
  while (acknowledgementsReceived < STUDENT_COUNT && Date.now() < acknowledgementDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  for (const student of students) {
    student.socket.send(JSON.stringify({
      v: 3, type: 'student.run', classId: CLASS_ID,
      sealed: { iv: `run-${student.index}`, ct: 'final-encrypted-run' },
    }))
  }
  const submissionDeadline = Date.now() + 10_000
  while (submissionsReceived < STUDENT_COUNT && Date.now() < submissionDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  const disconnected = students.map(student => ({ ...student }))
  await Promise.all(students.map(student => closeSocket(student.socket)))
  const reconnectStarted = Date.now()
  const resumed = []
  for (const student of disconnected) resumed.push(await joinStudent(port, tls.caCertificatePem, student.index, student))
  students = resumed
  const reconnectDurationMs = Date.now() - reconnectStarted

  await new Promise(resolve => setTimeout(resolve, 100))
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const checks = {
    exactlyFortyJoined: students.length === STUDENT_COUNT,
    fortyFirstRejected: overflowResult.reason === 'class-full',
    telemetryComplete: telemetryReceived === expectedTelemetry,
    commandQueued: deliveryResult.queued === STUDENT_COUNT && deliveryResult.unavailable === 0,
    allCommandsReceived: commandLatencies.length === STUDENT_COUNT,
    allAcknowledged: acknowledgementsReceived === STUDENT_COUNT,
    allSubmitted: submissionsReceived === STUDENT_COUNT,
    reconnectedWithinSixtySeconds: students.length === STUDENT_COUNT && reconnectDurationMs <= 60_000,
    noUnexpectedDisconnects: unexpectedClosures.length === 0,
    noBackupWarnings: backupWarnings === 0,
    noUnhandledErrors: unhandledErrors.length === 0,
    p95Below500Ms: percentile(commandLatencies, 0.95) < 500,
  }
  const evidence = {
    schemaVersion: 1,
    qualification: 'adms-classroom-40-tls-wss',
    generatedAt: new Date().toISOString(),
    appVersion: packageJson.version,
    revision,
    transport: 'TLS/WSS with generated school-local CA',
    durationSeconds,
    studentCount: STUDENT_COUNT,
    telemetryFramesExpected: expectedTelemetry,
    telemetryFramesReceived: telemetryReceived,
    command: {
      kind: commandKind,
      queued: deliveryResult.queued,
      unavailable: deliveryResult.unavailable,
      acknowledged: acknowledgementsReceived,
      p95RoundTripMs: percentile(commandLatencies, 0.95),
    },
    finalSubmissions: submissionsReceived,
    reconnectDurationMs,
    backupWarnings,
    unexpectedClosures,
    unhandledErrors,
    checks,
    passed: Object.values(checks).every(Boolean),
  }
  const canonical = Buffer.from(JSON.stringify(evidence))
  const configuredKey = process.env.CLASSROOM_QUALIFICATION_ATTESTATION_PRIVATE_KEY_PKCS8_BASE64
  let privateKey
  let publicKey
  let attestationScope
  if (configuredKey) {
    privateKey = createPrivateKey({ key: Buffer.from(configuredKey, 'base64'), format: 'der', type: 'pkcs8' })
    publicKey = process.env.CLASSROOM_QUALIFICATION_ATTESTATION_PUBLIC_KEY_SPKI_BASE64 || null
    attestationScope = 'publisher-protected'
  } else {
    const generated = generateKeyPairSync('ed25519')
    privateKey = generated.privateKey
    publicKey = generated.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    attestationScope = 'ephemeral-local-not-release-approval'
  }
  const report = {
    ...evidence,
    attestation: {
      algorithm: 'Ed25519',
      scope: attestationScope,
      payloadSha256: createHash('sha256').update(canonical).digest('hex'),
      signatureBase64: sign(null, canonical, privateKey).toString('base64'),
      publicKeySpkiBase64: publicKey,
    },
  }
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, checks }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

try {
  await main()
} finally {
  await Promise.allSettled(sockets.map(closeSocket))
  if (relayWebSocketServer) await new Promise(resolve => relayWebSocketServer.close(resolve))
  if (relayServer) await new Promise(resolve => relayServer.close(resolve))
  relay.resetRelayState()
  await rm(temporary, { recursive: true, force: true })
}
