import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, SessionCipher } from '@/classroom/sessionCrypto'
import { useClassroomStore } from '@/classroom/classroomStore'
import { isSealedPayload } from '@/classroom/protocol'
import { useDroneStore } from '@/store/droneStore'
import { stopTicking } from '@/sim/SimulationLoop'
import type { ClassConfig, ClassId, Sealed, SealedPayload } from '@/classroom/protocol'
import type { ClassroomFocusFrame } from '@/classroom/classroomClient'
import type { GridFrame } from '@/classroom/gridFrame'

vi.mock('@/classroom/commandRegistry', () => ({
  validateInstructorCommand: (value: unknown) => {
    const command = value as { commandId?: unknown; kind?: unknown }
    return command?.kind === 'pause' && typeof command.commandId === 'string'
      ? { ok: true, command: value }
      : { ok: false, code: 'unknown_command', message: 'Command is not allowed.' }
  },
  executeInstructorCommand: (command: { commandId: string; kind: string }) => ({
    ok: true,
    commandId: command.commandId,
    kind: command.kind,
    affectedDroneIds: [],
  }),
}))

const CLASS_ID: ClassId = 'B2CD3F'
const STUDENT_ID = 'stu-ada'
const CONFIG: ClassConfig = {
  kind: 'catalog',
  scenarioId: 'demo_basic',
  variant: {
    seed: 7, timeOfDay: 'day', season: 'summer',
    weatherSeverity: 0, commsDegradation: 0, thermalDensity: 0,
    batteryPressure: 0, terrainDifficulty: 0,
  },
}

interface WireEnvelope {
  v: 1
  type: string
  classId: ClassId
  from?: string
  studentId?: string | null
  instructorToken?: string
  classPubKey?: string
  studentPubKey?: string
  sealed?: Sealed
}

class FakeWs {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeWs.OPEN
  bufferedAmount = 0
  sent: WireEnvelope[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(public readonly url: string) { sockets.push(this) }
  send(raw: string): void { this.sent.push(JSON.parse(raw) as WireEnvelope) }
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
  vi.useRealTimers()
})

function command(commandId: string) {
  return { commandId, kind: 'pause' } as Parameters<typeof client.sendCommand>[1]
}

function liveInstructor() {
  const generatedId = client.startClass(CONFIG)
  const socket = sockets[0]
  socket.onopen?.()
  const classPubKey = socket.sent[0].classPubKey!
  socket.deliver({ v: 1, type: 'class.ok', classId: generatedId, instructorToken: 'TOKEN' })
  const student = generateKeyPair()
  socket.deliver({
    v: 1,
    type: 'roster.update',
    classId: generatedId,
    students: [{ studentId: STUDENT_ID, displayName: 'Ada', joinedAt: 1, studentPubKey: student.publicKey }],
  })
  return {
    classId: generatedId,
    socket,
    cipher: SessionCipher.forStudent(student.secretKey, classPubKey, generatedId),
  }
}

function liveStudent() {
  client.joinClass(CLASS_ID, 'Ada', true)
  const socket = sockets[0]
  socket.onopen?.()
  const instructor = generateKeyPair()
  const studentPubKey = socket.sent[0].studentPubKey!
  socket.deliver({
    v: 1, type: 'join.ok', classId: CLASS_ID, studentId: STUDENT_ID,
    classPubKey: instructor.publicKey, config: CONFIG,
  })
  return {
    socket,
    cipher: SessionCipher.forInstructor(instructor.secretKey, studentPubKey, CLASS_ID),
  }
}

