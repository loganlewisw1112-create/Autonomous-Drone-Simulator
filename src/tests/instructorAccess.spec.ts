import { describe, expect, it } from 'vitest'
import {
  configuredInstructorAccessHash,
  hashInstructorAccessCode,
  timingSafeEqualHex,
  verifyInstructorAccessCode,
} from '@/account/instructorAccess'

describe('instructorAccess', () => {
  it('hashes access codes as lowercase hex SHA-256', () => {
    const hex = hashInstructorAccessCode('agency-demo-code')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInstructorAccessCode('  agency-demo-code  ')).toBe(hex)
  })

  it('compares hex digests in constant time', () => {
    const a = hashInstructorAccessCode('same')
    expect(timingSafeEqualHex(a, a)).toBe(true)
    expect(timingSafeEqualHex(a, hashInstructorAccessCode('other'))).toBe(false)
    expect(timingSafeEqualHex('aa', 'aabb')).toBe(false)
  })

  it('rejects missing or malformed configured hashes', () => {
    expect(configuredInstructorAccessHash(undefined)).toBeNull()
    expect(configuredInstructorAccessHash('')).toBeNull()
    expect(configuredInstructorAccessHash('not-a-hash')).toBeNull()
    expect(configuredInstructorAccessHash(hashInstructorAccessCode('ok'))).toBe(
      hashInstructorAccessCode('ok'),
    )
  })

  it('verifies a code against an expected hash', () => {
    const code = 'TEST-AGENCY-UNLOCK'
    const hash = hashInstructorAccessCode(code)
    expect(verifyInstructorAccessCode(code, hash)).toBe(true)
    expect(verifyInstructorAccessCode(`  ${code}  `, hash)).toBe(true)
    expect(verifyInstructorAccessCode(hash, hash)).toBe(true)
    expect(verifyInstructorAccessCode(hash.toUpperCase(), hash)).toBe(true)
    expect(verifyInstructorAccessCode('wrong', hash)).toBe(false)
    expect(verifyInstructorAccessCode(code, undefined)).toBe(false)
    expect(verifyInstructorAccessCode('', hash)).toBe(false)
  })

  it('ignores surrounding whitespace when verifying pasted codes', () => {
    const code = 'DRONE-CLASS-UNLOCK-2026'
    const hash = hashInstructorAccessCode(code)
    expect(verifyInstructorAccessCode('DRONE-CLASS-UNLOCK-2026', hash)).toBe(true)
    expect(verifyInstructorAccessCode('\nDRONE-CLASS-UNLOCK-2026\r\n', hash)).toBe(true)
  })
})
