// GATE 2 — solar-driven lighting (plan Phase 2). Property-based: 2.1 holds the solar algorithm to
// an INDEPENDENT reference, and every other assertion is judged against that anchor.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, diffMask, meanLuminance, noiseFloorDiff } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('2')
const report = {}
let p75 = 'n/a'

// Independent reference — harness/reference/solar_reference.py (PSA algorithm, Python; geometric).
// That script itself reproduces NREL SPA's published worked example to 0.001° az / 0.001° el.
const SOLAR_REFERENCE = [
  { tag: 'dawn', utc: '2021-08-05T13:40:00Z', lat: 40.0072, lng: -121.0085, azimuthDeg: 72.355, elevationDeg: 5.171 },
  { tag: 'noon', utc: '2021-08-05T20:10:00Z', lat: 40.0072, lng: -121.0085, azimuthDeg: 180.010, elevationDeg: 66.728 },
  { tag: 'dusk', utc: '2021-08-06T02:40:00Z', lat: 40.0072, lng: -121.0085, azimuthDeg: 287.536, elevationDeg: 5.069 },
  { tag: 'night', utc: '2021-08-06T09:00:00Z', lat: 40.0072, lng: -121.0085, azimuthDeg: 14.214, elevationDeg: -32.216 },
  // Published: Reda & Andreas, NREL/TP-560-34302 (2004) worked example — topocentric, refraction included.
  { tag: 'NREL-SPA-published', utc: '2003-10-17T19:30:30Z', lat: 39.742476, lng: -105.1786, azimuthDeg: 194.340, elevationDeg: 39.888 },
]
// The four sun angles the plan names.
const SUNS = [
  { tag: 'dawn', azimuthDeg: 80, elevationDeg: 5 },
  { tag: 'noon', azimuthDeg: 180, elevationDeg: 60 },
  { tag: 'dusk', azimuthDeg: 280, elevationDeg: 5 },
  { tag: 'night', azimuthDeg: 310, elevationDeg: -10 },
]
const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180)

