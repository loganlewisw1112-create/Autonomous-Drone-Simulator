// PREFLIGHT GATE (plan P-0.6). Exit 0 only when the harness itself is trustworthy: the app builds,
// boots cold with no interstitial, settles, and a frozen sim clock renders byte-identically across
// two separate browser launches. Nothing downstream means anything without that last one.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, ROOT, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, noiseFloorDiff, sha256 } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('P0')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const read = (...p) => readFileSync(resolve(ROOT, ...p), 'utf8')

// Paths this phase is allowed to have touched. Anything else dirty is a finding.
const PHASE_PATHS = [/^harness\//, /^src\/scene3d\//, /^src\/App\.tsx$/, /^src\/components\/(TacticalMap|WelcomeOverlay)\.tsx$/,
  /^vite\.config\.ts$/, /^package(-lock)?\.json$/, /^\.gitignore$/, /^PROGRESS\.md$/,
  /^(AUTONOMOUS-PLAN-3d-view|SPEC-3d-view)\.md$/, /^cameraDirector\.js$/]

// ── 1. Repo / branch / tree ─────────────────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))
gate.check('P0.1a', 'repo is the Drone Ops Center simulator',
  Boolean(pkg.dependencies['maplibre-gl']) && /<title>[^<]*Drone Ops Center/.test(read('index.html')))
const branch = git('branch', '--show-current')
gate.check('P0.1b', 'on branch feat/3d-scene-layer', branch === 'feat/3d-scene-layer', branch)
// Raw, untrimmed porcelain: columns 0-1 are the status, and trim() would eat a leading space.
const stray = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
  .map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => !PHASE_PATHS.some((re) => re.test(p)))
gate.check('P0.1c', 'no changes outside this phase\'s declared paths', stray.length === 0, stray.join(', '))

// ── 2. Baseline recorded ────────────────────────────────────────────────────────────────────────
gate.check('P0.2', 'PROGRESS.md records the baseline red set',
  existsSync(resolve(ROOT, 'PROGRESS.md')) && /## Baseline/.test(read('PROGRESS.md')))

// ── 3. Facts the plan rests on (SPEC §0), re-verified against source ────────────────────────────
const lock = JSON.parse(read('package-lock.json'))
const maplibre = lock.packages['node_modules/maplibre-gl'].version
gate.check('P0.3a', 'maplibre-gl resolves to 6.x', /^6\./.test(maplibre), maplibre)
const terrainSrc = read('src', 'components', 'scenarioTerrainLayers.impl.ts')
gate.check('P0.3b', 'terrain is a Terrarium raster-dem', /encoding: 'terrarium'/.test(terrainSrc) && /type: 'raster-dem'/.test(terrainSrc))
gate.check('P0.3c', 'terrain exaggeration is exactly 1.15', /setTerrain\(\{[^}]*exaggeration: 1\.15/.test(terrainSrc))
const tacticalMap = read('src', 'components', 'TacticalMap.tsx')
gate.check('P0.3d', 'drones are DOM Markers', /new maplibregl\.Marker\(/.test(tacticalMap))
gate.check('P0.3e', 'no custom layer in the 2D map yet', !/renderingMode|type: 'custom'/.test(tacticalMap))

// ── 4–6. Live: serve, boot cold, settle, prove determinism ──────────────────────────────────────
let server
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })
  gate.check('P0.4a', 'harness build succeeds and serves on the fixed port', true,
    server.built ? `built in ${server.built.seconds.toFixed(1)} s` : 'reused existing build')

  const launch = async (tag) => {
    const probe = await openProbe()
    try {
      const early = await probe.interstitials()
      const coldReadyMs = await probe.ready()
      const loaded = await probe.eval((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
      if (!loaded.ok) throw new Error(`sim.seed(${SCENARIO_SEED}) failed: ${loaded.reason}`)
      const tick = await probe.eval((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
      await probe.ready()
      const fleet = await probe.eval(() => window.__harness.sim.fleet())
      await probe.eval(([lng, lat]) => window.__harness.camera.set({ center: [lng, lat], zoom: 14.5, bearing: 0, pitch: 0 }),
        [fleet[0].lng, fleet[0].lat])
      const sceneReadyMs = await probe.ready()
      const late = await probe.interstitials()
      const rendered = await probe.eval(() => window.__harness.map.queryRenderedFeatures().length)
      const clock = await probe.eval(() => window.__harness.sim.clock())
      const png = await probe.shot(`p0/determinism-${tag}.png`)
      return { png, early, late, coldReadyMs, sceneReadyMs, rendered, clock, tick, seed: loaded.seed,
        fleet, scenarioId: loaded.scenarioId, channel: probe.channel, errors: probe.consoleErrors(/WebGL|GL_INVALID|shader/i) }
    } finally {
      await probe.close()
    }
  }

  const a = await launch('a')
  const b = await launch('b')

  gate.check('P0.4b', '__harness.ready() resolves in < 30 s on a cold profile',
    a.coldReadyMs < 30_000 && b.coldReadyMs < 30_000, `${a.coldReadyMs} ms / ${b.coldReadyMs} ms`)
  gate.check('P0.5', 'zero startup interstitials under ?harness=1 (cold profile, before and after load)',
    [...a.early, ...a.late, ...b.early, ...b.late].length === 0, [...a.early, ...a.late].join(' '))
  gate.check('P0.6a', `sim clock frozen at exactly T+${FREEZE_AT_SEC} in both launches`,
    a.clock.tick === FREEZE_AT_SEC * 20 && b.clock.tick === a.clock.tick, `tick ${a.clock.tick} / ${b.clock.tick}`)
  gate.check('P0.6b', 'fleet state identical across launches',
    JSON.stringify(a.fleet) === JSON.stringify(b.fleet), `${a.fleet.length} drones, ${a.scenarioId} seed ${a.seed}`)
  // Not circular: a blank basemap (the PR #96 worker failure) renders zero features.
  gate.check('P0.6c', 'basemap actually drew (rendered features > 0, image not flat)',
    a.rendered > 0 && new Set(decodePng(a.png).data.filter((_, i) => i % 4 === 0)).size > 8, `${a.rendered} features`)
  gate.check('P0.6d', 'no WebGL/shader console errors', a.errors.length + b.errors.length === 0, a.errors[0] ?? '')

  const identical = sha256(a.png) === sha256(b.png)
  const diffPct = identical ? 0 : noiseFloorDiff(a.png, b.png)
  // Plan fallback: byte-identical, or a perceptual diff under 0.1 % recorded as the noise floor.
  gate.check('P0.6e', 'frozen-clock screenshots match across two separate browser launches',
    identical || diffPct < 0.1, identical ? `byte-identical sha256 ${sha256(a.png).slice(0, 16)}` : `diff ${diffPct.toFixed(4)} % of pixels`)

  writeFileSync(resolve(ARTIFACTS, 'p0', 'probe.json'), JSON.stringify({
    scenario: a.scenarioId, seed: a.seed, freezeAtSec: FREEZE_AT_SEC, browser: a.channel, maplibre,
    byteIdentical: identical, noiseFloorPct: diffPct, coldReadyMs: [a.coldReadyMs, b.coldReadyMs],
    sceneReadyMs: [a.sceneReadyMs, b.sceneReadyMs], renderedFeatures: a.rendered, fleet: a.fleet,
  }, null, 2))
} catch (err) {
  gate.check('P0.X', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  server?.stop()
}

process.exit(gate.finish({ artifacts: 'artifacts/p0/' }))
