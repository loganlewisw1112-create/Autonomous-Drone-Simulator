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
//   - State is in-memory only; the persisted run backups are ciphertext on disk,
//     useless without the instructor key. Losing the process loses nothing that
//     was secret.

import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.argv[2] || process.env.PORT || 8080)
const MAX_STUDENTS = 40
const MAX_MSG = 256 * 1024

// Resolve relative to the repo root (this file lives in ./server).
const distDir = fileURLToPath(new URL('../dist', import.meta.url))
const runsDir = fileURLToPath(new URL('../classroom-runs', import.meta.url))

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

// classId -> { classPubKey, config, instructorSock, focusedStudentId, students }
// students: studentId -> { sock, entry }
const classes = new Map()

// Only send when the socket can actually take bytes; a half-closed peer is common.
function send(sock, msg) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg))
}

// The roster the instructor sees is exactly the stored entries (no secrets in them).
function sendRoster(cls, classId) {
  const students = [...cls.students.values()].map(s => s.entry)
  send(cls.instructorSock, { v: 1, type: 'roster.update', classId, students })
}

function onCreate(sock, msg) {
  const { classId, classPubKey, config } = msg
  if (typeof classId !== 'string') return
  let cls = classes.get(classId)
  if (cls) {
    // Instructor tab reconnected — take over the room, keep the live roster.
    cls.instructorSock = sock
    if (classPubKey) cls.classPubKey = classPubKey
    if (config !== undefined) cls.config = config
  } else {
    cls = { classPubKey, config, instructorSock: sock, focusedStudentId: null, students: new Map() }
    classes.set(classId, cls)
  }
  sock.role = 'instructor'
  sock.classId = classId
  sendRoster(cls, classId)
}

function onJoin(sock, msg) {
  const { classId, displayName, studentPubKey } = msg
  const cls = classes.get(classId)
  if (!cls) return send(sock, { v: 1, type: 'join.err', classId, reason: 'no-such-class' })
  if (cls.students.size >= MAX_STUDENTS) return send(sock, { v: 1, type: 'join.err', classId, reason: 'class-full' })
  const studentId = crypto.randomUUID().slice(0, 8)
  const entry = { studentId, displayName, joinedAt: Date.now(), studentPubKey }
  cls.students.set(studentId, { sock, entry })
  sock.role = 'student'
  sock.classId = classId
  sock.studentId = studentId
  send(sock, { v: 1, type: 'join.ok', classId, studentId, classPubKey: cls.classPubKey, config: cls.config })
  sendRoster(cls, classId)
}

// Ciphertext crash-backup for the instructor tab. Best-effort: a disk fault must
// never take down the relay, so failures are swallowed after logging.
async function persistRun(classId, studentId, envelope) {
  try {
    const dir = path.join(runsDir, classId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${studentId}-${Date.now()}.json`), JSON.stringify(envelope))
  } catch (err) {
    console.error('run backup failed', err)
  }
}

// student.grid / student.focus / student.run: tag with `from` and hand to the
// instructor. `sealed` is forwarded by reference, never opened.
function onStudentMsg(sock, msg) {
  const cls = classes.get(sock.classId)
  if (!cls || sock.role !== 'student') return
  const from = sock.studentId
  if (msg.type === 'student.run') persistRun(sock.classId, from, msg)
  send(cls.instructorSock, { v: 1, type: msg.type, classId: sock.classId, from, sealed: msg.sealed })
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
  for (const { sock } of cls.students.values()) send(sock, { v: 1, type: 'class.closed', classId })
  classes.delete(classId)
}

function onClassClose(sock) {
  const cls = classes.get(sock.classId)
  if (cls && cls.instructorSock === sock) closeClass(sock.classId)
}

function onClose(sock) {
  if (sock.role === 'student') removeStudent(sock)
  else if (sock.role === 'instructor') {
    // Only tear the room down if this socket is still the active instructor —
    // a superseded (reconnected-over) socket closing must not kill the class.
    const cls = classes.get(sock.classId)
    if (cls && cls.instructorSock === sock) closeClass(sock.classId)
  }
}

// A socket's role is fixed by its first meaningful message.
function handle(sock, msg) {
  if (!msg || msg.v !== 1 || typeof msg.type !== 'string') return
  switch (msg.type) {
    case 'class.create': return onCreate(sock, msg)
    case 'class.focus': return onFocus(sock, msg)
    case 'class.close': return onClassClose(sock)
    case 'student.join': return onJoin(sock, msg)
    case 'student.grid':
    case 'student.focus':
    case 'student.run': return onStudentMsg(sock, msg)
    case 'student.leave': return removeStudent(sock)
  }
}

const server = http.createServer(async (req, res) => {
  // Serving the built app from the same origin lets students just open the URL.
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
    if (raw.length > MAX_MSG) return
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

// Heartbeat: ping every 15s, drop a socket silent for 30s. isAlive flips false on
// each ping and true on the pong that answers it; lastPong gates the 30s cutoff.
const beat = setInterval(() => {
  const now = Date.now()
  for (const sock of wss.clients) {
    if (!sock.isAlive && now - sock.lastPong > 30000) {
      sock.terminate()
      continue
    }
    sock.isAlive = false
    sock.ping()
  }
}, 15000)
wss.on('close', () => clearInterval(beat))

server.listen(PORT, () => {
  console.log(`Classroom relay on http://localhost:${PORT}`)
  // Print a LAN join URL per non-internal IPv4 so students can find the room.
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`Classroom relay on http://${net.address}:${PORT}`)
    }
  }
})
