// ADMIN pass verification. A pass is an Ed25519-signed claim issued offline
// by the owners (tools/admin/issue-admin-pass.mjs); the browser holds only the
// public key, so it can check a pass but never mint one.
//
// Format: DSA1.<base64url(JSON payload)>.<base64url(signature)>, signed over
// "drone-sim/admin-pass/v1\nDSA1.<payloadB64>". The verification itself is the
// shared server/adminPassVerify.mjs, so the relay and the browser cannot drift.
//
// verifyAdminPass(pass) -> AdminClaim | null
//   Never throws. Returns null for anything malformed, expired, revoked,
//   signed by another key, wrong version, or edited after signing.

import { verifyAdminPassText } from '../../server/adminPassVerify.mjs'
import { REVOKED_PASS_IDS, TRUSTED_ADMIN_PUBLIC_KEYS } from '@/account/adminKeys'

export interface AdminClaim {
  /** Lower-cased email the pass was issued to. */
  email: string
  /** Display name for the console header. */
  name: string
  /** Unique pass id, so a single pass can be revoked. */
  passId: string
  issuedAt: number
  /** Optional expiry (ms since epoch). Absent = no expiry. */
  expiresAt?: number
}

export function verifyAdminPass(pass: string | undefined | null): AdminClaim | null {
  try {
    return verifyAdminPassText(pass, {
      trustedPublicKeys: TRUSTED_ADMIN_PUBLIC_KEYS,
      revokedPassIds: REVOKED_PASS_IDS,
    })
  } catch {
    return null
  }
}
