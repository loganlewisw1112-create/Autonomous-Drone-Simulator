import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPair, SessionCipher } from '@/classroom/sessionCrypto'
import { buildGridFrame, type GridFrame } from '@/classroom/gridFrame'
import { useClassroomStore } from '@/classroom/classroomStore'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import type { ClassConfig, ClassId, Sealed } from '@/classroom/protocol'
import type { DroneState, FullMissionFrame } from '@/types'
import type { MissionAssessment } from '@/classroom/missionAssessment'

// Anti-replay + integrity reporting, driven through the REAL instructor message
// handler in classroomClient with a fake socket — no network, no port. Build plan §2.3
// specified a `seq` that was never implemented, so a captured student.grid re-injected
// on the LAN rendered as a live tile and a captured student.run silently overwrote a
// newer submission (classroomStore.addRun replaces by studentId). All three decrypt
// sites also swallowed their exceptions, so none of that was visible to anyone.

const CONFIG: ClassConfig = {
  kind: 'catalog',
  scenarioId: 'demo',
  variant: {
    seed: 7, timeOfDay: 'day', season: 'summer',
    weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0, batteryPressure: 0, terrainDifficulty: 0,
  },
}

const STUDENT_ID = 'stu-ada'

function drone(id: string, over: Partial<DroneState> = {}): DroneState {
  return {
    id, label: id.toUpperCase(), color: '#39d98a', position: { lat: 37.77, lng: -122.41 },
    altitudeFt: 200, headingDeg: 45, speedMs: 10, batteryPct: 72, signalDbm: -60,
    missionState: 'navigate', currentWaypointIndex: 1,
    conflictFlag: false, geofenceBreachFlag: false, bvlosFlag: false, sortieCount: 0, ...over,
  }
}

function frameAt(elapsedSec: number): GridFrame {
  return buildGridFrame({ elapsedSec, status: 1, drones: [drone('alpha')], thermalContactCount: 0, eventCount: 0 })
}

function assessment(total = 82): MissionAssessment {
  return {
    progressPercent: 75,
    objectives: [],
    lifeSafety: { status: 'pass', severity: 'none', cap: 100, findings: [] },
    tier1: 52,
    tier2: 30,
    uncappedTotal: total,
    total,
    band: total >= 80 ? 'B' : total >= 70 ? 'C' : total >= 60 ? 'D' : 'F',
    interventions: [],
  }
}

function fullFrameAt(elapsedSec: number): FullMissionFrame {
  return {
    tick: elapsedSec * 20,
    elapsedSec,
    drones: [drone('alpha')],
    thermalContacts: [],
    groundUnits: [],
    recoveryTeams: [],
    weatherState: getDefaultWeatherState(7),
    activeEventIds: [],
  }
}

interface WireEnvelope { v: 1; type: string; classId: ClassId; from?: string; sealed?: Sealed; [k: string]: unknown }

// Minimal stand-in for the browser WebSocket: the client only touches readyState,
// bufferedAmount, send, close and the four handlers.
class FakeWs {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState: number = FakeWs.OPEN
  bufferedAmount = 0
  sent: WireEnvelope[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) { sockets.push(this) }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as WireEnvelope) }
  close(): void { this.readyState = FakeWs.CLOSED }
  deliver(msg: unknown): void { this.onmessage?.({ data: JSON.stringify(msg) }) }
}

let sockets: FakeWs[] = []
let client: typeof import('@/classroom/classroomClient')

beforeEach(async () => {
  sockets = []
  vi.stubGlobal('WebSocket', FakeWs)
  // Skip the `location`-derived URL: this spec runs in the default node environment.
  vi.stubEnv('VITE_CLASSROOM_WS_URL', 'ws://relay.test')
  client = await import('@/classroom/classroomClient')
  client.teardown()
  useClassroomStore.getState().reset()
})

