import { describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  ADMIN_PASS_PREFIX,
  adminPassSigningBytes,
  bytesToBase64Url,
  verifyAdminPassText,
} from '../../server/adminPassVerify.mjs'

// Throwaway keys only — the real signing key never appears in a test.
const trusted = ed25519.keygen()
const stranger = ed25519.keygen()
const trustedPub = bytesToBase64Url(trusted.publicKey)
const REVOKED_ID = 'adm-revoked-1'

vi.mock('@/account/adminKeys', () => ({
  get TRUSTED_ADMIN_PUBLIC_KEYS() { return [trustedPub] },
  get REVOKED_PASS_IDS() { return [REVOKED_ID] },
}))

const { verifyAdminPass } = await import('@/account/adminPass')

function b64(text: string) {
  return bytesToBase64Url(new TextEncoder().encode(text))
}

function sign(payload: unknown, secretKey = trusted.secretKey) {
  const payloadB64 = typeof payload === 'string' ? b64(payload) : b64(JSON.stringify(payload))
  const sig = ed25519.sign(adminPassSigningBytes(payloadB64), secretKey)
  return `${ADMIN_PASS_PREFIX}.${payloadB64}.${bytesToBase64Url(sig)}`
}

const base = { v: 1, email: 'Owner@Example.com', name: 'Owner', passId: 'adm-ok-1', issuedAt: Date.now() - 1000 }

describe('verifyAdminPass', () => {
  it('accepts a valid pass and lower-cases the email', () => {
    const claim = verifyAdminPass(sign(base))
    expect(claim).toEqual({ email: 'owner@example.com', name: 'Owner', passId: 'adm-ok-1', issuedAt: base.issuedAt })
  })

  it('tolerates surrounding whitespace from a paste', () => {
    expect(verifyAdminPass(`\n  ${sign(base)}  \n`)?.passId).toBe('adm-ok-1')
  })

  it('keeps a future expiry and rejects a past one', () => {
    expect(verifyAdminPass(sign({ ...base, expiresAt: Date.now() + 60_000 }))?.expiresAt).toBeGreaterThan(Date.now())
    expect(verifyAdminPass(sign({ ...base, expiresAt: Date.now() - 1 }))).toBeNull()
  })

  it('rejects a revoked passId even with a valid signature', () => {
    expect(verifyAdminPass(sign({ ...base, passId: REVOKED_ID }))).toBeNull()
  })

  it('rejects a pass signed by another key', () => {
    expect(verifyAdminPass(sign(base, stranger.secretKey))).toBeNull()
  })

  it('rejects an edited payload (email swapped after signing)', () => {
    const [prefix, , sig] = sign(base).split('.')
    const forged = `${prefix}.${b64(JSON.stringify({ ...base, email: 'attacker@example.com' }))}.${sig}`
    expect(verifyAdminPass(forged)).toBeNull()
  })

  it('rejects an edited signature', () => {
    const [prefix, payload, sig] = sign(base).split('.')
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(verifyAdminPass(`${prefix}.${payload}.${flipped}`)).toBeNull()
  })

  it('rejects a wrong payload version and a wrong prefix', () => {
    expect(verifyAdminPass(sign({ ...base, v: 2 }))).toBeNull()
    expect(verifyAdminPass(sign(base).replace('DSA1', 'DSA2'))).toBeNull()
  })

  it('rejects a signature made without the domain separator', () => {
    const payloadB64 = b64(JSON.stringify(base))
    const sig = ed25519.sign(new TextEncoder().encode(`DSA1.${payloadB64}`), trusted.secretKey)
    expect(verifyAdminPass(`DSA1.${payloadB64}.${bytesToBase64Url(sig)}`)).toBeNull()
  })

  it('rejects payloads with missing or wrong-typed fields', () => {
    expect(verifyAdminPass(sign({ ...base, email: 'not-an-email' }))).toBeNull()
    expect(verifyAdminPass(sign({ ...base, name: '' }))).toBeNull()
    expect(verifyAdminPass(sign({ ...base, passId: 7 }))).toBeNull()
    expect(verifyAdminPass(sign({ ...base, issuedAt: 'now' }))).toBeNull()
    expect(verifyAdminPass(sign({ ...base, expiresAt: 'soon' }))).toBeNull()
    expect(verifyAdminPass(sign({ ...base, issuedAt: Date.now() + 3_600_000 }))).toBeNull()
    expect(verifyAdminPass(sign('[1,2,3]'))).toBeNull()
    expect(verifyAdminPass(sign('not json'))).toBeNull()
  })

  it('returns null, never throws, on garbage input', () => {
    const garbage: unknown[] = [
      undefined, null, '', ' ', 'DSA1', 'DSA1..', 'DSA1.a.b', 'a.b.c.d', '....', '\u0000', 'x'.repeat(10_000),
      `DSA1.${'A'.repeat(50)}.${'B'.repeat(86)}`, 42, {}, [],
    ]
    for (const input of garbage) {
      expect(() => verifyAdminPass(input as string)).not.toThrow()
      expect(verifyAdminPass(input as string)).toBeNull()
    }
  })

  it('agrees with the shared relay verifier for the same inputs', () => {
    const options = { trustedPublicKeys: [trustedPub], revokedPassIds: [REVOKED_ID] }
    const [prefix, payload, sig] = sign(base).split('.')
    const cases = [
      sign(base),
      sign({ ...base, passId: REVOKED_ID }),
      sign({ ...base, expiresAt: Date.now() - 1 }),
      sign(base, stranger.secretKey),
      `${prefix}.${b64(JSON.stringify({ ...base, email: 'x@y.zz' }))}.${sig}`,
      `${prefix}.${payload}.${sig.slice(0, -2)}`,
      'garbage',
    ]
    for (const pass of cases) {
      expect(verifyAdminPass(pass)).toEqual(verifyAdminPassText(pass, options))
    }
  })
})
