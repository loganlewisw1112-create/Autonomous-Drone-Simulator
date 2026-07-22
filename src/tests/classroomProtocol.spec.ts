import { describe, it, expect } from 'vitest'
import {
  CLASS_ID_ALPHABET, CLASS_ID_LENGTH, PROTOCOL_VERSION,
  MAX_STUDENTS, MAX_CLASSES, MAX_MESSAGE_BYTES, HEARTBEAT_TIMEOUT_MS,
  makeClassId, isValidClassId, isMsgType, encodeEnvelope, decodeEnvelope,
  acceptsSeq, isSealedPayload,
} from '@/classroom/protocol'
import limits from '@/classroom/limits.json'
import type { Envelope } from '@/classroom/protocol'

const CLASS_ID = 'B2CD3F'

describe('classroom protocol', () => {
  it('mints 6-char class ids from a vowel-free alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const id = makeClassId()
      expect(id).toHaveLength(CLASS_ID_LENGTH)
      expect([...id].every((c) => CLASS_ID_ALPHABET.includes(c))).toBe(true)
      expect(/[AEIOU]/.test(id)).toBe(false)
    }
  })

  it('validates class ids by length and alphabet', () => {
    expect(isValidClassId(makeClassId())).toBe(true)
    expect(isValidClassId('B2CD3F')).toBe(true)
    expect(isValidClassId('short')).toBe(false)
    expect(isValidClassId('AEIOU1')).toBe(false) // vowels not in alphabet
    expect(isValidClassId(42)).toBe(false)
  })

  it('recognizes only known message types', () => {
    expect(isMsgType('student.grid')).toBe(true)
    expect(isMsgType('class.create')).toBe(true)
    expect(isMsgType('class.command')).toBe(true)
    expect(isMsgType('command')).toBe(true)
    expect(isMsgType('student.ack')).toBe(true)
    expect(isMsgType('nope')).toBe(false)
    expect(isMsgType(7)).toBe(false)
  })

  it('encode/decode round-trips every message type', () => {
    const messages: Envelope[] = [
      { v: 1, type: 'class.create', classId: CLASS_ID, classPubKey: 'PUB', config: { kind: 'catalog', scenarioId: 'demo', variant: variant() } },
      { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: 'stu-1' },
      { v: 1, type: 'class.command', classId: CLASS_ID, studentId: 'stu-1', instructorToken: 'TOK', sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'class.close', classId: CLASS_ID },
      { v: 1, type: 'student.join', classId: CLASS_ID, displayName: 'Ada', studentPubKey: 'SPUB' },
      { v: 1, type: 'student.grid', classId: CLASS_ID, from: 'stu-1', sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.focus', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.run', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.ack', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.leave', classId: CLASS_ID },
      { v: 1, type: 'join.ok', classId: CLASS_ID, studentId: 'stu-1', classPubKey: 'PUB', config: { kind: 'catalog', scenarioId: 'demo', variant: variant() } },
      { v: 1, type: 'join.err', classId: CLASS_ID, reason: 'class-full' },
      { v: 1, type: 'focus.on', classId: CLASS_ID },
      { v: 1, type: 'focus.off', classId: CLASS_ID },
      { v: 1, type: 'command', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'class.closed', classId: CLASS_ID },
      { v: 1, type: 'roster.update', classId: CLASS_ID, students: [{ studentId: 'stu-1', displayName: 'Ada', joinedAt: 1, studentPubKey: 'SPUB' }] },
      { v: 1, type: 'student.gone', classId: CLASS_ID, from: 'stu-1' },
      { v: 1, type: 'class.create', classId: CLASS_ID, classPubKey: 'PUB', config: { kind: 'catalog', scenarioId: 'demo', variant: variant() }, instructorToken: 'TOK' },
      { v: 1, type: 'class.ok', classId: CLASS_ID, instructorToken: 'TOK' },
      { v: 1, type: 'class.err', classId: CLASS_ID, reason: 'not-instructor' },
    ]
    for (const msg of messages) {
      expect(decodeEnvelope(encodeEnvelope(msg))).toEqual(msg)
    }
  })

  it('rejects malformed envelopes', () => {
    expect(() => decodeEnvelope('not json')).toThrow()
    expect(() => decodeEnvelope(JSON.stringify({ v: 2, type: 'focus.on', classId: CLASS_ID }))).toThrow(/version/)
    expect(() => decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'evil.exec', classId: CLASS_ID }))).toThrow(/type/)
    expect(() => decodeEnvelope(JSON.stringify({ v: PROTOCOL_VERSION, type: 'focus.on', classId: 'AEIOU1' }))).toThrow(/classId/)
  })

  it('takes every guardrail from the one file the server also reads', () => {
    // Literals on both sides drifted once already — the relay enforced its own copies
    // and never learned the class-code alphabet at all. classroomServer.spec asserts
    // the server end of the same equality.
    expect(MAX_STUDENTS).toBe(limits.MAX_STUDENTS)
    expect(MAX_CLASSES).toBe(limits.MAX_CLASSES)
    expect(MAX_MESSAGE_BYTES).toBe(limits.MAX_MESSAGE_BYTES)
    expect(HEARTBEAT_TIMEOUT_MS).toBe(limits.HEARTBEAT_TIMEOUT_MS)
    expect(CLASS_ID_ALPHABET).toBe(limits.CLASS_ID_ALPHABET)
    expect(CLASS_ID_LENGTH).toBe(limits.CLASS_ID_LENGTH)
  })
})

// The sealed anti-replay counter (build plan §2.3, implemented inside the ciphertext
// rather than on the cleartext envelope — see SealedPayload).
describe('classroom sealed sequence', () => {
  it('accepts only a strictly rising counter', () => {
    expect(acceptsSeq(undefined, 1)).toBe(true) // first frame of a session
    expect(acceptsSeq(4, 5)).toBe(true)
    expect(acceptsSeq(4, 900)).toBe(true) // gaps are normal: dropped + backpressure-skipped frames
    expect(acceptsSeq(4, 4)).toBe(false) // verbatim replay
    expect(acceptsSeq(4, 3)).toBe(false) // rewind
    expect(acceptsSeq(0, 0)).toBe(false)
  })

  it('refuses a counter that is not a finite number', () => {
    expect(acceptsSeq(undefined, Number.NaN)).toBe(false)
    expect(acceptsSeq(undefined, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('recognizes a sealed payload only when it carries both fields', () => {
    expect(isSealedPayload({ seq: 1, body: { t: 0 } })).toBe(true)
    expect(isSealedPayload({ seq: 1, body: undefined })).toBe(true) // key present is enough
    expect(isSealedPayload({ seq: 1 })).toBe(false)
    expect(isSealedPayload({ body: {} })).toBe(false)
    expect(isSealedPayload({ seq: '1', body: {} })).toBe(false)
    expect(isSealedPayload({ t: 0, st: 1, d: [] })).toBe(false) // an unsequenced pre-fix frame
    expect(isSealedPayload(null)).toBe(false)
  })
})

function variant() {
  return {
    seed: 1, timeOfDay: 'day' as const, season: 'summer' as const,
    weatherSeverity: 0 as const, commsDegradation: 0 as const, thermalDensity: 0 as const,
    batteryPressure: 0 as const, terrainDifficulty: 0 as const,
  }
}
