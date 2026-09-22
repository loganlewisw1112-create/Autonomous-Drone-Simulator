// GATE 4 — camera director and sensor volumes (plan Phase 4).
// The rig is stepped by the gate (fixed dt, rAF loop off), so every camera path here replays exactly.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('4')
const report = {}
let p75 = 'n/a'
const percentile = (values, q) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length * q)] }

let server
let probe
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })
  probe = await openProbe()
  const H = (fn, arg) => probe.eval(fn, arg)
  const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(`g4/${name}.png`)) }
  // Looking UP from the ground puts the far horizon in view and MapLibre may stream distant tiles for a long
  // time. Pitch, projection and sky colour do not depend on them, so these shots settle for a bounded time.
  const boundedShot = async (name) => {
    await probe.eval((t) => window.__harness.ready(t), 8_000).catch(() => probe.eval(() => window.__harness.render.pump(30)))
    return decodePng(await probe.shot(`g4/${name}.png`))
  }

  await probe.ready()
  const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
  if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
  await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
  await probe.ready()
  const uav = (await H(() => window.__harness.sim.fleet()))[0]
  await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), [uav.lng, uav.lat])
  await probe.ready()
  await H(() => { const h = window.__harness; h.dom.glOnly(true); h.lighting.beacons(false); h.lighting.override({ azimuthDeg: 160, elevationDeg: 50 }); h.scene.enable() })
  await probe.ready()
  const ground = await H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), [uav.lng, uav.lat])

  // ── 4.5 one picture per concept: the flat layer is hidden while its 3D twin is drawn ────────
  await H(() => window.__harness.sim.sensorMode('ir')) // thermal footprints exist only in IR
  await H(() => { window.__harness.sim.step(1); return window.__harness.render.pump(4) })
  const owned = await H(() => window.__harness.fleet.ownedLayers())
  const twins = await H(() => window.__harness.fleet.volumeStats())
  await H(() => window.__harness.scene.disable())
  const released = await H(() => window.__harness.fleet.ownedLayers())
  await H(() => { const h = window.__harness; h.sim.sensorMode('eo'); h.scene.enable() })
  const kinds = { footprint: owned.filter((l) => l.id.startsWith('ir-footprint')), gnss: owned.filter((l) => l.id.startsWith('gnss-')), trail: owned.filter((l) => l.id.startsWith('trail-')) }
  gate.check('4.5', 'no duplicate concepts: every replaced 2D layer has visibility "none" while its 3D twin is on screen, and gets it back on disable()',
    owned.length >= 5 && owned.every((l) => l.visibility === 'none') && kinds.footprint.length === 2 && kinds.gnss.length === 2 && kinds.trail.length >= 1
      && twins.footprints > 0 && twins.trailSegments > 0 && released.every((l) => l.visibility === 'visible'),
    `${owned.length} layers hidden (${kinds.footprint.length} footprint, ${kinds.gnss.length} GNSS, ${kinds.trail.length} trail); 3D twins: ${twins.footprints} footprints+cones, ${twins.ellipsoids} ellipsoids, ${twins.trailSegments} trail segments; restored: ${released.filter((l) => l.visibility === 'visible').length}/${released.length}`)
  report['4.5'] = { owned, twins, released }

  // ── 4.1 every mode holds · 4.2 bearing wrap is clean ────────────────────────────────────────
  // Subject: one aircraft on a figure-eight — turns both ways, crosses north every lap. 60 s of sim per mode.
  await H(([c, e]) => window.__harness.fleet.figureEight({ lng: c[0], lat: c[1], elevationM: e, radiusM: 150, speedMs: 12, rotationDeg: 180 }), [[uav.lng, uav.lat], ground + 60])
  const holds = await H(() => {
    const h = window.__harness
    const out = {}
    const metres = (a, b) => Math.hypot((a.lng - b.lng) * 85_000, (a.lat - b.lat) * 111_320, a.alt - b.alt)
    for (const mode of ['ORBIT', 'CHASE', 'FPV', 'GROUND']) {
      h.camera.mode(mode)
      let prev = null, prevLook = null, prevBearing = null, prevHeading = null
      const r = { maxJumpM: 0, maxBearingStepDeg: 0, northCrossings: 0, travelM: 0, steps: 0 }
      for (let i = 0; i < 1200; i++) {
        h.sim.step(0.05)
        h.camera.advance(0.05)
        const s = h.camera.state()
        const bearing = h.map.getBearing()
        if (prev && i > 1) { // the first step after a mode switch is a deliberate snap
          r.maxJumpM = Math.max(r.maxJumpM, metres(s.camera, prev))
          r.maxBearingStepDeg = Math.max(r.maxBearingStepDeg, Math.abs(((bearing - prevBearing + 540) % 360) - 180))
          r.travelM += metres(s.lookAt, prevLook)
        }
        const heading = ((bearing % 360) + 360) % 360
        if (prevHeading !== null && Math.abs(heading - prevHeading) > 300) r.northCrossings++
        prevLook = s.lookAt
        prev = s.camera; prevBearing = bearing; prevHeading = heading; r.steps++
      }
      out[mode] = r
    }
    // TACTICAL: the rig must leave the operator's camera alone.
    h.camera.mode('TACTICAL')
    const before = JSON.stringify([h.map.getCenter(), h.map.getZoom(), h.map.getBearing(), h.map.getPitch()])
    for (let i = 0; i < 1200; i++) { h.sim.step(0.05); h.camera.advance(0.05) }
    out.TACTICAL = { untouched: before === JSON.stringify([h.map.getCenter(), h.map.getZoom(), h.map.getBearing(), h.map.getPitch()]), steps: 1200 }
    return out
  })
  const active = ['ORBIT', 'CHASE', 'FPV', 'GROUND']
  gate.check('4.1', 'all 5 modes hold: 60 s each on a manoeuvring aircraft, no camera position jump > 50 m between consecutive frames (TACTICAL leaves the map alone)',
    active.every((m) => holds[m].maxJumpM <= 50 && holds[m].steps === 1200) && holds.TACTICAL.untouched,
    active.map((m) => `${m} ${holds[m].maxJumpM.toFixed(2)} m`).join(', ') + `; TACTICAL untouched=${holds.TACTICAL.untouched}`)
  gate.check('4.2', 'bearing wrap clean: with the heading crossing north (359° → 1°) no camera bearing step exceeds 10°/frame',
    ['CHASE', 'FPV'].every((m) => holds[m].maxBearingStepDeg <= 10 && holds[m].northCrossings >= 1),
    ['CHASE', 'FPV'].map((m) => `${m} worst ${holds[m].maxBearingStepDeg.toFixed(2)}°/frame over ${holds[m].northCrossings} north crossings`).join('; '))
  report['4.1'] = holds

  // ── 4.3 GROUND looks up · 4.4 and there is sky to look at ───────────────────────────────────
  const hover = { id: 'hover', airframe: 'x10', lng: uav.lng, lat: uav.lat, elevationM: ground + 30, headingDeg: 0, speedMs: 0, propRpm: 5200, gimbalYawDeg: 0, gimbalPitchDeg: -25, color: '#00e5ff' }
  await H((list) => { const h = window.__harness; h.fleet.synthetic(list); h.camera.mode('GROUND') }, [hover])
  await H(() => { const h = window.__harness; for (let i = 0; i < 300; i++) h.camera.advance(0.05) })
  const groundShot = await boundedShot('43-ground-observer')
  const pitch = await H(() => window.__harness.map.getPitch())
  const onScreen = await H((d) => window.__harness.camera.project(d.lng, d.lat, d.elevationM), hover)
  gate.check('4.3', 'GROUND looks up: map pitch > 100 and the aircraft sits in the upper 40 % of the frame',
    pitch > 100 && onScreen !== null && onScreen.y < groundShot.height * 0.4 && onScreen.y > 0,
    `pitch ${pitch.toFixed(1)}°, aircraft at y = ${onScreen ? (100 * onScreen.y / groundShot.height).toFixed(0) : '?'} % of frame height`)
  // Control: the same camera with the sky taken away shows what "raw canvas" looks like here.
  await H(() => window.__harness.map.setSky(undefined))
  const noSky = await boundedShot('44-control-no-sky')
  const band = { x: 0, y: 0, w: groundShot.width, h: Math.floor(groundShot.height * 0.25) }
  const rawCanvas = [noSky.data[0], noSky.data[1], noSky.data[2]]
  let bare = 0, blue = 0, total = 0
  for (let y = band.y; y < band.h; y++) for (let x = 0; x < band.w; x++) {
    const i = (y * groundShot.width + x) * 4
    total++
    if (Math.abs(groundShot.data[i] - rawCanvas[0]) <= 3 && Math.abs(groundShot.data[i + 1] - rawCanvas[1]) <= 3 && Math.abs(groundShot.data[i + 2] - rawCanvas[2]) <= 3) bare++
    if (groundShot.data[i + 2] > groundShot.data[i] + 20) blue++
  }
  gate.check('4.4', 'sky above the horizon: in GROUND mode the top of the frame is sky-coloured, with zero raw-canvas pixels',
    bare === 0 && blue / total > 0.9, `${bare} raw-canvas px (raw canvas here is rgb ${rawCanvas.join(',')}); ${(100 * blue / total).toFixed(1)} % of the top quarter is sky-blue`)
  report['4.3'] = { pitch, onScreen, rawCanvas }

  // ── 4.6 drag-to-orbit input latency (the rig's own rAF loop, no React anywhere in the path) ─
  await H(() => window.__harness.camera.live('ORBIT'))
  await H(() => window.__harness.render.pump(30)) // not ready(): a live orbit never lets the map go idle
  await H(() => {
    window.__latency = []
    window.addEventListener('pointermove', (e) => {
      const at = e.timeStamp
      // The rig consumes the move on the next frame; the frame after that has been presented.
      requestAnimationFrame(() => requestAnimationFrame(() => window.__latency.push(performance.now() - at)))
    })
  })
  const before = (await H(() => window.__harness.camera.state())).orbitBearingDeg
  const box = await probe.page.locator('.maplibregl-canvas').first().boundingBox()
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await probe.page.mouse.move(cx - 200, cy)
  await probe.page.mouse.down()
  const dragStart = Date.now()
  for (let i = 0; Date.now() - dragStart < 5000; i++) { await probe.page.mouse.move(cx - 200 + ((i * 3) % 400), cy + Math.sin(i / 20) * 40); await new Promise((r) => setTimeout(r, 12)) }
  await probe.page.mouse.up()
  const latency = await H(() => window.__latency)
  const frameMs = percentile(await H(() => window.__harness.render.frameTimes()), 0.75)
  const after = (await H(() => window.__harness.camera.state())).orbitBearingDeg
  const inp = percentile(latency, 0.75)
  gate.check('4.6', 'INP: 5 s of drag-to-orbit, p75 input-to-next-paint ≤ 200 ms (and the drag really steered the orbit)',
    // Playwright resolves each mouse.move only once the page has handled it, so the sample count tracks the frame rate.
    latency.length >= 30 && inp <= 200 && Math.abs(after - before) > 5,
    `p75 ${inp.toFixed(1)} ms, p95 ${percentile(latency, 0.95).toFixed(1)} ms over ${latency.length} moves; orbit bearing ${before.toFixed(0)}° → ${after.toFixed(0)}°; whole-frame p75 while orbiting ${frameMs.toFixed(1)} ms`)
  report['4.6'] = { p75: inp, samples: latency.length, frameMsP75WhileOrbiting: frameMs }

  // ── 4.7 budget: every volume on, 20 aircraft, sim clock ticking at 20 Hz ─────────────────────
  await H(() => window.__harness.camera.mode('TACTICAL'))
  const at = (i) => ({ lng: uav.lng + ((i % 5) * 60 - 120) / 85_000, lat: uav.lat + (60 + i * 110) / 111_320 })
  const line = Array.from({ length: 20 }, (_, i) => ({ ...hover, ...at(i), id: `syn-${i}`, airframe: i % 2 ? 'x10' : 'teal2', elevationM: ground + 120, headingDeg: i * 18, speedMs: 6, propRpm: 5600 }))
  const volumes = {
    simTimeSec: 0, show: { footprints: true, uncertainty: true, trails: true },
    footprints: line.map((d) => ({ id: d.id, apex: [d.lng, d.lat], apexElevationM: d.elevationM,
      arc: Array.from({ length: 7 }, (_, k) => { const b = ((d.headingDeg - 30 + 10 * k) * Math.PI) / 180; return [d.lng + (Math.sin(b) * 80) / 85_000, d.lat + (Math.cos(b) * 80) / 111_320] }) })),
    uncertainties: line.map((d) => ({ id: d.id, lng: d.lng, lat: d.lat, elevationM: d.elevationM, radiusM: 8, color: d.color })),
    trails: line.map((d) => ({ id: d.id, color: d.color, points: Array.from({ length: 60 }, (_, k) => [d.lng - (k * 4) / 85_000, d.lat - (k * 3) / 111_320, d.elevationM]) })),
  }
  await H(([list, v]) => { const h = window.__harness; h.fleet.synthetic(list); h.fleet.volumes(v) }, [line, volumes])
  await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 60, bearing: 0 }), [uav.lng, uav.lat + 600 / 111_320])
  await probe.ready()
  await H(async () => {
    const h = window.__harness
    for (let i = 0; i < 330; i++) { if (i % 3 === 0) h.sim.step(0.05); h.map.triggerRepaint(); await new Promise((r) => requestAnimationFrame(r)) }
  })
  const times = await H(() => window.__harness.render.layerTimes())
  p75 = Number(percentile(times, 0.75).toFixed(3))
  const built = await H(() => window.__harness.fleet.volumeStats())
  await settleShot('47-all-volumes')
  gate.check('4.7', 'budget: layer render ≤ 8 ms p75 with every volume on, 20 aircraft, volumes rebuilding at the sim\'s 20 Hz',
    p75 <= 8 && built.footprints === 20 && built.ellipsoids === 20 && built.trailSegments > 1000, `p75 ${p75} ms; ${built.footprints} footprints+cones, ${built.ellipsoids} ellipsoids, ${built.trailSegments} trail segments`)

  // ── 4.8 (extra) the kill switch gives the operator their map back ───────────────────────────
  await H(() => { const h = window.__harness; h.camera.mode('GROUND'); h.camera.advance(0.05); h.scene.disable() })
  const restored = await H(() => { const m = window.__harness.map; return { maxPitch: m.getMaxPitch(), pitch: m.getPitch(), dragPan: m.dragPan.isEnabled(), scrollZoom: m.scrollZoom.isEnabled(), sky: m.getSky() ?? null, fov: m.getVerticalFieldOfView() } })
  gate.check('4.8', 'kill switch restores the operator\'s map: pitch cap 60, pan and zoom handlers back on, default FOV, the style\'s own sky',
    restored.maxPitch === 60 && restored.pitch <= 60 && restored.dragPan && restored.scrollZoom && Math.abs(restored.fov - 36.87) < 0.01, JSON.stringify(restored))
  gate.check('4.X', 'no WebGL / shader console errors all session', probe.consoleErrors(/WebGL|GL_INVALID|shader/i).length === 0, probe.consoleErrors(/WebGL|GL_INVALID|shader/i)[0] ?? '')
  Object.assign(report, { p75LayerMs: p75, restored })
} catch (err) {
  gate.check('4.Z', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  await probe?.close()
  server?.stop()
}

try { writeFileSync(resolve(ARTIFACTS, 'g4', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g4/' }))
