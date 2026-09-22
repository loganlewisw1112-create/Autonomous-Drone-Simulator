// GATE 1 — procedural airframes, 3-band LOD, instancing (plan Phase 1).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ARTIFACTS, FREEZE_AT_SEC, OUT_DIR, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, diffMask, silhouetteIoU } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { buildApp, startServer } from '../server.mjs'

const gate = createGate('1')
const report = {}
let p75 = 'n/a'
const gzJs = (dir) => readdirSync(resolve(dir, 'assets')).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  .reduce((sum, f) => sum + gzipSync(readFileSync(resolve(dir, 'assets', f))).length, 0)

let server
let probe
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })
  probe = await openProbe()
  const H = (fn, arg) => probe.eval(fn, arg)
  const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(`g1/${name}.png`)) }

  await probe.ready()
  const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
  if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
  await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
  await probe.ready()
  const uav = (await H(() => window.__harness.sim.fleet()))[0]
  await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), [uav.lng, uav.lat])
  await probe.ready()
  const ground = await H((c) => window.__harness.map.queryTerrainElevation(c), [uav.lng, uav.lat])

  // ── 1.8 (extra) the layer takes the aircraft from the DOM markers, and gives them back ──────
  const markerOpacity = () => H(() => [...document.querySelectorAll('.drone-marker')].map((m) => getComputedStyle(m).opacity))
  const before = await markerOpacity()
  await H(() => window.__harness.scene.enable())
  const owned = await markerOpacity()
  await H(() => window.__harness.scene.disable())
  const restored = await markerOpacity()
  gate.check('1.8', 'DOM drone markers go transparent while the layer owns the fleet and come back on disable()',
    before.length > 0 && owned.every((o) => o === '0') && JSON.stringify(restored) === JSON.stringify(before),
    `${before.length} markers: ${before[0]} → ${owned[0]} → ${restored[0]}`)

  await H(() => { const h = window.__harness; h.dom.glOnly(true); h.atmosphere.enable(false); h.scene.enable() }) // airframes only: no fog, no smoke

  // ── 1.1 both airframes build ─────────────────────────────────────────────────────────────────
  const stats = await H(() => window.__harness.fleet.stats())
  const { teal2, x10 } = stats.airframes
  gate.check('1.1', 'both airframes build, each from ≥ 12 meshes', teal2.meshes >= 12 && x10.meshes >= 12 && probe.consoleErrors().length === 0,
    `teal2 ${teal2.meshes} meshes / ${teal2.trianglesFull} tris (low ${teal2.trianglesLow}); x10 ${x10.meshes} meshes / ${x10.trianglesFull} tris (low ${x10.trianglesLow})`)
  report.airframes = stats.airframes

  // Hand-placed aircraft hover 60 m over UAV-01's ground point, nose north.
  const drone = (id, airframe, extra = {}) => ({ id, airframe, lng: uav.lng, lat: uav.lat, elevationM: ground + 60, headingDeg: 0, speedMs: 0,
    propRpm: 0, gimbalYawDeg: 0, gimbalPitchDeg: -25, color: '#00e5ff', ...extra })
  const look = async (target, distanceM, elevAngleDeg, bearingDeg, fovDeg = 36.87) => {
    const flat = distanceM * Math.cos((elevAngleDeg * Math.PI) / 180)
    const cam = {
      lng: target.lng + (Math.sin((bearingDeg * Math.PI) / 180) * flat) / (111_320 * Math.cos((target.lat * Math.PI) / 180)),
      lat: target.lat + (Math.cos((bearingDeg * Math.PI) / 180) * flat) / 111_320,
      alt: target.elevationM - distanceM * Math.sin((elevAngleDeg * Math.PI) / 180),
    }
    await H(([c, t, f]) => window.__harness.camera.fromTo([c.lng, c.lat], c.alt, [t.lng, t.lat], t.elevationM, f), [cam, target, fovDeg])
  }

  // ── 1.2 silhouettes differ ───────────────────────────────────────────────────────────────────
  // Each airframe is framed at a distance proportional to its own span, so both fill the same
  // fraction of the frame: what is left to differ is SHAPE, not size. One mesh re-scaled scores ~1.
  const silhouette = async (airframe, spanM, view) => {
    const d = drone('subject', airframe)
    await look(d, 20 * (spanM / teal2.spanM), view.elev, view.bearing)
    await H(() => window.__harness.fleet.synthetic([]))
    const empty = await settleShot(`12-${airframe}-${view.tag}-empty`)
    await H((list) => window.__harness.fleet.synthetic(list), [d])
    return diffMask(await settleShot(`12-${airframe}-${view.tag}`), empty)
  }
  const ious = []
  for (const view of [{ tag: 'three-quarter', elev: -35, bearing: 140 }, { tag: 'top', elev: -89, bearing: 180 }, { tag: 'side', elev: -4, bearing: 90 }]) {
    const a = await silhouette('teal2', teal2.spanM, view)
    const b = await silhouette('x10', x10.spanM, view)
    ious.push({ view: view.tag, iou: Number(silhouetteIoU(a, b, (r) => r > 128).toFixed(3)), px: [a.count, b.count] })
  }
  gate.check('1.2', 'silhouettes differ: span-normalised IoU(TEAL2, X10) < 0.80 from every view, and both actually drew',
    ious.every((v) => v.iou < 0.8 && v.px[0] > 1500 && v.px[1] > 1500), ious.map((v) => `${v.view} ${v.iou} (${v.px.join('/')} px)`).join('; '))
  report['1.2'] = ious

  // ── 1.3 LOD switches ─────────────────────────────────────────────────────────────────────────
  const lod = []
  const lodSubject = drone('lod', 'teal2')
  await H((list) => window.__harness.fleet.synthetic(list), [lodSubject])
  for (const distance of [200, 800, 3000]) {
    await look(lodSubject, distance, -30, 160, 8)
    await probe.ready()
    await H(() => window.__harness.render.pump(3))
    lod.push({ distance, triangles: (await H(() => window.__harness.render.info())).triangles, bands: (await H(() => window.__harness.fleet.stats())).bands })
  }
  gate.check('1.3', 'LOD switches: 200 m / 800 m / 3000 m give 3 distinct triangle counts, monotonically decreasing',
    lod[0].triangles > lod[1].triangles && lod[1].triangles > lod[2].triangles && lod[2].triangles > 0
      && lod[0].bands.full === 1 && lod[1].bands.low === 1 && lod[2].bands.sprite === 1,
    lod.map((l) => `${l.distance} m → ${l.triangles} tris`).join(', '))
  report['1.3'] = lod

  // ── 1.4 props animate (the SIM fleet, the SIM clock) ─────────────────────────────────────────
  await H(() => { const h = window.__harness; h.fleet.synthetic(null); h.map.setVerticalFieldOfView(36.87) })
  const live = (await H(() => window.__harness.sim.fleet())).find((d) => d.altAgl > 5)
  const liveGround = await H((c) => window.__harness.map.queryTerrainElevation(c), [live.lng, live.lat])
  await H(([c, e]) => window.__harness.camera.set({ center: c, zoom: 22, pitch: 0, bearing: 0, elevation: e, unlock: true }), [[live.lng, live.lat], liveGround + live.altAgl])
  const propsA = await settleShot('14-props-a')
  await H(() => window.__harness.sim.step(0.05))
  const propsB = await settleShot('14-props-b')
  const moved = diffMask(propsB, propsA, 16).count
  gate.check('1.4', 'props animate: two frames one 50 ms sim step apart differ by ≥ 100 px over the aircraft', moved >= 100, `${moved} px changed (${live.id}, ${live.mode})`)

  // ── 1.5 instancing · 1.6 budget: 20 aircraft strung through all three LOD bands ─────────────
  const line = Array.from({ length: 20 }, (_, i) => {
    const out = 60 + i * 125 // 60 m … 2435 m north of the camera's ground point
    return drone(`syn-${i}`, i % 2 ? 'x10' : 'teal2', { lat: uav.lat + out / 111_320, elevationM: ground + 120, headingDeg: i * 18, speedMs: 6, propRpm: 5600 })
  })
  await H((list) => window.__harness.fleet.synthetic(list), line)
  const eye = { lng: uav.lng, lat: uav.lat - 60 / 111_320, alt: ground + 150 }
  await H(([c, t]) => window.__harness.camera.fromTo([c.lng, c.lat], c.alt, [t.lng, t.lat], t.elevationM, 36.87), [eye, line[8]])
  await probe.ready()
  await H(() => window.__harness.render.pump(320))
  const times = (await H(() => window.__harness.render.layerTimes())).sort((a, b) => a - b)
  const info = await H(() => window.__harness.render.info())
  const bands = (await H(() => window.__harness.fleet.stats())).bands
  await settleShot('15-twenty-aircraft')
  gate.check('1.5', 'instancing holds: 20 aircraft → draw calls ≤ 40', info.calls <= 40 && bands.full + bands.low + bands.sprite === 20, `${info.calls} draw calls, ${info.triangles} tris`)
  p75 = Number(times[Math.floor(times.length * 0.75)].toFixed(3))
  gate.check('1.6', 'budget: 20 aircraft across all 3 LOD bands, layer render ≤ 4 ms p75', p75 <= 4 && bands.full > 0 && bands.low > 0 && bands.sprite > 0,
    `p75 ${p75} ms; bands full ${bands.full} / low ${bands.low} / sprite ${bands.sprite}`)
  Object.assign(report, { '1.5': info, bands, p75LayerMs: p75 })
} catch (err) {
  gate.check('1.X', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  await probe?.close()
  server?.stop()
}

// ── 1.7 weight: everything the 3D layer adds, measured against the build that ships today ─────
try {
  const shipped = resolve(ARTIFACTS, 'public-dist')
  buildApp({ outDir: shipped, harness: false })
  const deltaKb = (gzJs(OUT_DIR) - gzJs(shipped)) / 1024
  gate.check('1.7', 'weight: total added JS ≤ 250 KB gzipped (three + scene3d + harness, vs the shipped build)', deltaKb <= 250, `${deltaKb.toFixed(1)} KB gz`)
  report.addedGzKb = Number(deltaKb.toFixed(1))
} catch (err) {
  gate.check('1.7', 'weight measured', false, err.message.split('\n')[0])
}

try { writeFileSync(resolve(ARTIFACTS, 'g1', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g1/' }))
