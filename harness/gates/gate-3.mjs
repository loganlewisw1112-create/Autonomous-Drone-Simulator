// GATE 3 — shadows on real geometry (plan Phase 3). MapLibre draws terrain and buildings, so the
// shadow lands on invisible stand-in receivers. Every claim is geometric: WHERE the shadow must be
// is computed from the sun ray and the drawn ground, then the pixels are asked whether it is there.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, diffMask, flicker, noiseFloorDiff } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('3')
const report = {}
let p75 = 'n/a'
const BUILDING_SCENARIO_SEED = 5005 // demo_wildfire: DEM + Overture buildings (train_wildfire_flank has none)
const lum = (f, i) => 0.2126 * f.data[i] + 0.7152 * f.data[i + 1] + 0.0722 * f.data[i + 2]

/** Shadow pixels = where `lit` got darker than `base`, within `radius` px of (cx, cy). */
function shadowNear(lit, base, cx, cy, radius) {
  const mask = diffMask(lit, base, 10)
  let n = 0, sx = 0, sy = 0, a = 0, b = 0
  for (let i = 0; i < mask.data.length; i += 4) {
    if (!mask.data[i]) continue
    const x = (i / 4) % lit.width, y = Math.floor(i / 4 / lit.width)
    if (Math.hypot(x - cx, y - cy) > radius || lum(lit, i) >= lum(base, i)) continue
    n++; sx += x; sy += y; a += lum(lit, i); b += lum(base, i)
  }
  return n ? { px: n, x: sx / n, y: sy / n, darker: (1 - a / b) * 100 } : { px: 0, x: NaN, y: NaN, darker: 0 }
}

