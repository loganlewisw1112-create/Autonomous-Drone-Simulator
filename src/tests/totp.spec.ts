import { describe, it, expect } from 'vitest'
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  hotp,
  totpCode,
  verifyTotp,
} from '@/account/totp'

// RFC 6238 Appendix B, SHA-1 column. The RFC prints 8-digit codes; a 6-digit code is the
// same truncated value mod 10^6, i.e. the last six digits.
const RFC_SECRET = new TextEncoder().encode('12345678901234567890')
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
]

describe('totp (RFC 6238, SHA-1)', () => {
  it.each(RFC_VECTORS)('T=%i matches the RFC vector', (seconds, expected8) => {
    expect(totpCode(RFC_SECRET, seconds * 1000, 8)).toBe(expected8)
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected8.slice(-6))
  })

  it('matches RFC 4226 HOTP counter 0 and 1', () => {
    expect(hotp(RFC_SECRET, 0)).toBe('755224')
    expect(hotp(RFC_SECRET, 1)).toBe('287082')
  })

  it('accepts the current step and one step either side, nothing further', () => {
    const now = 1_700_000_000_000
    const code = totpCode(RFC_SECRET, now)
    expect(verifyTotp(RFC_SECRET, code, now)).toBe(true)
    expect(verifyTotp(RFC_SECRET, code, now + 30_000)).toBe(true)
    expect(verifyTotp(RFC_SECRET, code, now - 30_000)).toBe(true)
    expect(verifyTotp(RFC_SECRET, code, now + 90_000)).toBe(false)
  })

  it('rejects malformed codes and tolerates spaces/dashes', () => {
    const now = 1_700_000_000_000
    const code = totpCode(RFC_SECRET, now)
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true)
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBe(false)
    expect(verifyTotp(RFC_SECRET, '', now)).toBe(false)
  })

  it('round-trips base32 and builds an otpauth URI with issuer', () => {
    const encoded = base32Encode(RFC_SECRET)
    expect(encoded).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect([...base32Decode(encoded)]).toEqual([...RFC_SECRET])
    const uri = buildOtpauthUri('op one', encoded)
    expect(uri.startsWith('otpauth://totp/')).toBe(true)
    expect(uri).toContain(`secret=${encoded}`)
    expect(uri).toContain('issuer=Drone%20Ops%20Center')
  })
})
