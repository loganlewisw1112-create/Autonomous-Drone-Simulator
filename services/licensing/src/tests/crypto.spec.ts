import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ENTITLEMENT_FEATURES, type EntitlementClaims } from '../contracts.js'
import {
  generateRedemptionCode,
  normalizeCode,
  signCompactJws,
  verifyCompactJws,
} from '../crypto.js'

describe('licensing cryptography', () => {
  it('encodes all 160 random bits as a grouped Crockford code', () => {
    expect(generateRedemptionCode(Buffer.alloc(20))).toBe(
      'ADMS-0000-0000-0000-0000-0000-0000-0000-0000',
    )
    expect(generateRedemptionCode(Buffer.alloc(20, 0xff))).toBe(
      'ADMS-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ',
    )
    expect(normalizeCode('adms zzzz-zzzz zzzz-zzzz-zzzz-zzzz-zzzz-zzzz')).toBe(
      'ADMS-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ',
    )
  })

  it('signs and verifies compact Ed25519 JWS and rejects tampering', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const claims: EntitlementClaims = {
      schemaVersion: 1,
      iss: 'https://licensing.test',
      aud: 'adms-windows-classroom',
      sub: 'licence-1',
      jti: 'lease-1',
      iat: 1,
      nbf: 1,
      exp: 100,
      activatedAt: 1,
      offlineUntil: 100,
      serial: 1,
      tier: 'selected_evaluator_demo',
      installationKeyThumbprint: 'thumbprint',
      features: ENTITLEMENT_FEATURES,
      maxStudentsPerClass: 40,
      maxConcurrentClasses: 1,
      minimumVersion: '1.1.0',
      maximumVersionExclusive: '1.2.0',
    }
    const compact = signCompactJws(claims, privateKey, 'test-key')
    expect(verifyCompactJws(compact, publicKey, 'test-key')).toEqual(claims)
    const [header, payload, signature] = compact.split('.')
    const tamperedPayload = Buffer.from(JSON.stringify({ ...claims, maxStudentsPerClass: 400 })).toString('base64url')
    expect(() => verifyCompactJws(`${header}.${tamperedPayload}.${signature}`, publicKey, 'test-key')).toThrow(
      'signature could not be verified',
    )
    expect(() => verifyCompactJws(compact, publicKey, 'wrong-key')).toThrow('signing key is not trusted')
    expect(payload).toBeTruthy()
  })
})
