// Trusted ADMIN pass public keys and the revocation list. The data lives in
// server/adminKeys.mjs so the classroom relay (plain Node ESM) reads the very
// same values as the browser; this module is the browser-side entry point.
export { TRUSTED_ADMIN_PUBLIC_KEYS, REVOKED_PASS_IDS } from '../../server/adminKeys.mjs'
