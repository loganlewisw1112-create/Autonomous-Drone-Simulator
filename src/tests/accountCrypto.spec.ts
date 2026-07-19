import { describe, it, expect } from 'vitest'
import {
  deriveKey, encryptJson, decryptJson, makeCheckBlob, verifyCheckBlob, makeKdfParams, toBase64, fromBase64,
} from '@/account/crypto'
import { PBKDF2_ITERATIONS } from '@/account/types'

describe('account crypto', () => {
  it('round-trips base64', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64])
    expect(fromBase64(toBase64(bytes))).toEqual(bytes)
  })

  it('generates unique salts and OWASP-level iteration counts', () => {
    const a = makeKdfParams()
    const b = makeKdfParams()
    expect(a.salt).not.toBe(b.salt)
    expect(a.iterations).toBe(PBKDF2_ITERATIONS)
    expect(fromBase64(a.salt)).toHaveLength(16)
  })

  it('derives a deterministic 32-byte key from password + salt', () => {
    const params = { ...makeKdfParams(), iterations: 1000 } // fast test iterations
    const k1 = deriveKey('correct horse battery staple', params)
    const k2 = deriveKey('correct horse battery staple', params)
    expect(k1).toHaveLength(32)
    expect(k1).toEqual(k2)
    expect(deriveKey('different password', params)).not.toEqual(k1)
  })

  it('encrypt/decrypt round-trips JSON with unique IVs per record', () => {
    const key = deriveKey('pw-for-test', { ...makeKdfParams(), iterations: 1000 })
    const payload = { scenarioId: 'wildfire', metrics: { totalFlightDistanceM: 1234.5 } }
    const blobA = encryptJson(key, payload)
    const blobB = encryptJson(key, payload)
    expect(blobA.iv).not.toBe(blobB.iv)
    expect(blobA.ct).not.toBe(blobB.ct)
    expect(decryptJson(key, blobA)).toEqual(payload)
  })

  it('rejects the wrong key via GCM auth-tag failure', () => {
    const params = { ...makeKdfParams(), iterations: 1000 }
    const right = deriveKey('right password', params)
    const wrong = deriveKey('wrong password', params)
    const blob = encryptJson(right, { secret: true })
    expect(() => decryptJson(wrong, blob)).toThrow()
  })

  it('check blob verifies only with the original key', () => {
    const params = { ...makeKdfParams(), iterations: 1000 }
    const key = deriveKey('operator password', params)
    const blob = makeCheckBlob(key)
    expect(verifyCheckBlob(key, blob)).toBe(true)
    expect(verifyCheckBlob(deriveKey('not it', params), blob)).toBe(false)
  })
})