afterEach(() => {
  client.teardown()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

// Brings the instructor up to "class live, one student on the roster" and returns the
// student-side cipher — derived from the very classPubKey the client put on the wire,
// so the shared key is the real one, not a fixture.
function liveClassWithStudent() {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const classId = client.startClass(CONFIG)
  const sock = sockets[0]
  sock.onopen!()
  const classPubKey = sock.sent[0].classPubKey as string
  sock.deliver({ v: 1, type: 'class.ok', classId, instructorToken: 'TOKEN' })

  const student = generateKeyPair()
  sock.deliver({
    v: 1, type: 'roster.update', classId,
    students: [{ studentId: STUDENT_ID, displayName: 'Ada', joinedAt: 1, studentPubKey: student.publicKey }],
  })
  return { classId, sock, classPubKey, student, cipher: SessionCipher.forStudent(student.secretKey, classPubKey, classId) }
}

function sealedEnvelope(type: string, classId: ClassId, cipher: SessionCipher, seq: number, body: unknown) {
  return { v: 1, type, classId, from: STUDENT_ID, sealed: cipher.seal({ seq, body }) }
}

function runBody(displayName: string, durationSec: number) {
  return { v: 1, summary: { durationSec }, assessment: assessment(durationSec >= 900 ? 92 : 68), student: { displayName } }
}

describe('classroom anti-replay', () => {
  it('accepts a rising sealed seq and renders the frame', () => {
    const { classId, sock, cipher } = liveClassWithStudent()

    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 1, frameAt(10)))
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(10)

    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 2, frameAt(20)))
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(20)

    // Gaps are normal — dropped frames and backpressure skips both leave holes.
    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 90, frameAt(30)))
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(30)
    expect(useClassroomStore.getState().integrity.replayRejects).toBe(0)
  })

  it('drops a captured grid frame re-injected verbatim', () => {
    const { classId, sock, cipher } = liveClassWithStudent()
    const captured = sealedEnvelope('student.grid', classId, cipher, 1, frameAt(10))

    sock.deliver(captured)
    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 2, frameAt(20)))
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(20)

    // The attack: replay the byte-identical envelope so a stale position reads as live.
    sock.deliver(captured)
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(20)
    expect(useClassroomStore.getState().integrity.replayRejects).toBe(1)
  })

  it('will not let a replayed run submission overwrite a newer one', () => {
    const { classId, sock, cipher } = liveClassWithStudent()
    const early = sealedEnvelope('student.run', classId, cipher, 3, runBody('Ada', 120))

    sock.deliver(early)
    expect(useClassroomStore.getState().runs).toHaveLength(1)

    sock.deliver(sealedEnvelope('student.run', classId, cipher, 4, runBody('Ada', 900)))
    const after = useClassroomStore.getState().runs
    expect(after).toHaveLength(1)
    expect(after[0].summary.durationSec).toBe(900)
    expect(after[0].assessment.total).toBe(92)

    // addRun replaces by studentId, so an un-checked replay would silently downgrade a
    // graded result back to the earlier attempt.
    sock.deliver(early)
    const final = useClassroomStore.getState().runs
    expect(final).toHaveLength(1)
    expect(final[0].summary.durationSec).toBe(900)
    expect(useClassroomStore.getState().integrity.replayRejects).toBe(1)
  })

  it('stores the focused full frame and its narrative assessment atomically', () => {
    const { classId, sock, cipher } = liveClassWithStudent()
    useClassroomStore.getState().setFocused(STUDENT_ID)

    sock.deliver(sealedEnvelope('student.focus', classId, cipher, 1, {
      frame: fullFrameAt(45),
      assessment: assessment(78),
    }))

    const focused = useClassroomStore.getState()
    expect(focused.focusFrame?.elapsedSec).toBe(45)
    expect(focused.focusAssessment).toMatchObject({ total: 78, band: 'C' })

    sock.deliver({ v: 1, type: 'student.gone', classId, from: STUDENT_ID })
    expect(useClassroomStore.getState().focusFrame).toBeNull()
    expect(useClassroomStore.getState().focusAssessment).toBeNull()
  })

  it('rejects a payload with no sealed counter at all', () => {
    const { classId, sock, cipher } = liveClassWithStudent()
    // Correctly encrypted with the real session key, but unsequenced — exactly what a
    // pre-fix client sent, and exactly what a forged cleartext seq would have to fall
    // back to. The counter is only trustworthy under the auth tag.
    sock.deliver({ v: 1, type: 'student.grid', classId, from: STUDENT_ID, sealed: cipher.seal(frameAt(10)) })
    expect(useClassroomStore.getState().frames[STUDENT_ID]).toBeUndefined()
    expect(useClassroomStore.getState().integrity.decryptFailures).toBe(1)
  })

  it('tracks the counter per student, so a fast student cannot stall a slow one', () => {
    const { classId, sock, cipher, classPubKey, student } = liveClassWithStudent()
    const bo = generateKeyPair()
    sock.deliver({
      v: 1, type: 'roster.update', classId,
      students: [
        { studentId: STUDENT_ID, displayName: 'Ada', joinedAt: 1, studentPubKey: student.publicKey },
        { studentId: 'stu-bo', displayName: 'Bo', joinedAt: 2, studentPubKey: bo.publicKey },
      ],
    })
    const boCipher = SessionCipher.forStudent(bo.secretKey, classPubKey, classId)

    // Ada is 50 frames in; Bo has just joined and starts at 1. A single global counter
    // would read Bo's first frame as a rewind and drop every student who joined late.
    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 50, frameAt(50)))
    sock.deliver({ ...sealedEnvelope('student.grid', classId, boCipher, 1, frameAt(1)), from: 'stu-bo' })

    const { frames, integrity } = useClassroomStore.getState()
    expect(frames[STUDENT_ID]?.t).toBe(50)
    expect(frames['stu-bo']?.t).toBe(1)
    expect(integrity.replayRejects).toBe(0)
  })
})

