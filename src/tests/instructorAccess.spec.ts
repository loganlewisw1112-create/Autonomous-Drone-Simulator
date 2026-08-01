import { describe, expect, it } from 'vitest'
import {
  hashInstructorAccessCode,
  normalizeUnlockInput,
  timingSafeEqualHex,
} from '@/account/instructorAccess'

describe('instructor access pure helpers', () => {
  it('normalizes Unicode and edge whitespace while preserving case and internal spaces', () => {
    expect(normalizeUnlockInput('\nSchool\u200B Code 2026\r\n')).toBe('School Code 2026')
    expect(normalizeUnlockInput('School Code 2026')).not.toBe(normalizeUnlockInput('school code 2026'))
    expect(normalizeUnlockInput('School Code 2026')).not.toBe(normalizeUnlockInput('SchoolCode2026'))
  })

  it('hashes normalized legacy inputs as lowercase SHA-256 hex', () => {
    const hex = hashInstructorAccessCode('agency-demo-code')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(hashInstructorAccessCode('  agency-demo-code  ')).toBe(hex)
  })

  it('compares equal-length legacy hex values without an early mismatch return', () => {
    const a = hashInstructorAccessCode('same')
    expect(timingSafeEqualHex(a, a)).toBe(true)
    expect(timingSafeEqualHex(a, hashInstructorAccessCode('other'))).toBe(false)
    expect(timingSafeEqualHex('aa', 'aabb')).toBe(false)
  })
})
