import { describe, it, expect } from 'vitest'
import { generateKeyPair, deriveSharedKey, SessionCipher } from '@/classroom/sessionCrypto'
import { fromBase64 } from '@/account/crypto'

const CLASS_ID = 'B2CD3F'
const STUDENT_GRID = { direction: 'student-to-instructor', type: 'student.grid' } as const
const CLASS_COMMAND = { direction: 'instructor-to-student', type: 'class.command' } as const

describe('classroom session crypto', () => {
  it('generates a base64 public key and 32-byte secret', () => {
    const kp = generateKeyPair()
    expect(typeof kp.publicKey).toBe('string')
    expect(fromBase64(kp.publicKey)).toHaveLength(32)
    expect(kp.secretKey).toHaveLength(32)
  })

  it('instructor and student derive the identical key', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const kA = deriveSharedKey(instructor.secretKey, student.publicKey, CLASS_ID)
    const kB = deriveSharedKey(student.secretKey, instructor.publicKey, CLASS_ID)
    expect(kA).toEqual(kB)
  })

  it('seals on one side and opens on the other, both directions', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const iCipher = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const sCipher = SessionCipher.forStudent(student.secretKey, instructor.publicKey, CLASS_ID)

    const payload = { t: 12, d: [['a', 1, 2, 3, 90, 3]], a: 0 }
    expect(sCipher.open(iCipher.seal(payload, CLASS_COMMAND), CLASS_COMMAND)).toEqual(payload)
    expect(iCipher.open(sCipher.seal(payload, STUDENT_GRID), STUDENT_GRID)).toEqual(payload)
  })

  it('a different classId salts to a different key that cannot open the blob', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const good = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const wrongSalt = SessionCipher.forStudent(student.secretKey, instructor.publicKey, 'Z9Y8X7')
    expect(() => wrongSalt.open(good.seal({ x: 1 }, STUDENT_GRID), STUDENT_GRID)).toThrow()
  })

  it('a third party with the wrong keypair cannot open the blob', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const eve = generateKeyPair()
    const good = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const eveCipher = SessionCipher.forStudent(eve.secretKey, instructor.publicKey, CLASS_ID)
    expect(() => eveCipher.open(good.seal({ secret: 'metrics' }, STUDENT_GRID), STUDENT_GRID)).toThrow()
  })

  it('binds ciphertext to direction and semantic message type', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const sender = SessionCipher.forStudent(student.secretKey, instructor.publicKey, CLASS_ID)
    const receiver = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const sealed = sender.seal({ t: 12 }, STUDENT_GRID)

    expect(receiver.open(sealed, STUDENT_GRID)).toEqual({ t: 12 })
    expect(() => receiver.open(sealed, {
      direction: 'student-to-instructor',
      type: 'student.run',
    })).toThrow()
    expect(() => receiver.open(sealed, {
      direction: 'instructor-to-student',
      type: 'class.command',
    })).toThrow()
  })
})