let server
let probe
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })
  probe = await openProbe()
  const H = (fn, arg) => probe.eval(fn, arg)
  const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(name ? `g3/${name}.png` : undefined)) }
  const loadScenario = async (seed) => {
    const loaded = await H((n) => window.__harness.sim.seed(n), seed)
    if (!loaded.ok) throw new Error(`sim.seed(${seed}) failed: ${loaded.reason}`)
    await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
    await probe.ready()
    await H(() => { const h = window.__harness; h.dom.glOnly(true); h.fleet.synthetic([]); h.lighting.beacons(false); h.atmosphere.enable(false); h.scene.enable() }) // shadows only
    return (await H(() => window.__harness.sim.fleet()))[0]
  }
  const drone = (at, aglM, groundM, airframe = 'x10') => ({ id: 'caster', airframe, lng: at.lng, lat: at.lat, elevationM: groundM + aglM, headingDeg: 0,
    speedMs: 0, propRpm: 0, gimbalYawDeg: 0, gimbalPitchDeg: 0, color: '#00e5ff' })
  const topDown = (at, zoom, pitch = 0) => H(([c, z, p]) => window.__harness.camera.set({ center: c, zoom: z, pitch: p, bearing: 0 }), [[at.lng, at.lat], zoom, pitch])
  const project = (at) => H((ll) => { const p = window.__harness.map.project(ll); return { x: p.x, y: p.y } }, [at.lng, at.lat])
  const drawnGround = (at) => H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), [at.lng, at.lat])
  const shadowHit = (from, sun) => H(([f, s]) => window.__harness.terrain.shadowHit(f, s), [from, sun])
  /** Frame with the caster, frame without it (same sun, shadows on): the difference is caster + its shadow. */
  const withAndWithout = async (tag, caster) => {
    await H(() => window.__harness.fleet.synthetic([]))
    const without = await settleShot(`${tag}-without`)
    await H((list) => window.__harness.fleet.synthetic(list), [caster])
    return { without, withCaster: await settleShot(`${tag}-with`) }
  }

  await probe.ready()
  const uav = await loadScenario(SCENARIO_SEED)
  const here = { lng: uav.lng, lat: uav.lat }
  await topDown(here, 18)
  await probe.ready()
  const ground = await drawnGround(here)
  const relief = await H(([lng, lat]) => window.__harness.terrain.elevationAt(lng, lat), [here.lng, here.lat])
  console.log(`  caster over ${here.lng.toFixed(5)},${here.lat.toFixed(5)}; drawn ground ${ground.toFixed(1)} m (DEM×exag ${relief?.toFixed(1)})`)

  // ── 3.6 the receiver contributes nothing but shadow ─────────────────────────────────────────
  await H((s) => window.__harness.lighting.override(s), { azimuthDeg: 135, elevationDeg: 20 })
  await topDown(here, 17, 45)
  const receiversOn = await settleShot('36-receivers-no-casters')
  await H(() => window.__harness.lighting.shadows(false))
  const shadowsOff = await settleShot('36-shadows-off')
  await H(() => window.__harness.scene.disable())
  const unmounted = await settleShot('36-unmounted')
  await H(() => { const h = window.__harness; h.scene.enable(); h.lighting.shadows(true) })
  const leak = Math.max(noiseFloorDiff(unmounted, receiversOn), noiseFloorDiff(unmounted, shadowsOff))
  gate.check('3.6', 'receiver invisible: with nothing casting (and with castShadow off) the frame equals the unmounted map', leak <= 0.01, `worst diff ${leak.toFixed(4)} %`)

  // ── 3.1 a shadow exists where the sun ray meets the ground ──────────────────────────────────
  const sun20 = { azimuthDeg: 135, elevationDeg: 20 }
  const caster = drone(here, 30, ground)
  const hit = await shadowHit(caster, sun20)
  await topDown(hit, 18)
  await H(([s, list]) => { const h = window.__harness; h.lighting.override(s); h.fleet.synthetic(list) }, [sun20, [caster]])
  const shadowed = await settleShot('31-shadow')
  await H(() => window.__harness.lighting.shadows(false))
  const unshadowed = await settleShot('31-castShadow-false')
  await H(() => window.__harness.lighting.shadows(true))
  const at = await project(hit)
  const s31 = shadowNear(shadowed, unshadowed, at.x, at.y, 90)
  gate.check('3.1', 'shadow exists: ground where the sun ray lands (30 m AGL, sun 20°) is ≥ 15 % darker than with castShadow = false',
    s31.px >= 150 && s31.darker >= 15 && Math.hypot(s31.x - at.x, s31.y - at.y) <= 20,
    `${s31.px} px, ${s31.darker.toFixed(1)} % darker, centroid ${Math.hypot(s31.x - at.x, s31.y - at.y).toFixed(1)} px from the predicted point`)
  // Same claim seen obliquely — a receiver half-buried in the terrain shows up here as a faint, holed shadow.
  await topDown(hit, 17, 50)
  const oblique = await settleShot('31b-oblique')
  await H(() => window.__harness.lighting.shadows(false))
  const obliqueOff = await settleShot('31b-oblique-off')
  await H(() => window.__harness.lighting.shadows(true))
  const atOblique = await project(hit)
  const s31b = shadowNear(oblique, obliqueOff, atOblique.x, atOblique.y, 70)
  gate.check('3.1b', 'shadow holds at pitch 50 (no burial / spatial z-fight): ≥ 15 % darker at the predicted point', s31b.px >= 60 && s31b.darker >= 15, `${s31b.px} px, ${s31b.darker.toFixed(1)} % darker`)
  report['3.1'] = { top: s31, oblique: s31b }

  // ── 3.2 the shadow tracks the sun ───────────────────────────────────────────────────────────
  await topDown(here, 17)
  const track = []
  for (const sun of [{ azimuthDeg: 135, elevationDeg: 20 }, { azimuthDeg: 225, elevationDeg: 20 }]) {
    await H((s) => window.__harness.lighting.override(s), sun)
    const { without, withCaster } = await withAndWithout(`32-az${sun.azimuthDeg}`, caster)
    const want = await project(await shadowHit(caster, sun))
    track.push({ want, got: shadowNear(withCaster, without, want.x, want.y, 80) })
  }
  const moved = { x: track[1].got.x - track[0].got.x, y: track[1].got.y - track[0].got.y }
  const should = { x: track[1].want.x - track[0].want.x, y: track[1].want.y - track[0].want.y }
  const turn = (Math.acos((moved.x * should.x + moved.y * should.y) / (Math.hypot(moved.x, moved.y) * Math.hypot(should.x, should.y))) * 180) / Math.PI
  gate.check('3.2', 'shadow tracks the sun: azimuth +90° moves the shadow ≥ 20 px, in the geometrically correct direction',
    Math.hypot(moved.x, moved.y) >= 20 && turn <= 10 && Math.abs(Math.hypot(moved.x, moved.y) / Math.hypot(should.x, should.y) - 1) <= 0.15,
    `moved ${Math.hypot(moved.x, moved.y).toFixed(0)} px (predicted ${Math.hypot(should.x, should.y).toFixed(0)} px), ${turn.toFixed(1)}° off the predicted direction`)
  report['3.2'] = { moved, should, turnDeg: turn }

  // ── 3.3 the shadow tracks the terrain ───────────────────────────────────────────────────────
  // Fly a caster across the steepest ground near UAV-01; at each of 10 stations the shadow must sit
  // on the terrain: its unprojected ground elevation has to match the elevation at the predicted hit.
  const sun35 = { azimuthDeg: 135, elevationDeg: 35 }
  await H((s) => window.__harness.lighting.override(s), sun35)
  const slope = await H(([lng, lat]) => {
    const h = window.__harness
    const g = (x, y) => h.terrain.drawnGroundAt(lng + x / 85_000, lat + y / 111_320)
    let best = { rise: 0, bearing: 0 }
    for (let b = 0; b < 360; b += 15) {
      const dx = Math.sin((b * Math.PI) / 180), dy = Math.cos((b * Math.PI) / 180)
      const rise = Math.abs(g(dx * 150, dy * 150) - g(-dx * 150, -dy * 150))
      if (rise > best.rise) best = { rise, bearing: b }
    }
    return best
  }, [here.lng, here.lat])
  const stations = []
  for (let i = 0; i < 10; i++) {
    const along = -135 + i * 30
    const p = { lng: here.lng + (Math.sin((slope.bearing * Math.PI) / 180) * along) / 85_000, lat: here.lat + (Math.cos((slope.bearing * Math.PI) / 180) * along) / 111_320 }
    const c = drone(p, 30, await drawnGround(p))
    const want = await shadowHit(c, sun35)
    await topDown(want, 18)
    const { without, withCaster } = await withAndWithout(i === 0 ? '33-station-0' : undefined, c)
    const wantPx = await project(want)
    const got = shadowNear(withCaster, without, wantPx.x, wantPx.y, 90)
    const seen = await H(([x, y]) => { const m = window.__harness.map; const ll = m.unproject([x, y]); return { lng: ll.lng, lat: ll.lat, elevationM: m.queryTerrainElevation(ll) } }, [got.x, got.y])
    const wantElev = await H(([lng, lat]) => window.__harness.map.queryTerrainElevation([lng, lat]), [want.lng, want.lat])
    stations.push({ i, px: got.px, dElevM: Number(Math.abs(seen.elevationM - wantElev).toFixed(2)),
      dGroundM: Number(Math.hypot((seen.lng - want.lng) * 85_000, (seen.lat - want.lat) * 111_320).toFixed(2)), groundM: Math.round(wantElev) })
  }
  const span = Math.max(...stations.map((s) => s.groundM)) - Math.min(...stations.map((s) => s.groundM))
  gate.check('3.3', 'shadow tracks terrain: across 10 stations over a slope the shadow\'s ground elevation is within 3 m of the predicted hit (and within 4 m on the ground)',
    stations.every((s) => s.px >= 100 && s.dElevM <= 3 && s.dGroundM <= 4) && span >= 15,
    `worst Δelev ${Math.max(...stations.map((s) => s.dElevM))} m, worst Δground ${Math.max(...stations.map((s) => s.dGroundM))} m; stations span ${span} m of relief (slope ${slope.rise.toFixed(0)} m / 300 m)`)
  report['3.3'] = stations

  // ── 3.5 no z-fighting, zoom 12 → 18 ─────────────────────────────────────────────────────────
  await H((list) => window.__harness.fleet.synthetic(list), [caster])
  let flips = 0
  for (const zoom of [12, 13, 14, 15, 16, 17, 18]) {
    await topDown(await shadowHit(caster, sun35) ?? here, zoom, 45)
    await probe.ready()
    const frames = []
    for (let k = 0; k < 3; k++) { await H(() => window.__harness.render.pump(1)); frames.push(decodePng(await probe.shot(k === 0 ? `g3/35-z${zoom}.png` : undefined))) }
    flips += flicker(frames, null).flips
  }
  gate.check('3.5', 'no z-fighting: zoom 12 → 18 at a static pitched camera, no pixel flips value across 3 consecutive frames', flips === 0, `${flips} flipping pixels over 7 zooms`)

  // ── 3.7 budget ──────────────────────────────────────────────────────────────────────────────
  const line = Array.from({ length: 20 }, (_, i) => ({ ...drone({ lng: here.lng, lat: here.lat + (60 + i * 125) / 111_320 }, 120, ground, i % 2 ? 'x10' : 'teal2'), id: `syn-${i}`, headingDeg: i * 18, speedMs: 6, propRpm: 5600 }))
  await H((list) => window.__harness.fleet.synthetic(list), line)
  await topDown(here, 17, 60)
  await probe.ready()
  const before = await H(() => window.__harness.lighting.receiverStats())
  // 300 frames while the camera travels 900 m: the receivers have to rebuild several times.
  await H(async ([lng, lat]) => {
    const h = window.__harness
    for (let i = 0; i < 300; i++) {
      h.camera.set({ center: [lng, lat + (i * 3) / 111_320], zoom: 17, pitch: 60, bearing: 0 })
      await new Promise((r) => requestAnimationFrame(r))
    }
  }, [here.lng, here.lat])
  const after = await H(() => window.__harness.lighting.receiverStats())
  const times = (await H(() => window.__harness.render.layerTimes())).sort((a, b) => a - b)
  p75 = Number(times[Math.floor(times.length * 0.75)].toFixed(3))
  const amortised = (after.rebuildMsTotal - before.rebuildMsTotal) / 300
  gate.check('3.7', 'budget: layer render ≤ 7 ms p75 (20 aircraft, moving camera); receiver regeneration ≤ 1 ms amortised',
    p75 <= 7 && amortised <= 1 && after.rebuilds > before.rebuilds,
    `p75 ${p75} ms; ${after.rebuilds - before.rebuilds} rebuilds, last ${after.lastRebuildMs.toFixed(1)} ms, amortised ${amortised.toFixed(3)} ms/frame`)
  Object.assign(report, { p75LayerMs: p75, receivers: after })

  // ── 3.8 (extra) MapLibre's buildings share depth with the scene ─────────────────────────────
  await loadScenario(BUILDING_SCENARIO_SEED)
  const pickAt = (await H(() => window.__harness.sim.fleet()))[0]
  await topDown(pickAt, 17)
  await probe.ready() // footprints load with the scenario
  const building = await H(() => window.__harness.buildings.pick(4))
  if (!building) throw new Error('no building footprint >= 4 m in the building scenario')
  await topDown(building, 19)
  await probe.ready()
  const baseM = await drawnGround(building)
  const boxPx = []
  for (const dz of [1.5, building.heightM + 2]) {
    await H(([c, z]) => { const h = window.__harness; h.scene.clearTestObjects(); h.scene.addTestBox({ lng: c.lng, lat: c.lat, elevationM: z, sizeM: 2 }) }, [building, baseM + dz])
    const f = await settleShot(`38-box-${dz < 2 ? 'inside' : 'above'}`)
    let n = 0
    for (let i = 0; i < f.data.length; i += 4) if (f.data[i] > 200 && f.data[i + 1] < 70 && f.data[i + 2] > 200) n++
    boxPx.push(n)
  }
  await H(() => window.__harness.scene.clearTestObjects())
  gate.check('3.8', 'MapLibre fill-extrusion buildings occlude scene geometry: a box inside a building is hidden, the same box above its roof shows',
    boxPx[0] === 0 && boxPx[1] >= 100, `inside ${boxPx[0]} px / above the roof ${boxPx[1]} px (${building.heightM} m building)`)

  // ── 3.4 shadows climb buildings (second scenario: it has Overture footprints) ───────────────
  if (!process.argv.includes('--with-buildings')) {
    gate.skip('3.4', 'shadows climb buildings', 'FALLBACK 3 taken for buildings only: stand-ins self-shadow (2 remediation attempts, see PROGRESS.md); building stand-ins ship OFF. Reproduce with --with-buildings')
  } else {
    await H(() => window.__harness.lighting.buildingShadows(true))
    const sun55 = { azimuthDeg: 135, elevationDeg: 55 }
    await H((s) => window.__harness.lighting.override(s), sun55)
    await topDown(building, 19)
    await probe.ready()
    // Park the caster up-sun of the roof so that its shadow, IF it lands on the roof plane, lands on the centroid.
    const clearance = 25
    const back = clearance / Math.tan((sun55.elevationDeg * Math.PI) / 180)
    const over = { lng: building.lng + (Math.sin((sun55.azimuthDeg * Math.PI) / 180) * back) / (111_320 * Math.cos((building.lat * Math.PI) / 180)),
      lat: building.lat + (Math.cos((sun55.azimuthDeg * Math.PI) / 180) * back) / 111_320 }
    const roofCaster = { ...drone(over, 0, baseM + building.heightM + clearance, 'teal2') }
    const { without, withCaster } = await withAndWithout('34-rooftop', roofCaster)
    const onRoof = await project(building) // camera is nadir over the centroid: no parallax between roof and ground here
    const slide = building.heightM / Math.tan((sun55.elevationDeg * Math.PI) / 180) // how much further a GROUND shadow would travel
    const mpp = await H(() => { const m = window.__harness.map; return (40075016.686 * Math.cos((m.getCenter().lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom()) })
    const onGround = { x: onRoof.x - (Math.sin((sun55.azimuthDeg * Math.PI) / 180) * slide) / mpp, y: onRoof.y + (Math.cos((sun55.azimuthDeg * Math.PI) / 180) * slide) / mpp }
    const s34 = shadowNear(withCaster, without, onRoof.x, onRoof.y, 45)
    const toRoof = Math.hypot(s34.x - onRoof.x, s34.y - onRoof.y)
    const toGround = Math.hypot(s34.x - onGround.x, s34.y - onGround.y)
    gate.check('3.4', 'shadows climb buildings: over an Overture footprint the shadow sits where the ROOF plane puts it, not where the ground would',
      s34.px >= 100 && toRoof <= 10 && toGround >= toRoof + 10,
      `${building.heightM} m building (${Math.round(building.areaM2)} m², ${building.onRelief ? 'on drawn relief' : 'on flat map'}): shadow ${toRoof.toFixed(1)} px from the roof prediction, ${toGround.toFixed(1)} px from the ground prediction (they are ${(slide / mpp).toFixed(0)} px apart); ${s34.px} px`)
    report['3.4'] = { building, toRoof, toGround, px: s34.px, receivers: await H(() => window.__harness.lighting.receiverStats()) }
  }

  gate.check('3.X', 'no WebGL / shader console errors all session', probe.consoleErrors(/WebGL|GL_INVALID|shader/i).length === 0, probe.consoleErrors(/WebGL|GL_INVALID|shader/i)[0] ?? '')
} catch (err) {
  gate.check('3.Z', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  await probe?.close()
  server?.stop()
}

try { writeFileSync(resolve(ARTIFACTS, 'g3', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g3/' }))
