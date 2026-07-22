import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, SessionCipher } from '@/classroom/sessionCrypto'
import { useClassroomStore } from '@/classroom/classroomStore'
import type { InstructorCommand } from '@/classroom/commandRegistry'
import type { ClassConfig, ClassId, Sealed, SealedPayload } from '@/classroom/protocol'

const CONFIG: ClassConfig = {
  kind: 'catalog',
  scenarioId: 'demo_basic',
  variant: {
    seed: 7,
    timeOfDay: 'day',
    season: 'summer',
    weatherSeverity: 0,
    commsDegradation: 0,
    thermalDensity: 0,
    batteryPressure: 0,
    terrainDifficulty: 0,
  },
}

const STUDENTS = [
  { studentId: 'stu-ada', displayName: 'Ada' },
  { studentId: 'stu-bo', displayName: 'Bo' },
] as const

interface WireEnvelope {
  v: 1
  type: string
  classId: ClassId
  studentId?: string | null
  instructorToken?: string
  classPubKey?: string
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
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function command(commandId: string): InstructorCommand {
  return { commandId, kind: 'pause' }
}

describe('classroom encrypted command fan-out', () => {
  it('seals a class-wide command independently for every named student', () => {
    const classId = client.startClass(CONFIG)
    const socket = sockets[0]
    socket.onopen?.()
    const instructorPublicKey = socket.sent[0].classPubKey!
    socket.deliver({ v: 1, type: 'class.ok', classId, instructorToken: 'TOKEN' })

    const keyPairs = STUDENTS.map(() => generateKeyPair())
    socket.deliver({
      v: 1,
      type: 'roster.update',
      classId,
      students: STUDENTS.map((student, index) => ({
        ...student,
        joinedAt: index + 1,
        studentPubKey: keyPairs[index].publicKey,
      })),
    })
    const studentCiphers = new Map<string, SessionCipher>(STUDENTS.map((student, index) => [
      student.studentId,
      SessionCipher.forStudent(keyPairs[index].secretKey, instructorPublicKey, classId),
    ]))

    expect(client.sendCommand(null, command('broadcast-1'))).toEqual(STUDENTS.map((student) => student.studentId))

    const first = socket.sent.filter((message) => message.type === 'class.command')
    expect(first).toHaveLength(2)
    expect(first.map((message) => message.studentId)).toEqual(STUDENTS.map((student) => student.studentId))
    expect(first).toEqual(expect.arrayContaining(STUDENTS.map((student) => expect.objectContaining({
      type: 'class.command',
      classId,
      studentId: student.studentId,
      instructorToken: 'TOKEN',
    }))))

    const adaCipher = studentCiphers.get('stu-ada')!
    const boCipher = studentCiphers.get('stu-bo')!
    const adaFirst = first.find((message) => message.studentId === 'stu-ada')!
    const boFirst = first.find((message) => message.studentId === 'stu-bo')!
    expect(adaCipher.open<SealedPayload<InstructorCommand>>(adaFirst.sealed!)).toEqual({
      seq: 1,
      body: command('broadcast-1'),
    })
    expect(boCipher.open<SealedPayload<InstructorCommand>>(boFirst.sealed!)).toEqual({
      seq: 1,
      body: command('broadcast-1'),
    })
    expect(adaFirst.sealed?.ct).not.toBe(boFirst.sealed?.ct)
    expect(() => adaCipher.open(boFirst.sealed!)).toThrow()
    expect(() => boCipher.open(adaFirst.sealed!)).toThrow()

    expect(useClassroomStore.getState().commands).toMatchObject(STUDENTS.map((student) => ({
      commandId: 'broadcast-1',
      studentId: student.studentId,
      status: 'pending',
    })))

    expect(client.sendCommand(null, command('broadcast-2'))).toEqual(STUDENTS.map((student) => student.studentId))
    const second = socket.sent.filter((message) => message.type === 'class.command').slice(2)
    expect(second).toHaveLength(2)
    for (const message of second) {
      const cipher = studentCiphers.get(message.studentId!)!
      expect(cipher.open<SealedPayload<InstructorCommand>>(message.sealed!)).toEqual({
        seq: 2,
        body: command('broadcast-2'),
      })
    }
    expect(useClassroomStore.getState().commands).toHaveLength(4)
  })
})
