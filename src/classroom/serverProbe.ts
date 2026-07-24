/**
 * Browser-side classroom relay probe.
 * Honest only: never claims a server is running without a successful /api/health.
 * Used by the web Yes/No prompt (Vercel / GitHub Pages cannot spawn Node).
 */

export const CLASSROOM_HEALTH_PATH = '/api/health'
export const DEFAULT_PROBE_CANDIDATES = [
  'http://127.0.0.1:8080',
  'http://localhost:8080',
] as const

export const CLASSROOM_SERVER_PROMPT_SESSION_KEY = 'classroom-server-prompt-resolved'

export type ClassroomProbeOk = { ok: true; baseUrl: string }
export type ClassroomProbeFail = { ok: false; reason: string; tried: string[] }
export type ClassroomProbeResult = ClassroomProbeOk | ClassroomProbeFail

function normalizeBase(url: string): string {
  return url.replace(/\/$/, '')
}

/** Probe a single origin for the classroom relay health document. */
export async function probeClassroomRelayAt(
  baseUrl: string,
  opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<ClassroomProbeResult> {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? 2500
  const root = normalizeBase(baseUrl)
  if (!root) return { ok: false, reason: 'missing-url', tried: [] }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(`${root}${CLASSROOM_HEALTH_PATH}`, {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
    })
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, tried: [root] }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; service?: string } | null
    if (body?.ok === true && body.service === 'classroom-relay') {
      return { ok: true, baseUrl: root }
    }
    return { ok: false, reason: 'unexpected-body', tried: [root] }
  } catch {
    return { ok: false, reason: 'unreachable', tried: [root] }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe candidates in order. Prefer the page origin when it looks like a LAN
 * relay (http, non-vercel), then localhost defaults.
 */
export function buildProbeCandidateList(opts: {
  locationOrigin?: string
  configuredBase?: string | null
  defaults?: readonly string[]
} = {}): string[] {
  const defaults = opts.defaults ?? DEFAULT_PROBE_CANDIDATES
  const out: string[] = []
  const push = (value: string | null | undefined) => {
    if (!value) return
    const n = normalizeBase(value)
    if (!n || out.includes(n)) return
    out.push(n)
  }

  push(opts.configuredBase ?? null)

  const origin = opts.locationOrigin
  if (origin && /^https?:\/\//i.test(origin)) {
    const host = origin.toLowerCase()
    // Hosted demos cannot spawn Node — still probe origin (honest miss) then localhost.
    const isHostedShowcase = /vercel\.app|github\.io|pages\.dev/i.test(host)
    if (!isHostedShowcase) push(origin)
  }

  for (const d of defaults) push(d)

  if (origin && /^https?:\/\//i.test(origin)) {
    const host = origin.toLowerCase()
    if (/vercel\.app|github\.io|pages\.dev/i.test(host)) push(origin)
  }

  return out
}

export async function probeClassroomRelay(opts: {
  locationOrigin?: string
  configuredBase?: string | null
  fetchFn?: typeof fetch
  timeoutMs?: number
} = {}): Promise<ClassroomProbeResult> {
  const candidates = buildProbeCandidateList({
    locationOrigin: opts.locationOrigin,
    configuredBase: opts.configuredBase,
  })
  const tried: string[] = []
  for (const base of candidates) {
    const result = await probeClassroomRelayAt(base, {
      fetchFn: opts.fetchFn,
      timeoutMs: opts.timeoutMs,
    })
    if (result.ok) return result
    tried.push(...result.tried)
  }
  return { ok: false, reason: 'unreachable', tried }
}

export function isClassroomServerPromptResolved(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof sessionStorage !== 'undefined'
    ? sessionStorage
    : null,
): boolean {
  try {
    return storage?.getItem(CLASSROOM_SERVER_PROMPT_SESSION_KEY) === '1'
  } catch {
    return false
  }
}

export function markClassroomServerPromptResolved(
  storage: Pick<Storage, 'setItem'> | null | undefined = typeof sessionStorage !== 'undefined'
    ? sessionStorage
    : null,
): void {
  try {
    storage?.setItem(CLASSROOM_SERVER_PROMPT_SESSION_KEY, '1')
  } catch {
    /* private mode — prompt may reappear; acceptable */
  }
}

export function classroomSetupInstructions(): string {
  return [
    'Live multi-student classes need the Classroom Server on one Windows instructor PC.',
    '',
    'Preferred: launch the desktop classroom app and choose Yes',
    '  npm run classroom:desktop',
    '',
    'Or from a terminal in this repo:',
    '  npm run classroom',
    '',
    'Browser / GitHub / Vercel demos cannot start that server. Choose Yes here only to probe this PC (localhost) or the page host — an honest miss means the relay is not up.',
    '',
    'Simulation only — no real aircraft.',
  ].join('\n')
}
