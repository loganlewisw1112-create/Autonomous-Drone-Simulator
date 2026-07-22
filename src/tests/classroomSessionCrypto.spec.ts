import { describe, it, expect } from 'vitest'
import { generateKeyPair, deriveSharedKey, SessionCipher } from '@/classroom/sessionCrypto'
import { fromBase64 } from '@/account/crypto'

const CLASS_ID = 'B2CD3F'

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
    expect(sCipher.open(iCipher.seal(payload))).toEqual(payload)
    expect(iCipher.open(sCipher.seal(payload))).toEqual(payload)
  })

  it('a different classId salts to a different key that cannot open the blob', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const good = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const wrongSalt = SessionCipher.forStudent(student.secretKey, instructor.publicKey, 'Z9Y8X7')
    expect(() => wrongSalt.open(good.seal({ x: 1 }))).toThrow()
  })

  it('a third party with the wrong keypair cannot open the blob', () => {
    const instructor = generateKeyPair()
    const student = generateKeyPair()
    const eve = generateKeyPair()
    const good = SessionCipher.forInstructor(instructor.secretKey, student.publicKey, CLASS_ID)
    const eveCipher = SessionCipher.forStudent(eve.secretKey, instructor.publicKey, CLASS_ID)
    expect(() => eveCipher.open(good.seal({ secret: 'metrics' }))).toThrow()
  })
})
