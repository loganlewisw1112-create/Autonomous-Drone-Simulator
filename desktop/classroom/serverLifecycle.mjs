/**
 * Classroom relay lifecycle helpers for the Windows desktop shell.
 * Pure enough to unit-test without Electron: spawn, probe, wait, stop.
 *
 * The browser/Vercel classroom build must NEVER import this module — browsers
 * cannot spawn Node. Web builds use src/classroom/serverProbe.ts instead.
 */

import { spawn } from 'node:child_process'

export const DEFAULT_CLASSROOM_PORT = 8080
export const HEALTH_PATH = '/api/health'

/** @param {string | number} [port] */
export function classroomBaseUrl(port = DEFAULT_CLASSROOM_PORT) {
  return `http://127.0.0.1:${port}`
}

/**
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {{ electronAsNode?: boolean }} [opts]
 */
export function buildServerEnv(baseEnv = process.env, { electronAsNode = false } = {}) {
  const env = { ...baseEnv }
  if (electronAsNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

/**
 * @param {{
 *   command: string
 *   scriptPath: string
 *   args?: string[]
 *   cwd: string
 *   env?: NodeJS.ProcessEnv
 *   spawnFn?: typeof spawn
 * }} opts
 */
export function spawnClassroomServer({
  command,
  scriptPath,
  args = [],
  cwd,
  env = process.env,
  spawnFn = spawn,
}) {
  return spawnFn(command, [scriptPath, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * @param {string} baseUrl
 * @param {{
 *   fetchFn?: typeof fetch
 *   timeoutMs?: number
 * }} [opts]
 * @returns {Promise<{ ok: true, baseUrl: string } | { ok: false, reason: string }>}
 */
export async function probeClassroomServer(baseUrl, { fetchFn = fetch, timeoutMs = 2000 } = {}) {
  const root = String(baseUrl || '').replace(/\/$/, '')
  if (!root) return { ok: false, reason: 'missing-url' }

  const url = `${root}${HEALTH_PATH}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, { method: 'GET', cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }
    const body = await res.json().catch(() => null)
    if (body && body.ok === true && body.service === 'classroom-relay') {
      return { ok: true, baseUrl: root }
    }
    return { ok: false, reason: 'unexpected-body' }
  } catch {
    return { ok: false, reason: 'unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * @param {string} baseUrl
 * @param {{
 *   timeoutMs?: number
 *   intervalMs?: number
 *   probe?: typeof probeClassroomServer
 *   sleep?: (ms: number) => Promise<void>
 * }} [opts]
 */
export async function waitForClassroomServer(baseUrl, {
  timeoutMs = 30_000,
  intervalMs = 200,
  probe = probeClassroomServer,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = Date.now()
  let last = /** @type {{ ok: false, reason: string }} */ ({ ok: false, reason: 'pending' })
  while (Date.now() - started < timeoutMs) {
    const result = await probe(baseUrl)
    if (result.ok) return result
    last = result
    await sleep(intervalMs)
  }
  return { ok: false, reason: last.reason === 'pending' ? 'timeout' : `timeout:${last.reason}` }
}

/**
 * Stop a child we own. On Windows, tree-kill so orphaned node children do not linger.
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @param {{
 *   platform?: NodeJS.Platform
 *   killTreeFn?: (pid: number) => void
 *   killFn?: (child: import('node:child_process').ChildProcess, signal?: NodeJS.Signals) => void
 * }} [opts]
 */
export function stopClassroomServer(child, {
  platform = process.platform,
  killTreeFn,
  killFn,
} = {}) {
  if (!child || child.killed || child.exitCode != null) {
    return { stopped: true, alreadyDead: true }
  }
  const pid = child.pid
  try {
    if (typeof pid === 'number' && platform === 'win32') {
      if (killTreeFn) killTreeFn(pid)
      else {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
    } else if (killFn) {
      killFn(child, 'SIGTERM')
    } else {
      child.kill('SIGTERM')
    }
    return { stopped: true, alreadyDead: false }
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    return { stopped: false, alreadyDead: false }
  }
}
