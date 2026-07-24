import {
  clearDeviceInstructorAccessHash,
  configuredInstructorAccessHash,
  hashInstructorAccessCode,
  normalizeUnlockInput,
  provisionInstructorAccessCode,
  verifyInstructorAccessCode,
  writeDeviceInstructorAccessHash,
} from '@/account/instructorAccess'

/**
 * LAN classroom relay helpers for Option A unlock.
 * Hosted/Vercel builds usually rely on build-time env hash and never hit these.
 * Relative URLs keep the same origin as `npm run classroom` (relay serves the app).
 */

export type InstructorAccessRemoteStatus = { configured: boolean }

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** GET /api/instructor-access — whether the relay already has a school digest on disk. */
export async function fetchInstructorAccessStatus(): Promise<InstructorAccessRemoteStatus | null> {
  try {
    const res = await fetch('/api/instructor-access', { method: 'GET', cache: 'no-store' })
    if (!res.ok) return null
    const body = await readJson(res) as { configured?: unknown } | null
    if (!body || typeof body.configured !== 'boolean') return null
    return { configured: body.configured }
  } catch {
    return null
  }
}

/** POST /api/instructor-access/verify — timing-safe check against disk hash. */
export async function verifyInstructorAccessCodeRemote(code: string): Promise<boolean | null> {
  try {
    const res = await fetch('/api/instructor-access/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: normalizeUnlockInput(code) }),
    })
    if (!res.ok) return null
    const body = await readJson(res) as { ok?: unknown } | null
    return body?.ok === true
  } catch {
    return null
  }
}

/**
 * POST /api/instructor-access/provision — first writer wins on the instructor machine.
 * Optional plaintext is stored only in gitignored local-secrets for local admin recovery.
 */
export async function provisionInstructorAccessRemote(
  hash: string,
  plaintextCode?: string,
): Promise<'ok' | 'conflict' | 'unreachable' | 'error'> {
  try {
    const res = await fetch('/api/instructor-access/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        hash,
        ...(plaintextCode ? { code: normalizeUnlockInput(plaintextCode) } : {}),
      }),
    })
    if (res.status === 409) return 'conflict'
    if (res.status === 404 || res.status === 405) return 'unreachable'
    if (!res.ok) return 'error'
    return 'ok'
  } catch {
    return 'unreachable'
  }
}

/** DELETE /api/instructor-access — intentional admin reset of disk secrets. */
export async function resetInstructorAccessRemote(): Promise<boolean> {
  try {
    const res = await fetch('/api/instructor-access', { method: 'DELETE' })
    return res.ok
  } catch {
    return false
  }
}

export type InstructorUnlockResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Full unlock path for instructor setup:
 * - If a digest already exists (build env or this device): typed code must match.
 * - If not: first typed code becomes the school secret (device + best-effort LAN file).
 * - If LAN already has a digest but this browser does not: verify via relay, then cache locally.
 */
export async function unlockWithInstructorAccessCode(code: string): Promise<InstructorUnlockResult> {
  const trimmed = normalizeUnlockInput(code)
  if (!trimmed) {
    return { ok: false, error: 'Enter an access code' }
  }

  const localExpected = configuredInstructorAccessHash()
  if (localExpected) {
    if (verifyInstructorAccessCode(trimmed)) return { ok: true }
    return { ok: false, error: 'Invalid instructor access code' }
  }

  const remoteStatus = await fetchInstructorAccessStatus()
  if (remoteStatus?.configured) {
    const remoteOk = await verifyInstructorAccessCodeRemote(trimmed)
    if (remoteOk === true) {
      writeDeviceInstructorAccessHash(hashInstructorAccessCode(trimmed))
      return { ok: true }
    }
    if (remoteOk === false) {
      return { ok: false, error: 'Invalid instructor access code' }
    }
    return {
      ok: false,
      error: 'Could not reach the classroom relay to verify the access code. Is npm run classroom running?',
    }
  }

  // Fresh setup: first typed code wins on this device.
  const provisioned = provisionInstructorAccessCode(trimmed)
  if (!provisioned.ok) {
    if (provisioned.reason === 'already-configured') {
      if (verifyInstructorAccessCode(trimmed)) return { ok: true }
      return { ok: false, error: 'Invalid instructor access code' }
    }
    if (provisioned.reason === 'storage-unavailable') {
      return { ok: false, error: 'Device storage unavailable — cannot save the school unlock code' }
    }
    return { ok: false, error: 'Enter an access code' }
  }

  const remote = await provisionInstructorAccessRemote(provisioned.hash, trimmed)
  if (remote === 'conflict') {
    // Another operator provisioned the LAN secret first — do not keep a divergent local hash.
    clearDeviceInstructorAccessHash()
    const remoteOk = await verifyInstructorAccessCodeRemote(trimmed)
    if (remoteOk === true) {
      writeDeviceInstructorAccessHash(provisioned.hash)
      return { ok: true }
    }
    return {
      ok: false,
      error: 'A school unlock code is already set on this classroom server. Enter that existing code.',
    }
  }

  return { ok: true }
}