describe('classroom decrypt integrity reporting', () => {
  it('counts ciphertext that will not open instead of swallowing it', () => {
    const { classId, sock } = liveClassWithStudent()
    // A student who joined a DIFFERENT class code, or an active hijack: the blob is
    // well-formed but sealed to the wrong key. This used to be silent.
    const stranger = generateKeyPair()
    const wrongKey = SessionCipher.forStudent(stranger.secretKey, generateKeyPair().publicKey, classId)

    sock.deliver(sealedEnvelope('student.grid', classId, wrongKey, 1, frameAt(10)))
    sock.deliver(sealedEnvelope('student.grid', classId, wrongKey, 2, frameAt(20)))

    const { integrity, frames } = useClassroomStore.getState()
    expect(frames[STUDENT_ID]).toBeUndefined()
    expect(integrity.decryptFailures).toBe(2)
    expect(integrity.lastAt).toEqual(expect.any(Number))
  })

  it('counts a tampered auth tag', () => {
    const { classId, sock, cipher } = liveClassWithStudent()
    const good = sealedEnvelope('student.grid', classId, cipher, 1, frameAt(10))
    const tampered = { ...good, sealed: { iv: good.sealed.iv, ct: `${good.sealed.ct.slice(0, -4)}AAAA` } }

    sock.deliver(tampered)
    expect(useClassroomStore.getState().frames[STUDENT_ID]).toBeUndefined()
    expect(useClassroomStore.getState().integrity.decryptFailures).toBe(1)
  })

  it('aggregates the console rather than logging once per frame', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { classId, sock } = liveClassWithStudent()
    const wrongKey = SessionCipher.forStudent(generateKeyPair().secretKey, generateKeyPair().publicKey, classId)

    warn.mockClear()
    for (let i = 1; i <= 40; i++) sock.deliver(sealedEnvelope('student.grid', classId, wrongKey, i, frameAt(i)))

    // 40 rejected frames — one line, not forty. At 1 Hz × 40 students a per-frame log
    // would bury the one fact the instructor needs.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
    expect(useClassroomStore.getState().integrity.decryptFailures).toBe(40)
  })

  it('forgets a departed student so a rejoin starts from a clean counter', () => {
    const { classId, sock, cipher, classPubKey } = liveClassWithStudent()
    sock.deliver(sealedEnvelope('student.grid', classId, cipher, 5, frameAt(10)))
    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(10)

    sock.deliver({ v: 1, type: 'student.gone', classId, from: STUDENT_ID })
    expect(useClassroomStore.getState().frames[STUDENT_ID]).toBeUndefined()

    // Same id, fresh session key, counter restarted at 1 — must not read as a replay.
    const rejoined = generateKeyPair()
    sock.deliver({
      v: 1, type: 'roster.update', classId,
      students: [{ studentId: STUDENT_ID, displayName: 'Ada', joinedAt: 2, studentPubKey: rejoined.publicKey }],
    })
    const fresh = SessionCipher.forStudent(rejoined.secretKey, classPubKey, classId)
    sock.deliver(sealedEnvelope('student.grid', classId, fresh, 1, frameAt(99)))

    expect(useClassroomStore.getState().frames[STUDENT_ID]?.t).toBe(99)
    expect(useClassroomStore.getState().integrity.replayRejects).toBe(0)
  })
})

