import { normalizeUnlockInput } from '@/account/instructorAccess'

// The relay is the sole security authority. Browser-local hashes and build-time
// digests are intentionally never consulted.

export interface InstructorAccessRemoteStatus {
  configured: boolean
  authenticated: boolean
}

export type InstructorUnlockResult =
  | { ok: true }
  | { ok: false; error: string }

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

export async function fetchInstructorAccessStatus(): Promise<InstructorAccessRemoteStatus | null> {
  try {
    const res = await fetch('/api/instructor-access/status', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
    })
    if (!res.ok) return null
    const body = await readJson(res) as {
      configured?: unknown
      authenticated?: unknown
    } | null
    if (!body || typeof body.configured !== 'boolean' || typeof body.authenticated !== 'boolean') {
      return null
    }
    return { configured: body.configured, authenticated: body.authenticated }
  } catch {
    return null
  }
}

/** Authenticate and receive an eight-hour HttpOnly relay session cookie. */
export async function verifyInstructorAccessCodeRemote(code: string): Promise<boolean | null> {
  try {
    const res = await fetch('/api/instructor-access/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: normalizeUnlockInput(code) }),
    })
    if (res.status === 401 || res.status === 429) return false
    if (!res.ok) return null
    const body = await readJson(res) as { ok?: unknown } | null
    return body?.ok === true
  } catch {
    return null
  }
}

/** Loopback-only first provision. The caller must obtain the process admin token. */
export async function provisionInstructorAccessRemote(
  code: string,
  adminToken?: string,
): Promise<'ok' | 'conflict' | 'unauthorized' | 'unreachable' | 'error'> {
  if (!adminToken) return 'unauthorized'
  try {
    const res = await fetch('/api/instructor-access/provision', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-classroom-admin-token': adminToken,
      },
      body: JSON.stringify({ code: normalizeUnlockInput(code) }),
    })
    if (res.status === 409) return 'conflict'
    if (res.status === 401 || res.status === 403) return 'unauthorized'
    if (res.status === 404 || res.status === 405) return 'unreachable'
    return res.ok ? 'ok' : 'error'
  } catch {
    return 'unreachable'
  }
}

export async function logoutInstructorAccessRemote(): Promise<boolean> {
  try {
    const res = await fetch('/api/instructor-access/logout', {
      method: 'POST',
      credentials: 'same-origin',
    })
    return res.ok
  } catch {
    return false
  }
}

export async function rotateInstructorAccessRemote(
  code: string,
  adminToken: string,
): Promise<boolean> {
  try {
    const res = await fetch('/api/instructor-access/rotate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-classroom-admin-token': adminToken,
      },
      body: JSON.stringify({ code: normalizeUnlockInput(code) }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function resetInstructorAccessRemote(adminToken?: string): Promise<boolean> {
  if (!adminToken) return false
  try {
    const res = await fetch('/api/instructor-access/reset', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-classroom-admin-token': adminToken },
    })
    return res.ok
  } catch {
    return false
  }
}

export async function unlockWithInstructorAccessCode(code: string): Promise<InstructorUnlockResult> {
  const normalized = normalizeUnlockInput(code)
  if (normalized.length < 12 || normalized.length > 128) {
    return { ok: false, error: 'Access code must be 12–128 characters' }
  }

  const remoteStatus = await fetchInstructorAccessStatus()
  if (remoteStatus?.authenticated) return { ok: true }
  if (remoteStatus?.configured) {
    const remoteOk = await verifyInstructorAccessCodeRemote(normalized)
    if (remoteOk === true) return { ok: true }
    if (remoteOk === false) return { ok: false, error: 'Invalid instructor access code' }
    return {
      ok: false,
      error: 'Could not reach the classroom relay to verify the access code.',
    }
  }

  if (remoteStatus && !remoteStatus.configured) {
    return {
      ok: false,
      error: 'This classroom relay must be provisioned by the local administrator before instructors can sign in.',
    }
  }

  return {
    ok: false,
    error: 'Classroom relay unavailable. Start the local classroom host and try again.',
  }
}
