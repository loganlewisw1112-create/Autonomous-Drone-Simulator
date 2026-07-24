// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  clearDeviceInstructorAccessHash,
  configuredInstructorAccessHash,
  hashInstructorAccessCode,
  instructorAccessIsConfigured,
  provisionInstructorAccessCode,
  readDeviceInstructorAccessHash,
  timingSafeEqualHex,
  verifyInstructorAccessCode,
  writeDeviceInstructorAccessHash,
} from '@/account/instructorAccess'

describe('instructorAccess', () => {
  beforeEach(() => {
    clearDeviceInstructorAccessHash()
    // .env.local may inject a maintainer digest; first-code tests need a clean slate.
    vi.stubEnv('VITE_INSTRUCTOR_ACCESS_HASH', '')
  })

  afterEach(() => {
    clearDeviceInstructorAccessHash()
    vi.unstubAllEnvs()
  })

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

  it('provisions the first typed code onto device storage and refuses overwrite', () => {
    expect(instructorAccessIsConfigured(undefined)).toBe(false)
    const first = provisionInstructorAccessCode('School-Code-One')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(readDeviceInstructorAccessHash()).toBe(first.hash)
    expect(verifyInstructorAccessCode('School-Code-One')).toBe(true)

    const second = provisionInstructorAccessCode('Different-Code')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('already-configured')
    expect(readDeviceInstructorAccessHash()).toBe(first.hash)
    expect(verifyInstructorAccessCode('Different-Code')).toBe(false)
  })

  it('does not overwrite a device hash with a different digest', () => {
    const a = hashInstructorAccessCode('alpha')
    const b = hashInstructorAccessCode('beta')
    expect(writeDeviceInstructorAccessHash(a)).toBe(true)
    expect(writeDeviceInstructorAccessHash(b)).toBe(false)
    expect(readDeviceInstructorAccessHash()).toBe(a)
  })
})