let server
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })

  /** One cold browser launch, set up identically every time. */
  const session = async (body) => {
    const probe = await openProbe()
    try {
      const H = (fn, arg) => probe.eval(fn, arg)
      await probe.ready()
      const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
      if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
      await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
      await probe.ready()
      const uav = (await H(() => window.__harness.sim.fleet()))[0]
      await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), [uav.lng, uav.lat])
      await probe.ready()
      const ground = await H((c) => window.__harness.map.queryTerrainElevation(c), [uav.lng, uav.lat])
      await H(() => { const h = window.__harness; h.dom.glOnly(true); h.fleet.synthetic([]); h.scene.enable() })
      const drone = (id, airframe, extra = {}) => ({ id, airframe, lng: uav.lng, lat: uav.lat, elevationM: ground + 60, headingDeg: 30, speedMs: 0,
        propRpm: 5200, gimbalYawDeg: 0, gimbalPitchDeg: -25, color: '#00e5ff', ...extra })
      const look = (target, distanceM, elevAngleDeg, bearingDeg) => {
        const flat = distanceM * Math.cos((elevAngleDeg * Math.PI) / 180)
        const cam = {
          lng: target.lng + (Math.sin((bearingDeg * Math.PI) / 180) * flat) / (111_320 * Math.cos((target.lat * Math.PI) / 180)),
          lat: target.lat + (Math.cos((bearingDeg * Math.PI) / 180) * flat) / 111_320,
          alt: target.elevationM - distanceM * Math.sin((elevAngleDeg * Math.PI) / 180),
        }
        return H(([c, t]) => window.__harness.camera.fromTo([c.lng, c.lat], c.alt, [t.lng, t.lat], t.elevationM, 36.87), [cam, target])
      }
      const settleShot = async (name) => { await probe.ready(); return decodePng(await probe.shot(`g2/${name}.png`)) }
      // The one frame both launches take after an identical history — the determinism exhibit.
      const subject = drone('subject', 'x10')
      await look(subject, 32, -30, 140)
      await H(([list, sun]) => { const h = window.__harness; h.fleet.synthetic(list); h.lighting.override(sun) }, [[subject], SUNS[2]])
      const exhibit = await settleShot(`25-determinism-${body ? 'a' : 'b'}`)
      if (body) await body({ probe, H, uav, ground, drone, look, settleShot, subject })
      return exhibit
    } finally {
      await probe.close()
    }
  }

  const exhibitA = await session(async ({ probe, H, uav, ground, drone, look, settleShot, subject }) => {
    // ── 2.1 sun position — the non-circular anchor ────────────────────────────────────────────
    const solar = []
    for (const ref of SOLAR_REFERENCE) {
      const got = await H(([ms, lat, lng]) => window.__harness.lighting.sunPosition(ms, lat, lng), [Date.parse(ref.utc), ref.lat, ref.lng])
      solar.push({ tag: ref.tag, dAz: Number(angleGap(got.azimuthDeg, ref.azimuthDeg).toFixed(3)), dEl: Number(Math.abs(got.elevationDeg - ref.elevationDeg).toFixed(3)) })
    }
    gate.check('2.1', 'sun position within 0.5° (azimuth and elevation) of an independent reference at 4 AOI timestamps + NREL\'s published example',
      solar.every((s) => s.dAz <= 0.5 && s.dEl <= 0.5), solar.map((s) => `${s.tag} Δaz ${s.dAz} Δel ${s.dEl}`).join('; '))
    report['2.1'] = solar

    // ── 2.9 (extra) the SCENARIO clock, not an override, drives the sun ───────────────────────
    const byVariant = {}
    for (const tod of ['dawn', 'day', 'dusk', 'night']) {
      await H((v) => { const h = window.__harness; h.lighting.override(null); h.lighting.timeOfDay(v) }, tod)
      await H(() => window.__harness.render.pump(2))
      byVariant[tod] = (await H(() => window.__harness.lighting.stats())).sun
    }
    gate.check('2.9', 'scenario time-of-day drives the sun: dawn low in the east, day high, dusk low in the west, night below the horizon',
      Math.abs(byVariant.dawn.elevationDeg - 5) < 1.5 && byVariant.dawn.azimuthDeg < 180 && byVariant.day.elevationDeg > 30
        && Math.abs(byVariant.dusk.elevationDeg - 5) < 1.5 && byVariant.dusk.azimuthDeg > 180 && byVariant.night.elevationDeg < -12,
      Object.entries(byVariant).map(([k, v]) => `${k} az ${v.azimuthDeg.toFixed(0)} el ${v.elevationDeg.toFixed(1)}`).join('; '))
    await H(() => window.__harness.lighting.timeOfDay('day'))

    // ── 2.8 (extra) shadow + environment passes bind other framebuffers: MapLibre must not notice ─
    await H((sun) => { const h = window.__harness; h.fleet.synthetic([]); h.lighting.override(sun) }, SUNS[1])
    await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 45, bearing: 20 }), [uav.lng, uav.lat])
    const litEmpty = await settleShot('28-lit-empty-scene')
    await H(() => window.__harness.scene.disable())
    const unmounted = await settleShot('28-unmounted')
    await H(() => window.__harness.scene.enable())
    const bleed = noiseFloorDiff(unmounted, litEmpty)
    gate.check('2.8', 'no GL state bleed from the shadow / PMREM passes: a lit but empty scene leaves the map frame untouched', bleed <= 0.01, `diff ${bleed.toFixed(4)} %`)

    // ── 2.2 light direction follows the sun ───────────────────────────────────────────────────
    const ball = { lng: uav.lng, lat: uav.lat, elevationM: ground + 80, radiusM: 6 }
    await H(([c, e]) => window.__harness.camera.set({ center: c, zoom: 20, pitch: 0, bearing: 0, elevation: e, unlock: true }), [[uav.lng, uav.lat], ball.elevationM])
    const noBall = await settleShot('22-no-sphere')
    await H((b) => window.__harness.scene.addTestSphere(b), ball)
    const directions = []
    for (const sun of SUNS) {
      await H((s) => window.__harness.lighting.override(s), sun)
      const frame = await settleShot(`22-sphere-${sun.tag}`)
      const mask = diffMask(frame, noBall, 6)
      let n = 0, cx = 0, cy = 0, floor = 255
      const lum = (i) => 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2]
      for (let i = 0; i < mask.data.length; i += 4) if (mask.data[i]) { n++; cx += (i / 4) % frame.width; cy += Math.floor(i / 4 / frame.width); floor = Math.min(floor, lum(i)) }
      cx /= n; cy /= n
      let w = 0, bx = 0, by = 0
      for (let i = 0; i < mask.data.length; i += 4) if (mask.data[i]) { const k = (lum(i) - floor) ** 2; w += k; bx += k * ((i / 4) % frame.width); by += k * Math.floor(i / 4 / frame.width) }
      // Camera is nadir, north-up: screen +x is east, screen −y is north.
      const brightAz = (Math.atan2(bx / w - cx, -(by / w - cy)) * 180) / Math.PI
      directions.push({ tag: sun.tag, sunAz: sun.azimuthDeg, brightAz: Number(((brightAz + 360) % 360).toFixed(1)), gap: Number(angleGap(brightAz, sun.azimuthDeg).toFixed(1)), px: n })
    }
    gate.check('2.2', 'light direction follows the sun: the bright side of a matte sphere faces the sun azimuth ± 10° at all 4 angles',
      directions.every((d) => d.gap <= 10 && d.px > 2000), directions.map((d) => `${d.tag} sun ${d.sunAz}° bright ${d.brightAz}° (Δ${d.gap})`).join('; '))
    report['2.2'] = directions
    await H(() => window.__harness.scene.clearTestObjects())

    // ── 2.3 night is dark, not black ──────────────────────────────────────────────────────────
    await H(() => window.__harness.lighting.beacons(false)) // measure SURFACES, not lamps
    await look(subject, 32, -30, 140)
    await H((s) => { const h = window.__harness; h.fleet.synthetic([]); h.lighting.override(s) }, SUNS[1])
    const noonEmpty = await settleShot('23-noon-empty')
    await H((list) => window.__harness.fleet.synthetic(list), [subject])
    const noon = await settleShot('23-noon')
    await H((s) => window.__harness.lighting.override(s), SUNS[3])
    const night = await settleShot('23-night')
    const hull = diffMask(noon, noonEmpty, 24)
    const meanOver = (frame) => { let s = 0, n = 0; for (let i = 0; i < hull.data.length; i += 4) if (hull.data[i]) { s += 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2]; n++ } return s / n }
    const ratio = meanOver(night) / meanOver(noon)
    gate.check('2.3', 'night is dark, not black: mean airframe luminance at night is > 2 % and < 20 % of noon', ratio > 0.02 && ratio < 0.2 && hull.count > 1500,
      `night ${meanOver(night).toFixed(2)} / noon ${meanOver(noon).toFixed(2)} = ${(ratio * 100).toFixed(1)} % over ${hull.count} px`)
    await H(() => window.__harness.lighting.beacons(true))

    // ── 2.4 strobe cycles at 1 Hz on the SIM clock ────────────────────────────────────────────
    await H(([c, e]) => window.__harness.camera.set({ center: c, zoom: 22, pitch: 0, bearing: 0, elevation: e, unlock: true }), [[subject.lng, subject.lat], subject.elevationM])
    await probe.ready()
    const roi = { x: Math.round(noon.width / 2) - 110, y: Math.round(noon.height / 2) - 110, w: 220, h: 220 }
    const series = []
    for (let i = 0; i < 40; i++) { // 40 × 50 ms = 2 s of sim time
      await H(() => { window.__harness.sim.step(0.05); return window.__harness.render.pump(2) })
      series.push(meanLuminance(decodePng(await probe.shot(i === 0 ? 'g2/24-strobe-first.png' : undefined)), roi))
    }
    const mid = (Math.min(...series) + Math.max(...series)) / 2
    const flashes = series.filter((v, i) => i > 0 && series[i - 1] < mid && v >= mid).length
    gate.check('2.4', 'strobe cycles: over 2 s of sim time the strobe region rises through its mid-luminance exactly 2 times (1 Hz)',
      flashes === 2 && Math.max(...series) - Math.min(...series) > 1, `${flashes} flashes; luminance ${Math.min(...series).toFixed(2)}–${Math.max(...series).toFixed(2)}`)
    report['2.4'] = series.map((v) => Number(v.toFixed(2)))

    // ── 2.6 no per-frame PMREM ────────────────────────────────────────────────────────────────
    const before = (await H(() => window.__harness.lighting.stats())).pmremPasses
    await H(() => window.__harness.render.pump(300))
    const after = (await H(() => window.__harness.lighting.stats())).pmremPasses
    await H((s) => window.__harness.lighting.override(s), SUNS[0])
    await H(() => window.__harness.render.pump(3))
    const afterMove = (await H(() => window.__harness.lighting.stats())).pmremPasses
    gate.check('2.6', 'no per-frame PMREM: 0 environment rebuilds over 300 frames at a fixed sun (and exactly 1 when the sun then moves)',
      after - before === 0 && afterMove - after === 1 && before > 0, `${after - before} rebuilds in 300 frames; +${afterMove - after} on a sun move; ${afterMove} total this session`)

    // ── 2.7 budget ────────────────────────────────────────────────────────────────────────────
    const line = Array.from({ length: 20 }, (_, i) => drone(`syn-${i}`, i % 2 ? 'x10' : 'teal2',
      { lat: uav.lat + (60 + i * 125) / 111_320, elevationM: ground + 120, headingDeg: i * 18, speedMs: 6, propRpm: 5600 }))
    await H(([list, s]) => { const h = window.__harness; h.fleet.synthetic(list); h.lighting.override(s) }, [line, SUNS[1]])
    const eye = { lng: uav.lng, lat: uav.lat - 60 / 111_320, alt: ground + 150 }
    await H(([c, t]) => window.__harness.camera.fromTo([c.lng, c.lat], c.alt, [t.lng, t.lat], t.elevationM, 36.87), [eye, line[8]])
    await probe.ready()
    await H(() => window.__harness.render.pump(320))
    const times = (await H(() => window.__harness.render.layerTimes())).sort((a, b) => a - b)
    p75 = Number(times[Math.floor(times.length * 0.75)].toFixed(3))
    const info = await H(() => window.__harness.render.info())
    await settleShot('27-twenty-aircraft-lit')
    gate.check('2.7', 'budget: lighting + shadows, 20 aircraft, layer render ≤ 5 ms p75', p75 <= 5, `p75 ${p75} ms; ${info.calls} draw calls (incl. shadow pass)`)
    gate.check('2.X', 'no WebGL / shader console errors all session', probe.consoleErrors(/WebGL|GL_INVALID|shader/i).length === 0, probe.consoleErrors(/WebGL|GL_INVALID|shader/i)[0] ?? '')
    Object.assign(report, { p75LayerMs: p75, info, sunByVariant: byVariant })
  })

  // ── 2.5 determinism: a second cold launch, identical history, the same lit frame ────────────
  const exhibitB = await session(null)
  const drift = noiseFloorDiff(exhibitA, exhibitB)
  gate.check('2.5', 'determinism: same seed + frozen clock + same sun → the lit frame matches across two separate browser launches (noise floor 0 %)',
    drift <= 0.01, `diff ${drift.toFixed(4)} % of pixels`)
} catch (err) {
  gate.check('2.Z', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  server?.stop()
}

try { writeFileSync(resolve(ARTIFACTS, 'g2', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g2/' }))
