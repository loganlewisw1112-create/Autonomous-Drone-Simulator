import { describe, it, expect } from 'vitest'
import {
  CLASS_ID_ALPHABET, CLASS_ID_LENGTH, PROTOCOL_VERSION,
  makeClassId, isValidClassId, isMsgType, encodeEnvelope, decodeEnvelope,
} from '@/classroom/protocol'
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
    expect(isMsgType('nope')).toBe(false)
    expect(isMsgType(7)).toBe(false)
  })

  it('encode/decode round-trips every message type', () => {
    const messages: Envelope[] = [
      { v: 1, type: 'class.create', classId: CLASS_ID, classPubKey: 'PUB', config: { kind: 'catalog', scenarioId: 'demo', variant: variant() } },
      { v: 1, type: 'class.focus', classId: CLASS_ID, studentId: 'stu-1' },
      { v: 1, type: 'class.close', classId: CLASS_ID },
      { v: 1, type: 'student.join', classId: CLASS_ID, displayName: 'Ada', studentPubKey: 'SPUB' },
      { v: 1, type: 'student.grid', classId: CLASS_ID, from: 'stu-1', sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.focus', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.run', classId: CLASS_ID, sealed: { iv: 'IV', ct: 'CT' } },
      { v: 1, type: 'student.leave', classId: CLASS_ID },
      { v: 1, type: 'join.ok', classId: CLASS_ID, studentId: 'stu-1', classPubKey: 'PUB', config: { kind: 'catalog', scenarioId: 'demo', variant: variant() } },
      { v: 1, type: 'join.err', classId: CLASS_ID, reason: 'class-full' },
      { v: 1, type: 'focus.on', classId: CLASS_ID },
      { v: 1, type: 'focus.off', classId: CLASS_ID },
      { v: 1, type: 'class.closed', classId: CLASS_ID },
      { v: 1, type: 'roster.update', classId: CLASS_ID, students: [{ studentId: 'stu-1', displayName: 'Ada', joinedAt: 1, studentPubKey: 'SPUB' }] },
      { v: 1, type: 'student.gone', classId: CLASS_ID, from: 'stu-1' },
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
})

function variant() {
  return {
    seed: 1, timeOfDay: 'day' as const, season: 'summer' as const,
    weatherSeverity: 0 as const, commsDegradation: 0 as const, thermalDensity: 0 as const,
    batteryPressure: 0 as const, terrainDifficulty: 0 as const,
  }
}
