// Shared ADMIN pass verifier. Plain ESM so the classroom relay (Node) and the
// browser bundle (src/account/adminPass.ts) run the SAME code and cannot drift.
//
// Pass text:  DSA1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>
// The signature covers the UTF-8 bytes of
//   "drone-sim/admin-pass/v1\n" + "DSA1." + payloadB64
// (domain separated, so a signature from another protocol never verifies here).
//
// verifyAdminPassText never throws: every failure path returns null.

import { ed25519 } from '@noble/curves/ed25519.js'

export const ADMIN_PASS_PREFIX = 'DSA1'
export const ADMIN_PASS_DOMAIN = 'drone-sim/admin-pass/v1\n'
const MAX_PASS_LENGTH = 4096
const B64URL = /^[A-Za-z0-9_-]+$/

/** @param {string} value @returns {Uint8Array | null} */
export function base64UrlToBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || !B64URL.test(value)) return null
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
    const bin = atob(padded)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64Url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The exact bytes a pass signature must cover. */
export function adminPassSigningBytes(payloadB64) {
  return new TextEncoder().encode(`${ADMIN_PASS_DOMAIN}${ADMIN_PASS_PREFIX}.${payloadB64}`)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} pass
 * @param {{ trustedPublicKeys: readonly string[], revokedPassIds?: readonly string[], now?: number }} options
 * @returns {{ email: string, name: string, passId: string, issuedAt: number, expiresAt?: number } | null}
 */
export function verifyAdminPassText(pass, options) {
  try {
    if (typeof pass !== 'string') return null
    const text = pass.trim()
    if (text.length === 0 || text.length > MAX_PASS_LENGTH) return null
    const parts = text.split('.')
    if (parts.length !== 3 || parts[0] !== ADMIN_PASS_PREFIX) return null
    const payloadB64 = parts[1]
    const signature = base64UrlToBytes(parts[2])
    const payloadBytes = base64UrlToBytes(payloadB64)
    if (!signature || signature.length !== 64 || !payloadBytes) return null

    const message = adminPassSigningBytes(payloadB64)
    let signed = false
    for (const key of options.trustedPublicKeys ?? []) {
      const publicKey = base64UrlToBytes(key)
      if (!publicKey || publicKey.length !== 32) continue
      try {
        if (ed25519.verify(signature, message, publicKey)) { signed = true; break }
      } catch { /* malformed point: try the next key */ }
    }
    if (!signed) return null

    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes))
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    if (payload.v !== 1) return null
    if (typeof payload.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return null
    if (typeof payload.name !== 'string' || payload.name.trim().length === 0 || payload.name.length > 80) return null
    if (typeof payload.passId !== 'string' || payload.passId.length === 0 || payload.passId.length > 80) return null
    if (!isFiniteNumber(payload.issuedAt)) return null
    if (payload.expiresAt !== undefined && !isFiniteNumber(payload.expiresAt)) return null

    const now = options.now ?? Date.now()
    if (payload.issuedAt > now + 5 * 60_000) return null // issued in the future (5 min clock-skew allowance)
    if (payload.expiresAt !== undefined && now >= payload.expiresAt) return null
    if ((options.revokedPassIds ?? []).includes(payload.passId)) return null

    const claim = {
      email: payload.email.trim().toLowerCase(),
      name: payload.name.trim(),
      passId: payload.passId,
      issuedAt: payload.issuedAt,
    }
    if (payload.expiresAt !== undefined) claim.expiresAt = payload.expiresAt
    return claim
  } catch {
    return null
  }
}
