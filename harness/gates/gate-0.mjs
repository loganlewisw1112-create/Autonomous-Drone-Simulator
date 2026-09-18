// GATE 0 — render harness go/no-go (plan Phase 0). A three.js custom layer sharing MapLibre's GL
// context must (1) draw, (2) stay geo-anchored, (3) be occluded by MapLibre's terrain through the
// shared depth buffer, (4) leave MapLibre's GL state and layer stack untouched, (5) cost ≤ 2 ms.
// 0.3 at pitch 0 failing is the architecture-invalidating result: ABORT, do not start Phase 1.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, SCENARIO_SEED } from '../config.mjs'
import { centroid, colourCount, createGate, decodePng, luminanceDelta, meanLuminance, noiseFloorDiff } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('0')
const MAGENTA = [255, 0, 255]
const isMagenta = (r, g, b) => r > 200 && g < 70 && b > 200
const BOX_M = 3
const MIN_BOX_PX = 400
const report = { assertions: {} }
let p75 = 'n/a'

let server
let probe
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })
  probe = await openProbe()
  const H = (fn, arg) => probe.eval(fn, arg)
  const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(`g0/${name}.png`)) }

  await probe.ready()
  const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
  if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
  await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
  await probe.ready()
  await H(() => window.__harness.dom.glOnly(true))
  await H(() => window.__harness.fleet.synthetic([])) // Gate 0 is about the layer itself: empty sky
  await H(() => window.__harness.atmosphere.enable(false)) // …and no sky, fog or smoke either

  const fleet = await H(() => window.__harness.sim.fleet())
  const uav = fleet[0]
  const at = [uav.lng, uav.lat]
  await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), at)
  await probe.ready()
  const ground = await H((c) => window.__harness.map.queryTerrainElevation(c), at)
  const groundDem = await H(([lng, lat]) => window.__harness.terrain.elevationAt(lng, lat), at)
  if (ground === null) throw new Error('queryTerrainElevation returned null at UAV-01 — terrain not live')
  const boxElev = ground + uav.altAgl
  Object.assign(report, { scenario: loaded.scenarioId, seed: loaded.seed, uav, groundRenderedM: ground, groundDemM: groundDem, boxElevationM: boxElev })
  console.log(`  UAV-01 ${uav.lng.toFixed(5)},${uav.lat.toFixed(5)} ground ${ground.toFixed(1)} m (DEM×exag ${groundDem?.toFixed(1)}) box @ ${boxElev.toFixed(1)} m`)

  const trueBox = { lng: uav.lng, lat: uav.lat, elevationM: boxElev, sizeM: BOX_M }
  const stateView = { center: at, zoom: 16, pitch: 45, bearing: 20, elevation: ground, unlock: true }

  // ── Reference frame BEFORE the 3D layer has ever been constructed ────────────────────────────
  await H((v) => window.__harness.camera.set(v), stateView)
  const layersBefore = await H(() => window.__harness.map.getStyle().layers.length)
  const pristine = await settleShot('04-pristine')

  // ── 0.4 no GL state bleed · kill switch ──────────────────────────────────────────────────────
  // Back-to-back at ONE camera: MapLibre label placement is history-dependent, so frames taken
  // either side of a long camera journey differ for reasons that have nothing to do with the layer.
  await H((box) => { const h = window.__harness; h.scene.enable(); h.scene.addTestBox(box) }, trueBox)
  const mounted = await settleShot('04-mounted')
  const layersMounted = await H(() => window.__harness.map.getStyle().layers.length)
  await H(() => window.__harness.scene.disable())
  const disabled = await settleShot('04-disabled')
  const away = { x: 0, y: 0, w: Math.floor(mounted.width * 0.35), h: mounted.height } // box is at frame centre
  const lum = luminanceDelta(away, disabled, mounted)
  const restore = noiseFloorDiff(pristine, disabled)
  gate.check('0.4', 'no GL state bleed: luminance away from the box within 2 % of the layer-disabled frame (and not black)',
    Math.abs(lum) <= 2 && meanLuminance(mounted, away) > 20, `Δ ${lum.toFixed(3)} %, mean ${meanLuminance(mounted, away).toFixed(1)}, pixel diff ${noiseFloorDiff(disabled, mounted, away).toFixed(4)} %`)
  gate.check('0.4k', 'kill switch: scene.disable() restores the never-mounted frame', restore <= 0.1, `diff ${restore.toFixed(4)} % vs pristine`)

  // ── 0.1 box renders ──────────────────────────────────────────────────────────────────────────
  const topDown = { center: at, zoom: 19.5, pitch: 0, bearing: 0, elevation: boxElev, unlock: true }
  await H(([v, box]) => {
    const h = window.__harness
    h.scene.enable(); h.scene.addTestBox(box); h.camera.set(v)
  }, [topDown, trueBox])
  const f01 = await settleShot('01-box')
  const mid = { x: Math.round(f01.width / 2) - 80, y: Math.round(f01.height / 2) - 80, w: 160, h: 160 }
  const px01 = colourCount(f01, mid, MAGENTA, 40)
  gate.check('0.1', `box renders: ≥ ${MIN_BOX_PX} px of box colour at its projected position, pitch 0`, px01 >= MIN_BOX_PX, `${px01} px`)
  report.assertions['0.1'] = { px: px01 }

  // ── 0.2 geo-anchored across zoom 12→18 (+ one pitched view) ──────────────────────────────────
  const anchor = []
  for (const view of [...[12, 13, 14, 15, 16, 17, 18].map((z) => ({ z, pitch: 0 })), { z: 16, pitch: 50 }]) {
    await H(([c, v, g]) => window.__harness.camera.set({ center: c, zoom: v.z, pitch: v.pitch, bearing: 0, elevation: g, unlock: true }), [at, view, ground])
    await probe.ready()
    const expected = await H(() => {
      const h = window.__harness
      const map = h.map
      const size = map.getContainer().getBoundingClientRect()
      const mpp = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom())
      const offPx = Math.max(50, Math.min(150, 800 / mpp))
      const ll = map.unproject([size.width / 2 + offPx, size.height / 2 - offPx * 0.6])
      const g = map.queryTerrainElevation(ll) ?? h.terrain.elevationAt(ll.lng, ll.lat)
      h.scene.clearTestObjects()
      // A thin always-drawn slab ON the ground: no parallax, no burial — isolates x/y/z placement.
      h.scene.addTestBox({ lng: ll.lng, lat: ll.lat, elevationM: g, sizeM: [24 * mpp, 24 * mpp, 0.5], depthTest: false })
      const p = map.project(ll)
      return { x: p.x, y: p.y, groundM: g }
    })
    const frame = await settleShot(`02-anchor-z${view.z}-p${view.pitch}`)
    const c = centroid(frame, null, isMagenta)
    const err = c ? Math.hypot(c.x - expected.x, c.y - expected.y) : Infinity
    anchor.push({ ...view, errPx: Number(err.toFixed(2)), px: c?.count ?? 0 })
  }
  const worst = Math.max(...anchor.map((a) => a.errPx))
  gate.check('0.2', 'geo-anchored: slab centroid within 2 px of map.project() across zoom 12→18 and at pitch 50',
    worst <= 2, anchor.map((a) => `z${a.z}/p${a.pitch}=${a.errPx}`).join(' '))
  report.assertions['0.2'] = anchor

  // ── 0.5 style stack survives ─────────────────────────────────────────────────────────────────
  const layersAfter = await H(() => window.__harness.map.getStyle().layers.length)
  const glErrors = probe.consoleErrors(/WebGL|GL_INVALID|shader/i)
  gate.check('0.5', 'all style layers survive; no WebGL/GL_INVALID/shader console errors',
    layersAfter === layersBefore && layersMounted - layersBefore <= 1 && layersMounted >= layersBefore && glErrors.length === 0,
    `${layersBefore} before / ${layersMounted} mounted / ${layersAfter} after; ${glErrors.length} GL errors${glErrors[0] ? `: ${glErrors[0]}` : ''}`)

  // ── 0.6 budget ───────────────────────────────────────────────────────────────────────────────
  await H(([v, box]) => { const h = window.__harness; h.scene.enable(); h.scene.clearTestObjects(); h.scene.addTestBox(box); h.camera.set(v) }, [stateView, trueBox])
  await probe.ready()
  await H(() => window.__harness.render.pump(320))
  const times = (await H(() => window.__harness.render.layerTimes())).sort((a, b) => a - b)
  p75 = times.length ? Number(times[Math.floor(times.length * 0.75)].toFixed(3)) : 'n/a'
  gate.check('0.6', 'layer render ≤ 2 ms p75 over 300 frames with one box', times.length >= 300 && p75 <= 2, `p75 ${p75} ms over ${times.length} frames`)
  Object.assign(report, { layers: { layersBefore, layersMounted, layersAfter }, p75LayerMs: p75, renderInfo: await H(() => window.__harness.render.info()) })

  // ── 0.3 terrain occlusion via the shared depth buffer ────────────────────────────────────────
  // Every terrain-ON frame is taken first, then terrain is disabled ONCE and the same cameras are
  // replayed (terrain.disable() is one-way on maplibre-gl 6.9 — see installHarness.ts).
  const findRidgeShot = async (elevAngleDeg) => {
    // Preferred: box at an aircraft's TRUE position, camera where the DEM says a ridge blocks it.
    // If no such ridge exists at this pitch, scan the AO for a box position (30 m, then 10 m AGL)
    // that has one. Either way the claim under test is identical: terrain depth hides the box.
    for (const d of fleet.filter((f) => f.altAgl > 5)) {
      const g = await H(([lng, lat]) => window.__harness.terrain.elevationAt(lng, lat), [d.lng, d.lat])
      const target = { lng: d.lng, lat: d.lat, elevationM: g + d.altAgl }
      const camera = await H((q) => window.__harness.terrain.findOccludedCamera(q), { target, elevAngleDeg })
      if (camera) return { target, camera, subject: `${d.id} true position` }
    }
    // Relief is only drawn inside the 2×2 block of whole DEM tiles (~3.7 km), which holds few slopes
    // steep enough to hide a high box. Walk down in AGL; the last resort is a box 20 m under the
    // surface, where the hillside itself is the ridge. The mechanism under test never changes.
    for (const aglM of [30, 10, 3, -20]) {
      const found = await H((q) => window.__harness.terrain.findOccludedShot(q), { elevAngleDeg, aglM, minMarginM: 8, stepM: 100 })
      if (found) return { ...found, subject: aglM > 0 ? `synthetic box ${aglM} m AGL behind a natural ridge` : `synthetic box ${-aglM} m under the surface (no natural ridge this steep in the drawn relief)` }
    }
    return null
  }
  const ridgeCase = async (tag, elevAngleDeg) => {
    const shot = await findRidgeShot(elevAngleDeg)
    if (!shot) return { tag, missing: true }
    const { target, camera: cam } = shot
    const dist3d = cam.distanceM / Math.cos((elevAngleDeg * Math.PI) / 180)
    const fov = Math.max(0.5, (2 * Math.atan((BOX_M * 889) / (2 * dist3d * 40)) * 180) / Math.PI)
    return { tag, subject: shot.subject, cam, box: { ...target, sizeM: BOX_M },
      apply: () => H(([c, t, f]) => window.__harness.camera.fromTo([c.lng, c.lat], c.elevationM, [t.lng, t.lat], t.elevationM, f), [cam, target, fov]) }
  }
  const cases = [
    // pitch 0: straight down there is no "ridge between", so the box sits 8 m under the surface at
    // UAV-01's lng/lat — the purest form of the question: is terrain depth in the buffer we test against?
    { tag: 'p0', subject: 'uav-01 lng/lat, 8 m below the surface', box: { ...trueBox, elevationM: ground - 8 },
      apply: () => H((v) => { window.__harness.map.setVerticalFieldOfView(36.87); window.__harness.camera.set(v) }, { ...topDown, elevation: ground }) },
    await ridgeCase('p60', -30),
    await ridgeCase('p107', 17),
  ]
  for (const pass of ['on', 'off']) {
    if (pass === 'off') await H(() => window.__harness.terrain.disable())
    for (const c of cases.filter((k) => !k.missing)) {
      await H((b) => { const h = window.__harness; h.scene.clearTestObjects(); h.scene.addTestBox(b) }, c.box)
      await c.apply()
      // Terrain ON must be fully settled (unloaded terrain could only ever cause a FAIL, never a false
      // pass). Terrain OFF flattens the world 1.5 km below these cameras and basemap tiles can stream
      // for a long time; the claim there is only "the box shows", so a bounded settle is enough.
      const frame = pass === 'on' ? await settleShot(`03-${c.tag}-terrain-on`) : await (async () => {
        await probe.ready(8_000).catch(() => H(() => window.__harness.render.pump(30)))
        return decodePng(await probe.shot(`g0/03-${c.tag}-terrain-off.png`))
      })()
      c[pass] = colourCount(frame, null, MAGENTA, 40)
      if (pass === 'on') Object.assign(c, await H(() => ({ pitch: Number(window.__harness.map.getPitch().toFixed(1)), zoom: Number(window.__harness.map.getZoom().toFixed(2)) })))
    }
  }
  const [c0, c60, c107] = cases
  gate.check('0.3@p0', 'terrain occludes a buried box at pitch 0; same camera, terrain off, it shows',
    c0.on === 0 && c0.off >= MIN_BOX_PX, `terrain on ${c0.on} px / off ${c0.off} px`)
  for (const [c, want] of [[c60, 60], [c107, 107]]) {
    gate.check(`0.3@p${want}`, `ridge between camera and box at pitch ≈ ${want}: box colour = 0; same camera, terrain off ≥ ${MIN_BOX_PX}`,
      !c.missing && c.on === 0 && c.off >= MIN_BOX_PX && Math.abs(c.pitch - want) <= 3,
      c.missing ? 'no ridge-blocked camera placement exists anywhere in this DEM'
        : `${c.subject}; pitch ${c.pitch} zoom ${c.zoom}; ridge clears sight-line by ${c.cam.marginM.toFixed(0)} m, camera ${c.cam.distanceM} m out — on ${c.on} px / off ${c.off} px`)
  }
  report.assertions['0.3'] = cases.map(({ apply, ...rest }) => rest)
  await H(() => window.__harness.map.setVerticalFieldOfView(36.87))
} catch (err) {
  gate.check('0.X', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  await probe?.close()
  server?.stop()
}

try { writeFileSync(resolve(ARTIFACTS, 'g0', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* no artifacts dir: gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g0/' }))