describe('classroom encrypted command wire', () => {
  it('requires programmatic consent before opening a student socket', () => {
    client.joinClass(CLASS_ID, 'Ada', false)

    expect(sockets).toHaveLength(0)
    expect(useClassroomStore.getState()).toMatchObject({
      status: 'error',
      error: 'remote-control-consent-required',
    })
  })

  it('seals per-student commands with a strictly rising outbound sequence', () => {
    const { classId, socket, cipher } = liveInstructor()

    expect(client.sendCommand(STUDENT_ID, command('cmd-1'))).toEqual([STUDENT_ID])
    expect(client.sendCommand(STUDENT_ID, command('cmd-2'))).toEqual([STUDENT_ID])

    const messages = socket.sent.filter((message) => message.type === 'class.command')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ classId, studentId: STUDENT_ID, instructorToken: 'TOKEN' })
    expect(cipher.open(messages[0].sealed!)).toMatchObject({ seq: 1, body: { commandId: 'cmd-1' } })
    expect(cipher.open(messages[1].sealed!)).toMatchObject({ seq: 2, body: { commandId: 'cmd-2' } })
    expect(useClassroomStore.getState().commands.map((entry) => entry.status)).toEqual(['pending', 'pending'])
  })

  it('executes an authenticated command once, rejects its replay, and returns an encrypted ack', () => {
    const { socket, cipher } = liveStudent()
    const sealed = cipher.seal({ seq: 1, body: command('cmd-1') })
    const envelope = { v: 1, type: 'command', classId: CLASS_ID, sealed }

    socket.deliver(envelope)
    socket.deliver(envelope)

    const acks = socket.sent.filter((message) => message.type === 'student.ack')
    expect(acks).toHaveLength(1)
    expect(cipher.open(acks[0].sealed!)).toMatchObject({
      seq: 2,
      body: {
        commandId: 'cmd-1',
        actorId: 'classroom:instructor:B2CD3F',
        ok: true,
      },
    })
    const state = useClassroomStore.getState()
    expect(state.interventions).toHaveLength(1)
    expect(state.takeoverNotice?.expiresAt).toBeGreaterThanOrEqual(state.takeoverNotice!.executedAt + 3_000)
    expect(state.commandRejects).toBe(1)
  })

  it('decrypts a student ack and resolves the matching pending command', () => {
    const { classId, socket, cipher } = liveInstructor()
    client.sendCommand(STUDENT_ID, command('cmd-1'))

    socket.deliver({
      v: 1,
      type: 'student.ack',
      classId,
      from: STUDENT_ID,
      sealed: cipher.seal({
        seq: 1,
        body: {
          commandId: 'cmd-1', actorId: `classroom:instructor:${classId}`,
          ok: true, affectedDroneIds: [],
        },
      }),
    })

    expect(useClassroomStore.getState().commandAcks).toHaveLength(1)
    expect(useClassroomStore.getState().commands[0].status).toBe('acknowledged')
  })

  it('rejects a decrypted non-whitelisted command and acknowledges the failure', () => {
    const { socket, cipher } = liveStudent()
    socket.deliver({
      v: 1,
      type: 'command',
      classId: CLASS_ID,
      sealed: cipher.seal({ seq: 1, body: { commandId: 'cmd-bad', kind: 'shell' } }),
    })

    const acks = socket.sent.filter((message) => message.type === 'student.ack')
    expect(acks).toHaveLength(1)
    expect(cipher.open(acks[0].sealed!)).toMatchObject({
      body: { commandId: 'cmd-bad', ok: false, code: 'unknown_command' },
    })
    expect(useClassroomStore.getState().commandRejects).toBe(1)
    expect(useClassroomStore.getState().interventions).toHaveLength(0)
  })

  it('publishes the current simulator store on every live grid interval', () => {
    vi.useFakeTimers()
    const { socket, cipher } = liveStudent()
    stopTicking()

    const gridMessages = () => socket.sent.filter((message) => message.type === 'student.grid')
    expect(gridMessages()).toHaveLength(1)

    const nextPosition = { lat: 37.81234, lng: -122.45678 }
    useDroneStore.setState((state) => ({
      elapsedSec: 42.2,
      drones: state.drones.map((drone, index) => index === 0
        ? { ...drone, position: nextPosition, headingDeg: 123, batteryPct: 66 }
        : drone),
    }))

    vi.advanceTimersByTime(250)

    const latest = gridMessages().at(-1)
    expect(gridMessages().length).toBeGreaterThanOrEqual(2)
    const opened = cipher.open<SealedPayload<GridFrame>>(latest!.sealed!)
    expect(isSealedPayload(opened)).toBe(true)
    expect(opened.body.t).toBe(42)
    expect(opened.body.d[0].slice(0, 5)).toEqual([
      'uav-01',
      Math.round(nextPosition.lat * 1e5),
      Math.round(nextPosition.lng * 1e5),
      123,
      66,
    ])
  })

  it('publishes focused frames from live state, not the slow replay buffer', () => {
    vi.useFakeTimers()
    const { socket, cipher } = liveStudent()
    stopTicking()

    const staleReplayPosition = { lat: 37.7, lng: -122.4 }
    const livePosition = { lat: 37.82345, lng: -122.46789 }
    const state = useDroneStore.getState()
    useDroneStore.setState({
      elapsedSec: 61.4,
      tick: 1228,
      drones: state.drones.map((drone, index) => index === 0
        ? { ...drone, position: livePosition, headingDeg: 210, batteryPct: 55 }
        : drone),
      replayFrames: [{
        tick: 40,
        elapsedSec: 2,
        drones: state.drones.map((drone, index) => index === 0
          ? { ...drone, position: staleReplayPosition }
          : drone),
        thermalContacts: [],
        groundUnits: [],
        recoveryTeams: [],
        weatherState: { ...state.weatherState },
        activeEventIds: ['stale-replay-frame'],
      }],
    })

    socket.deliver({ v: 1, type: 'focus.on', classId: CLASS_ID })

    const focus = socket.sent.filter((message) => message.type === 'student.focus').at(-1)
    const opened = cipher.open<SealedPayload<ClassroomFocusFrame>>(focus!.sealed!)
    expect(isSealedPayload(opened)).toBe(true)
    expect(opened.body.frame.elapsedSec).toBe(61.4)
    expect(opened.body.frame.tick).toBe(1228)
    expect(opened.body.frame.activeEventIds).not.toContain('stale-replay-frame')
    expect(opened.body.frame.drones[0].position).toEqual(livePosition)
  })
})
