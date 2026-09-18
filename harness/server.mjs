// Builds the app with the harness surface compiled in and serves it on the fixed harness port.
// Usage: node harness/server.mjs [--no-build]   (also imported by the gates)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { OUT_DIR, PORT, ROOT } from './config.mjs'

const VITE = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const ENV = { ...process.env, VITE_APP_TARGET: 'windows', VITE_BUILD_TARGET: 'windows', VITE_HARNESS: '1' }

/** `harness: false` builds exactly what ships (no VITE_HARNESS) — the reference for bundle-weight gates. */
export function buildApp({ outDir = OUT_DIR, harness = true } = {}) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [VITE, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: ROOT, env: { ...ENV, VITE_HARNESS: harness ? '1' : '' }, encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`harness build failed:\n${run.stdout}\n${run.stderr}`)
  return { seconds: (Date.now() - started) / 1000 }
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`harness server did not answer on ${PORT} within ${timeoutMs} ms`)
}

/** @returns {Promise<{ stop(): void, built: { seconds: number } | null }>} */
export async function startServer({ build = true } = {}) {
  const built = build || !existsSync(OUT_DIR) ? buildApp() : null
  const child = spawn(
    process.execPath,
    [VITE, 'preview', '--outDir', OUT_DIR, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  try {
    await waitForPort(20_000)
  } catch (err) {
    child.kill()
    throw new Error(`${err.message}\n${log}`)
  }
  return { stop: () => child.kill(), built }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(ROOT, 'harness', 'server.mjs')) {
  const server = await startServer({ build: !process.argv.includes('--no-build') })
  console.log(`harness server on http://127.0.0.1:${PORT}/?harness=1 (ctrl+c to stop)`)
  process.on('SIGINT', () => { server.stop(); process.exit(0) })
}
