// GATE 5 — atmosphere (plan Phase 5): sky at every pitch, fog that answers to visibility data,
// seeded smoke on the sim clock, sun glare as a sprite — and no post-processing pass anywhere.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, ROOT, SCENARIO_SEED } from '../config.mjs'
import { createGate, decodePng, diffMask, horizonRow, meanLuminance, noiseFloorDiff } from '../assert.mjs'
import { openProbe } from '../probe.mjs'
import { startServer } from '../server.mjs'

const gate = createGate('5')
const report = {}
let p75 = 'n/a'
const MAIN_FIRE = { lng: -121.0090, lat: 40.0098 } // train_wildfire_flank › heatSources › hs-dx-main-fire (850 °C, 40 m)
const lum = (f, i) => 0.2126 * f.data[i] + 0.7152 * f.data[i + 1] + 0.0722 * f.data[i + 2]

let server
try {
  server = await startServer({ build: !process.argv.includes('--no-build') })

  const session = async (body) => {
    const probe = await openProbe()
    try {
      const H = (fn, arg) => probe.eval(fn, arg)
      // Views at or past the horizon can stream distant tiles for a long time, and nothing claimed about
      // them depends on those tiles — so only THOSE shots settle for a bounded time. Everything else waits.
      let steepView = false
      const shot = async (name) => {
        if (steepView) await probe.eval((t) => window.__harness.ready(t), 10_000).catch(() => probe.eval(() => window.__harness.render.pump(30)))
        else await probe.ready()
        return decodePng(await probe.shot(name ? `g5/${name}.png` : undefined))
      }
      await probe.ready()
      const loaded = await H((n) => window.__harness.sim.seed(n), SCENARIO_SEED)
      if (!loaded.ok) throw new Error(`sim.seed failed: ${loaded.reason}`)
      await H((t) => window.__harness.sim.freeze(t), FREEZE_AT_SEC)
      await probe.ready()
      const uav = (await H(() => window.__harness.sim.fleet()))[0]
      await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), [uav.lng, uav.lat])
      await probe.ready()
      await H(() => { const h = window.__harness; h.dom.glOnly(true); h.fleet.synthetic([]); h.lighting.beacons(false); h.lighting.override({ azimuthDeg: 160, elevationDeg: 50 }); h.scene.enable() })
      await probe.ready() // the ground model answers 0 until the scene has drawn a frame
      const ground = await H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), [uav.lng, uav.lat])
      if (!(ground > 0)) throw new Error('drawn ground is 0 at UAV-01: relief is not live, every height below would be wrong')
      // MEASURED: jumping straight to an unlocked, pitched camera at a place the map has not shown yet leaves
      // the near field unloaded (raw canvas) for a long time. Arrive with an ordinary camera first.
      let visited = ''
      const view = async (centre, zoom, pitch, bearing) => {
        if (visited !== centre.join()) {
          visited = centre.join()
          await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), centre)
          await probe.ready()
        }
        const elevation = await H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), centre)
        steepView = pitch >= 85
        await H(([c, z, p, b, e]) => window.__harness.camera.set({ center: c, zoom: z, pitch: p, bearing: b, elevation: e, unlock: true }), [centre, zoom, pitch, bearing, elevation])
      }
      // The determinism exhibit: the smoke column, frozen clock, identical history in both launches.
      await view([MAIN_FIRE.lng, MAIN_FIRE.lat], 15.6, 70, 0)
      const exhibit = await shot(`53-smoke-${body ? 'a' : 'b'}`)
      if (body) await body({ probe, H, shot, uav, ground, view })
      return exhibit
    } finally {
      await probe.close()
    }
  }

  const exhibitA = await session(async ({ probe, H, shot, uav, ground, view }) => {
    const here = [uav.lng, uav.lat]

    // ── 5.7 (extra) smoke lives on the SIM clock, and only there ──────────────────────────────
    const smokeStats = await H(() => window.__harness.atmosphere.stats())
    const still1 = await shot('57-frozen-1')
    await new Promise((r) => setTimeout(r, 1500)) // wall time passes; the sim clock does not
    const still2 = await shot('57-frozen-2')
    await H(() => window.__harness.sim.step(3))
    const later = await shot('57-after-3s-of-sim')
    const wallDrift = noiseFloorDiff(still1, still2)
    const simChange = diffMask(later, still1, 8).count
    gate.check('5.7', 'smoke is driven by sim time only: identical across 1.5 s of wall time at a frozen clock, different after 3 s of sim time',
      smokeStats.smokeParticles > 100 && wallDrift <= 0.01 && simChange >= 500, `${smokeStats.smokeParticles} particles; wall-time drift ${wallDrift.toFixed(4)} %, ${simChange} px changed by 3 s of sim`)

    // ── 5.1 sky present at every pitch ────────────────────────────────────────────────────────
    await H(() => window.__harness.atmosphere.smoke(0))
    await H(() => window.__harness.scene.disable())
    await view(here, 15.4, 89, 0)
    const bare = await shot('51-control-no-scene-pitch89')
    const raw = [bare.data[0], bare.data[1], bare.data[2]] // top-left of a frame with no sky installed = raw canvas
    await H(() => window.__harness.scene.enable())
    const isRaw = (r, g, b) => Math.abs(r - raw[0]) <= 3 && Math.abs(g - raw[1]) <= 3 && Math.abs(b - raw[2]) <= 3
    const isSky = (r, g, b) => !isRaw(r, g, b) && b > r + 15
    const skies = []
    for (const pitch of [0, 60, 89, 107]) {
      await view(here, 15.4, Math.min(pitch, 89), 0)
      if (pitch > 90) {
        // Past 90° the camera is BELOW its target. Pitching about a ground-level centre would bury it, so
        // stand an observer 2 m above the ground and aim up at the matching angle instead.
        const up = Math.tan(((pitch - 90) * Math.PI) / 180) * 300
        await H(([c, g, rise]) => window.__harness.camera.fromTo(c, g + 2, [c[0], c[1] + 300 / 111_320], g + 2 + rise, 36.87), [here, ground, up])
      }
      const f = await shot(`51-sky-pitch${pitch}`)
      skies.push({ pitch, actualPitch: Number((await H(() => window.__harness.map.getPitch())).toFixed(1)) })
      const horizon = horizonRow(f, isSky)
      let rawAbove = 0
      for (let y = 0; y < horizon; y++) for (let x = 0; x < f.width; x++) { const i = (y * f.width + x) * 4; if (isRaw(f.data[i], f.data[i + 1], f.data[i + 2])) rawAbove++ }
      Object.assign(skies[skies.length - 1], { horizon, rawAbove })
    }
    const controlRaw = (() => { let n = 0; for (let i = 0; i < bare.width * 60 * 4; i += 4) if (isRaw(bare.data[i], bare.data[i + 1], bare.data[i + 2])) n++; return n })()
    gate.check('5.1', 'sky present at all pitches (0 / 60 / 89 / 107): zero raw-canvas pixels above the horizon — and sky really is in view at 89 and 107',
      skies.every((s) => s.rawAbove === 0 && Math.abs(s.actualPitch - s.pitch) <= 1.5) && skies[2].horizon > 60 && skies[3].horizon > 200 && controlRaw > 1000,
      skies.map((s) => `pitch ${s.actualPitch}: horizon row ${s.horizon}, ${s.rawAbove} raw px`).join('; ') + `; control (no scene, pitch 89): ${controlRaw} raw-canvas px in the top 60 rows, rgb ${raw.join(',')}`)
    report['5.1'] = { skies, raw, controlRaw }

    // ── 5.2 fog answers to the visibility data ────────────────────────────────────────────────
    await view(here, 15.2, 80, 0)
    const contrastOf = (f, y0, y1) => { let s = 0, s2 = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < f.width; x++) { const v = lum(f, (y * f.width + x) * 4); s += v; s2 += v * v; n++ } return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) }
    await H(() => window.__harness.atmosphere.visibilityKm(20))
    const clear = await shot('52-visibility-20km')
    const h20 = horizonRow(clear, isSky)
    await H(() => window.__harness.atmosphere.visibilityKm(2))
    const murky = await shot('52-visibility-2km')
    const fogStats = await H(() => window.__harness.atmosphere.stats())
    await H(() => window.__harness.atmosphere.visibilityKm(null))
    const band = [h20 + 6, Math.min(clear.height, h20 + 110)] // the distant ground, just under the horizon
    const c20 = contrastOf(clear, ...band), c2 = contrastOf(murky, ...band)
    gate.check('5.2', 'fog responds to data: visibility 2 km vs 20 km changes the contrast of the distant ground by ≥ 20 %',
      c20 > 0 && Math.abs(c20 - c2) / c20 >= 0.2 && c2 < c20, `luminance σ in rows ${band[0]}–${band[1]}: ${c20.toFixed(2)} at 20 km → ${c2.toFixed(2)} at 2 km (${(100 * (c20 - c2) / c20).toFixed(0)} % lower); three.js fog density at 2 km ${fogStats.fogDensity.toExponential(2)}`)
    report['5.2'] = { c20, c2, band }

    // ── 5.6 (extra) glare: a sprite where the sun is, nothing when the sun is behind you ─────
    await H(() => window.__harness.lighting.override({ azimuthDeg: 0, elevationDeg: 12 }))
    await view(here, 15.2, 84, 0)
    const glareOn = await shot('56-glare-on')
    const towardSun = await H(() => window.__harness.atmosphere.stats())
    await H(() => window.__harness.atmosphere.glare(false))
    const glareOff = await shot('56-glare-off')
    await H(() => window.__harness.atmosphere.glare(true))
    await view(here, 15.2, 84, 180)
    await shot('56-sun-behind')
    const awayFromSun = await H(() => window.__harness.atmosphere.stats())
    const upper = { x: 0, y: 0, w: glareOn.width, h: Math.floor(glareOn.height / 2) }
    const lift = meanLuminance(glareOn, upper) - meanLuminance(glareOff, upper)
    gate.check('5.6', 'sun glare is a sprite at the sun: brightens the sky when looking sunward, absent with the sun behind the camera',
      towardSun.glareVisible && !awayFromSun.glareVisible && lift > 0 && diffMask(glareOn, glareOff, 6).count > 2000, `+${lift.toFixed(2)} luminance over the upper half, ${diffMask(glareOn, glareOff, 6).count} px touched; sunward=${towardSun.glareVisible} away=${awayFromSun.glareVisible}`)

    // ── 5.5 budget with smoke active ──────────────────────────────────────────────────────────
    await H(() => { const h = window.__harness; h.atmosphere.smoke(1); h.lighting.override({ azimuthDeg: 160, elevationDeg: 50 }) })
    const line = Array.from({ length: 20 }, (_, i) => ({ id: `syn-${i}`, airframe: i % 2 ? 'x10' : 'teal2', lng: MAIN_FIRE.lng + ((i % 5) * 50 - 100) / 85_000, lat: MAIN_FIRE.lat - (100 + i * 60) / 111_320,
      elevationM: ground + 120, headingDeg: i * 18, speedMs: 6, propRpm: 5600, gimbalYawDeg: 0, gimbalPitchDeg: -25, color: '#00e5ff' }))
    await H((list) => window.__harness.fleet.synthetic(list), line)
    await view([MAIN_FIRE.lng, MAIN_FIRE.lat], 15.6, 70, 0)
    await H(() => window.__harness.render.pump(10))
    const skyBefore = (await H(() => window.__harness.atmosphere.stats())).skyWrites
    await H(async () => { const h = window.__harness; for (let i = 0; i < 330; i++) { if (i % 3 === 0) h.sim.step(0.05); h.map.triggerRepaint(); await new Promise((r) => requestAnimationFrame(r)) } })
    const times = (await H(() => window.__harness.render.layerTimes())).sort((a, b) => a - b)
    p75 = Number(times[Math.floor(times.length * 0.75)].toFixed(3))
    const live = await H(() => window.__harness.atmosphere.stats())
    await shot('55-smoke-and-fleet')
    // map.setSky() dirties the style; if it ran per frame the map would never report loaded().
    gate.check('5.5', 'budget: layer render ≤ 8 ms p75 with smoke active (20 aircraft, sim ticking); the sky is not rewritten per frame',
      p75 <= 8 && live.smokeParticles > 100 && live.skyWrites - skyBefore <= 1, `p75 ${p75} ms with ${live.smokeParticles} smoke particles; ${live.skyWrites - skyBefore} setSky() calls in 330 frames`)
    gate.check('5.X', 'no WebGL / shader console errors all session', probe.consoleErrors(/WebGL|GL_INVALID|shader/i).length === 0, probe.consoleErrors(/WebGL|GL_INVALID|shader/i)[0] ?? '')
    Object.assign(report, { p75LayerMs: p75, smoke: live })
  })

  // ── 5.3 smoke is deterministic across launches ──────────────────────────────────────────────
  const exhibitB = await session(null)
  const drift = noiseFloorDiff(exhibitA, exhibitB)
  gate.check('5.3', 'smoke deterministic: same seed + frozen clock, two separate browser launches, within the noise floor (0 %)', drift <= 0.01, `diff ${drift.toFixed(4)} % of pixels`)
} catch (err) {
  gate.check('5.Z', 'gate ran to completion', false, err.message.split('\n')[0])
  console.error(err)
} finally {
  server?.stop()
}

// ── 5.4 no post-processing pass was added ─────────────────────────────────────────────────────
const offenders = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.(ts|tsx|js|mjs)$/.test(name) && /EffectComposer|postprocessing/.test(readFileSync(path, 'utf8'))) offenders.push(path) } }
walk(resolve(ROOT, 'src'))
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /postprocessing|effect-?composer/i.test(d))
gate.check('5.4', 'no post pass added: no EffectComposer / postprocessing import anywhere in src/, none in package.json', offenders.length === 0 && deps.length === 0, [...offenders, ...deps].join(', '))

try { writeFileSync(resolve(ARTIFACTS, 'g5', 'probe.json'), JSON.stringify(report, null, 2)) } catch { /* gate died before its first shot */ }
process.exit(gate.finish({ p75LayerMs: p75, artifacts: 'artifacts/g5/' }))