// The client half of the takeover fix: the instructor tab is the only party that ever
// holds the token, so it is the only party that can re-bind. classroomServer.spec covers
// the relay half (a create without it is refused).
describe('classroom instructor re-bind', () => {
  it('presents the server-minted token after a drop, and never on the first create', () => {
    vi.useFakeTimers()
    try {
      const classId = client.startClass(CONFIG)
      const sock = sockets[0]
      sock.onopen!()
      expect(sock.sent[0]).not.toHaveProperty('instructorToken')

      sock.deliver({ v: 1, type: 'class.ok', classId, instructorToken: 'TOKEN-XYZ' })
      sock.onclose!()
      vi.advanceTimersByTime(5_000)

      expect(sockets).toHaveLength(2)
      const rebound = sockets[1]
      rebound.onopen!()
      expect(rebound.sent[0].classId).toBe(classId)
      expect(rebound.sent[0].instructorToken).toBe('TOKEN-XYZ')
      // The wall stays mounted across the blip — the roster and last frames are still good.
      expect(useClassroomStore.getState().status).toBe('live')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a create that never succeeded', () => {
    vi.useFakeTimers()
    try {
      client.startClass(CONFIG)
      sockets[0].onopen!()
      sockets[0].onclose!() // no class.ok ever arrived: the relay is not there
      vi.advanceTimersByTime(60_000)
      expect(sockets).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stands down when the relay refuses the class', () => {
    const classId = client.startClass(CONFIG)
    sockets[0].onopen!()
    sockets[0].deliver({ v: 1, type: 'class.err', classId, reason: 'not-instructor' })

    const { status, error } = useClassroomStore.getState()
    expect(status).toBe('error')
    expect(error).toBe('not-instructor')
  })
})

describe('classroom publisher sequencing', () => {
  it('derives assessment from the live store for grid, focus, and final run publishers', () => {
    const src = readFileSync(join(process.cwd(), 'src/classroom/classroomClient.ts'), 'utf8')

    expect(src).toMatch(/function currentGridInput\([\s\S]*?assessment: currentAssessment\(\)/)
    expect(src).toMatch(/function currentFocusFrame\([\s\S]*?assessment = currentAssessment\(\)/)
    expect(src).toMatch(/subscribeRunSubmission\([\s\S]*?currentAssessment\(true, session, summary\.chainVerified\)/)
  })

  it('seals every outgoing student payload through the sequenced helper', () => {
    const src = readFileSync(join(process.cwd(), 'src/classroom/classroomClient.ts'), 'utf8')
    // A direct cipher.seal() anywhere else would put an unsequenced payload on the wire
    // and the instructor's replay check would have nothing to compare against. Mechanical
    // guard, in the same spirit as classroomBundleGuard.
    expect(src.match(/\.seal\(/g) ?? []).toHaveLength(1)
    expect(src).toMatch(/function sealOutgoing\([\s\S]{0,300}?\.seal\(/)
  })

  it('never puts the counter in the cleartext envelope', () => {
    const { sock } = liveClassWithStudent()
    // §2.3 sketched a cleartext `seq`. A field the relay cannot authenticate is worse
    // than none — an attacker could set it arbitrarily high and lock the real student out.
    for (const msg of sock.sent) expect(msg).not.toHaveProperty('seq')
  })
})
