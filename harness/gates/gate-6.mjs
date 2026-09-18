// GATE 6 — final: quality tiers, the degradation ladder, the 72-cell matrix, and everything before it.
// Long: ~40 min. Flags: --no-build, --skip-prior (6.6), --skip-suite (6.4), --skip-matrix (reuse artifacts/review/matrix.json)
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ARTIFACTS, FREEZE_AT_SEC, ROOT, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, noiseFloorDiff } from '../assert.mjs'
import { REVIEW_DIR, runMatrix } from '../matrix.mjs'
import { openProbe } from '../probe.mjs'
import { buildApp, startServer } from '../server.mjs'

const gate = createGate('6')
const report = {}
const has = (flag) => process.argv.includes(flag)
const FRAME_BUDGET_MS = 16.7
const BASELINE_TESTS = { files: '171 passed | 1 skipped (172)', tests: '1272 passed | 3 skipped (1275)' } // P-0.2, red set empty
let p75 = 'n/a'
let journeyResidue = NaN
let journeyView = null

let server
try {
  server = await startServer({ build: !has('--no-build') })

  // ── 6.1 frame budget across the 72 cells · 6.7 review bundle ───────────────────────────────
  const cells = has('--skip-matrix')
    ? (existsSync(resolve(REVIEW_DIR, 'matrix.json')) ? JSON.parse(readFileSync(resolve(REVIEW_DIR, 'matrix.json'), 'utf8')) : [])
    : await runMatrix({ tier: 'balanced' })
  if (cells.length === 0) throw new Error('no matrix cells (run without --skip-matrix first)')
  const over = cells.filter((c) => !(c.frameMsP75 <= FRAME_BUDGET_MS))
  const baselineOver = over.filter((c) => !(c.baselineFrameMsP75 <= FRAME_BUDGET_MS))
  const worst = cells.reduce((a, b) => (b.frameMsP75 > a.frameMsP75 ? b : a))
  const sorted = (key) => cells.map((c) => c[key]).sort((a, b) => a - b)
  const median = (key) => sorted(key)[Math.floor(cells.length / 2)]
  p75 = Math.max(...cells.map((c) => c.layerMsP75))
  gate.check('6.1', `frame budget AS WRITTEN: p75 whole-frame time ≤ ${FRAME_BUDGET_MS} ms in all 72 cells at "balanced"`, cells.length === 72 && over.length === 0,
    `${cells.length - over.length}/${cells.length} cells within budget; worst ${worst.name} = ${worst.frameMsP75} ms. Of the ${over.length} cells over budget, ${baselineOver.length} are ALSO over budget with the 3D layer removed (the map alone). Medians: frame ${median('frameMsP75')} ms, map alone ${median('baselineFrameMsP75')} ms, added ${median('addedMs')} ms`)
  gate.check('6.1b', '(diagnostic) what the LAYER costs: its own render() p75 ≤ 8 ms in every cell, and the median frame time it adds over the map alone ≤ 4 ms',
    cells.every((c) => c.layerMsP75 <= 8) && median('addedMs') <= 4, `worst layer render ${p75} ms; added frame time median ${median('addedMs')} ms, p90 ${sorted('addedMs')[Math.floor(cells.length * 0.9)]} ms`)
  const pngs = existsSync(resolve(REVIEW_DIR, 'cells')) ? readdirSync(resolve(REVIEW_DIR, 'cells')).filter((f) => f.endsWith('.png')) : []
  gate.check('6.7', 'review bundle: artifacts/review/ holds all 72 screenshots plus a contact-sheet index.html', pngs.length === 72 && existsSync(resolve(REVIEW_DIR, 'index.html'))
    && cells.every((c) => c.pngBytes > 5_000), `${pngs.length} screenshots, index.html ${existsSync(resolve(REVIEW_DIR, 'index.html')) ? 'present' : 'MISSING'}`)
  report.matrix = { over: over.map((c) => c.name), baselineOver: baselineOver.map((c) => c.name), medianFrame: median('frameMsP75'), medianBaseline: median('baselineFrameMsP75'), medianAdded: median('addedMs') }

  // ── 6.2 degradation · 6.3 kill switch ───────────────────────────────────────────────────────
  const probe = await openProbe()
  try {
    const H = (fn, arg) => probe.eval(fn, arg)
    const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(`g6/${name}.png`)) }
    await probe.ready()
    const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
    if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
    await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
    await probe.ready()
    const uav = (await H(() => window.__harness.sim.fleet()))[0]
    const tactical = { center: [uav.lng, uav.lat], zoom: 16, pitch: 45, bearing: 20 }
    await H((v) => { window.__harness.dom.glOnly(true); window.__harness.camera.set(v) }, tactical)
    const pristine = await settleShot('63-pristine')

    await H(() => window.__harness.scene.enable())
    await probe.ready()
    const ground = await H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), [uav.lng, uav.lat])
    const five = Array.from({ length: 5 }, (_, i) => ({ id: `syn-${i}`, airframe: i % 2 ? 'x10' : 'teal2', lng: uav.lng + (i * 40) / 85_000, lat: uav.lat + (i * 25) / 111_320, elevationM: ground + 50 + i * 10,
      headingDeg: i * 60, speedMs: 4, propRpm: 5400, gimbalYawDeg: 0, gimbalPitchDeg: -30, color: '#00e5ff' }))
    await H((list) => window.__harness.fleet.synthetic(list), five)
    // Pump frames until the ladder's rung satisfies `cmp target` (no eval in the page: the app ships a CSP).
    const pumpUntil = (cmp, target, maxFrames) => H(async ([c, t, max]) => {
      const h = window.__harness
      const done = (rung) => (c === 'gte' ? rung >= t : c === 'lte' ? rung <= t : rung !== t)
      let frames = 0
      while (frames < max && !done(h.quality.state().rung)) { h.map.triggerRepaint(); await new Promise((r) => requestAnimationFrame(r)); frames++ }
      return { frames, state: h.quality.state(), smoke: h.atmosphere.stats().smokeParticles }
    }, [cmp, target, maxFrames])

    // A slow GPU, rehearsed: every feature has a price, so giving features up buys the time back.
    // 30 ms at full quality; the ladder must stop as soon as the layer is back under its 8 ms budget.
    const COST_BY_RUNG = [30, 24, 18, 12, 6, 3, 0]
    await H(() => window.__harness.quality.tier('balanced'))
    const start = await H(() => window.__harness.quality.state())
    await H((c) => window.__harness.quality.syntheticCost(c), COST_BY_RUNG)
    const fell = await pumpUntil('gte', 4, 1500)
    const held = await pumpUntil('ne', 4, 240) // must STAY there: 6 ms is inside the budget
    const recoveredCost = COST_BY_RUNG[held.state.rung]
    await H(() => window.__harness.quality.syntheticCost(null))
    const climbed = await pumpUntil('lte', 1, 2400)
    gate.check('6.2', 'degradation works: constrained to 30 ms the quality drops through the ladder IN ORDER, recovers (≤ 16.7 ms, layer cost back under budget) without disabling the 3D layer at 5 aircraft — and climbs back when the constraint lifts',
      start.rung === 1 && held.state.rung === 4 && held.state.applied.layerOn && recoveredCost <= FRAME_BUDGET_MS
        && JSON.stringify(fell.state.history.slice(-3).map((e) => e.rung)) === '[2,3,4]' && climbed.state.rung === 1,
      `balanced (rung ${start.rung}) → ${fell.state.history.map((e) => e.rung).join(' → ')} in ${fell.frames} frames, held at "${held.state.rungName}" (synthetic cost ${recoveredCost} ms, layer still on); constraint lifted → back to rung ${climbed.state.rung} after ${climbed.frames} frames`)

    // Every rung must do what the table says — read back from the live objects.
    const rungEffects = []
    await H(() => { const h = window.__harness; h.fleet.synthetic(null); h.quality.tier('cinematic'); h.quality.syntheticCost([30, 30, 30, 30, 30, 30, 30]) })
    for (let rung = 0; rung <= 6; rung++) {
      const r = await pumpUntil('gte', rung, 600)
      rungEffects.push({ rung: r.state.rung, name: r.state.rungName, ...r.state.applied, smokeParticles: r.smoke })
    }
    await H(() => window.__harness.quality.syntheticCost(null))
    const markers = await H(() => [...document.querySelectorAll('.drone-marker')].map((m) => getComputedStyle(m).opacity))
    const e = rungEffects
    gate.check('6.2b', 'each rung does what the ladder says (smoke → shadow resolution → shadows off → LOD tightened → layer off, DOM markers restored)',
      e[0].smokeAmount === 1 && e[1].smokeAmount === 0.5 && e[2].smokeAmount === 0 && e[2].shadowMapSize === 2048 && e[3].shadowMapSize === 1024 && e[3].shadows
        && !e[4].shadows && e[4].lodFullMaxM === 300 && e[5].lodFullMaxM === 150 && e[5].lodLowMaxM === 800 && e[5].layerOn && !e[6].layerOn && markers.length > 0 && markers.every((o) => o === '1'),
      e.map((x) => `${x.rung}:${x.name}[smoke ${x.smokeAmount}, shadow ${x.shadows ? x.shadowMapSize : 'off'}, LOD ${x.lodFullMaxM}/${x.lodLowMaxM}, layer ${x.layerOn ? 'on' : 'OFF'}]`).join(' ') + `; DOM markers opacity ${markers[0]}`)
    report['6.2'] = { fell: fell.state.history, rungEffects }

    // 6.3 — the kill switch, in two parts.
    // (a) Everything has been on in this page (fleet, volumes, atmosphere, the whole ladder down to layer-off) and
    //     the camera never moved: the frame after disable() must be the never-mounted frame, exactly.
    await H(() => { const h = window.__harness; h.quality.tier('cinematic'); h.scene.enable() })
    await H(() => window.__harness.render.pump(30))
    await H(() => window.__harness.scene.disable())
    const restored = noiseFloorDiff(pristine, await settleShot('63a-after-kill-switch'))
    // (b) Then a look-up camera journey (GROUND), disable(), and back. MapLibre's label placement depends on camera
    //     HISTORY, so the floor for this comparison is the same journey flown with the layer never mounted (session below).
    await H(() => { const h = window.__harness; h.scene.enable(); h.fleet.synthetic(null); h.camera.follow(null); h.camera.mode('GROUND'); for (let i = 0; i < 60; i++) h.camera.advance(0.05) })
    await H(() => window.__harness.render.pump(30))
    const lookUp = await H(() => { const m = window.__harness.map, c = m.getCenter(); return { center: [c.lng, c.lat], zoom: m.getZoom(), pitch: m.getPitch(), bearing: m.getBearing(), elevation: m.getCenterElevation(), fov: m.getVerticalFieldOfView() } })
    await H(() => window.__harness.scene.disable())
    await H((v) => window.__harness.camera.set(v), tactical)
    journeyResidue = noiseFloorDiff(pristine, await settleShot('63b-after-journey-and-kill-switch'))
    journeyView = lookUp
    report['6.3'] = { restored, journeyResidue, lookUp }
    gate.check('6.3', 'kill switch intact: with the whole feature set having been on, scene.disable() restores the exact never-mounted frame (noise floor 0 %)', restored <= 0.01, `diff ${restored.toFixed(4)} % of pixels`)
    gate.check('6.X', 'no WebGL / shader console errors', probe.consoleErrors(/WebGL|GL_INVALID|shader/i).length === 0, probe.consoleErrors(/WebGL|GL_INVALID|shader/i)[0] ?? '')
  } finally {
    await probe.close()
  }

  // 6.3b control — the SAME camera journey in a fresh page where the 3D layer is never mounted.
  if (journeyView) {
    const control = await openProbe()
    try {
      const C = (fn, arg) => control.eval(fn, arg)
      await control.ready()
      await C((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
      await C((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
      await control.ready()
      const uav = (await C(() => window.__harness.sim.fleet()))[0]
      const tactical = { center: [uav.lng, uav.lat], zoom: 16, pitch: 45, bearing: 20 }
      await C((v) => { window.__harness.dom.glOnly(true); window.__harness.camera.set(v) }, tactical)
      await control.ready()
      const before = decodePng(await control.shot('g6/63b-control-pristine.png'))
      await C((v) => { const h = window.__harness; h.map.setVerticalFieldOfView(v.fov); h.camera.set({ ...v, unlock: true }) }, journeyView)
      await C(() => window.__harness.render.pump(30))
      await C((v) => { const h = window.__harness; h.camera.relock(); h.camera.set(v) }, tactical)
      await control.ready()
      const floor = noiseFloorDiff(before, decodePng(await control.shot('g6/63b-control-after-journey.png')))
      report['6.3'].controlFloor = floor
      gate.check('6.3b', 'kill switch after a look-up camera journey: no more residue than the same journey leaves with the layer never mounted (the measured floor for a journeyed frame)',
        journeyResidue <= floor + 0.02, `with the layer: ${journeyResidue.toFixed(4)} % · control, layer never mounted: ${floor.toFixed(4)} %`)
    } finally {
      await control.close()
    }
  }
} catch (err) {
  gate.check('6.Z', 'browser stages ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  server?.stop()
}

// ── 6.5 bundle: what ships, measured in the build that ships ──────────────────────────────────
try {
  const shipped = resolve(ARTIFACTS, 'public-dist')
  buildApp({ outDir: shipped, harness: false })
  const assets = readdirSync(resolve(shipped, 'assets')).filter((f) => /\.(js|mjs)$/.test(f)).map((f) => ({ f, body: readFileSync(resolve(shipped, 'assets', f)) }))
  // The layer is reachable only through a dynamic import, so it lives in its own chunks: the ones that carry three.js or scene3d marks.
  const mine = assets.filter(({ body }) => /THREE\.|scene3d-owns-drones/.test(body.toString('latin1')))
  const gz = mine.reduce((n, a) => n + gzipSync(a.body).length, 0) / 1024
  const raw = mine.reduce((n, a) => n + a.body.length, 0) / (1024 * 1024)
  const entry = assets.filter(({ f }) => /^index-/.test(f))
  const entryLeak = entry.some(({ body }) => /WebGLRenderer|__harness/.test(body.toString('latin1')))
  gate.check('6.5', 'bundle: added gzipped JS ≤ 400 KB, total added transfer ≤ 6 MB — and none of it in the entry chunk', mine.length > 0 && gz <= 400 && raw <= 6 && !entryLeak,
    `${mine.length} lazy chunk(s): ${gz.toFixed(1)} KB gz / ${raw.toFixed(2)} MB raw (${mine.map((a) => a.f).join(', ')}); entry chunk carries three.js/harness: ${entryLeak}`)
  report.bundle = { chunks: mine.map((a) => a.f), gzKb: gz, rawMb: raw }
} catch (err) {
  gate.check('6.5', 'bundle measured', false, err.message.split('\n')[0])
}

// ── 6.4 no baseline regression ────────────────────────────────────────────────────────────────
if (has('--skip-suite')) gate.skip('6.4', 'no baseline regression', '--skip-suite')
else {
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 })
  const typecheck = run('npm', ['run', 'typecheck'])
  const lint = run('npm', ['run', 'lint'])
  const tests = run('npx', ['vitest', 'run', '--pool=forks', '--no-file-parallelism'])
  const line = (label) => (tests.stdout.match(new RegExp(`${label}\\s+(.+)`))?.[1] ?? '').trim()
  gate.check('6.4', 'no baseline regression: typecheck / lint / test red set IDENTICAL to P-0.2 (empty) — same totals, nothing deleted, nothing added',
    typecheck.status === 0 && lint.status === 0 && tests.status === 0 && line('Test Files') === BASELINE_TESTS.files && line('Tests') === BASELINE_TESTS.tests,
    `typecheck ${typecheck.status}, lint ${lint.status}, tests ${tests.status}; Test Files ${line('Test Files')}; Tests ${line('Tests')}`)
}

// ── 6.6 every prior gate still passes ─────────────────────────────────────────────────────────
if (has('--skip-prior')) gate.skip('6.6', 'all prior gates still pass', '--skip-prior')
else {
  const prior = ['p0', '0', '1', '2', '3', '4', '5'].map((g) => {
    try { return { g, out: execFileSync(process.execPath, [resolve(ROOT, 'harness', 'gates', 'run.mjs'), g, '--no-build'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) } } catch (err) { return { g, out: String(err.stdout ?? err.message), failed: true } }
  }).map(({ g, out, failed }) => ({ g, failed: Boolean(failed), summary: out.split('\n').find((l) => l.startsWith('GATE ')) ?? 'no summary line' }))
  gate.check('6.6', 'all prior gates still pass: P0, 0, 1, 2, 3, 4, 5 re-run end to end', prior.every((p) => !p.failed && / PASS /.test(p.summary)), prior.map((p) => p.summary.replace(/ artifacts=.*/, '')).join(' | '))
  report.prior = prior
}

try { writeFileSync(resolve(ARTIFACTS, 'g6-probe.json'), JSON.stringify(report, null, 2)) } catch { /* best effort */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/review/' }))
