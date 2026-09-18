// The 72-cell verification matrix (plan Phase 6):
//   {1, 5, 20 aircraft} × {dawn, noon, dusk, night} × {ground, orbit, FPV} × {terrain on, off}
// (The plan lists three suns but counts 72 cells; 3·3·3·2 is 54. Four suns — the same four Gate 2 uses and
// the app's own timeOfDay values — is the reading under which its number is right, and it is a superset.)
// Every cell gets a screenshot, a probe JSON, and TWO frame-time measurements at the same camera —
// with the 3D layer mounted and with it removed — so what the layer ADDS is separable from what the
// map costs on its own. Output: artifacts/review/ (cells/*.png, cells/*.json, index.html contact sheet).
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ARTIFACTS, FREEZE_AT_SEC, SCENARIO_SEED } from './config.mjs'
import { openProbe } from './probe.mjs'

const COUNTS = [1, 5, 20]
const SUNS = { dawn: { azimuthDeg: 80, elevationDeg: 5 }, noon: { azimuthDeg: 180, elevationDeg: 60 }, dusk: { azimuthDeg: 280, elevationDeg: 5 }, night: { azimuthDeg: 310, elevationDeg: -10 } }
const CAMERAS = ['GROUND', 'ORBIT', 'FPV']
const FRAMES = 90
export const REVIEW_DIR = resolve(ARTIFACTS, 'review')

const p75 = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.75)] : NaN }

export async function runMatrix({ tier = 'balanced', log = console.log } = {}) {
  mkdirSync(resolve(REVIEW_DIR, 'cells'), { recursive: true })
  const probe = await openProbe()
  const cells = []
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
    await H((t) => { const h = window.__harness; h.dom.glOnly(true); h.scene.enable(); h.quality.tier(t) }, tier)
    await probe.ready()

    // Frame time = rAF-to-rAF with a repaint forced every frame, at a camera that is not moving.
    const measure = () => H(async (n) => {
      const h = window.__harness
      const deltas = []
      let last = performance.now()
      for (let i = 0; i < n + 10; i++) {
        h.map.triggerRepaint()
        await new Promise((r) => requestAnimationFrame(r))
        const now = performance.now()
        if (i >= 10) deltas.push(now - last) // first frames after a change are warm-up
        last = now
      }
      return { deltas, layer: h.render.layerTimes().slice(-n) }
    }, FRAMES)

    for (const terrain of ['on', 'off']) {
      if (terrain === 'off') await H(() => window.__harness.terrain.disable()) // one-way per page on maplibre 6.9 — hence last
      for (const count of COUNTS) {
        for (const [sunName, sun] of Object.entries(SUNS)) {
          for (const camera of CAMERAS) {
            const name = `${String(cells.length + 1).padStart(2, '0')}-${count}ac-${sunName}-${camera.toLowerCase()}-terrain-${terrain}`
            await H(() => window.__harness.camera.mode('TACTICAL'))
            await H((c) => window.__harness.camera.set({ center: c, zoom: 16, pitch: 0, bearing: 0 }), [uav.lng, uav.lat])
            await H(() => window.__harness.render.pump(3)) // the ground model re-reads the map each frame
            const ground = await H(([lng, lat]) => window.__harness.terrain.drawnGroundAt(lng, lat), [uav.lng, uav.lat])
            const fleet = Array.from({ length: count }, (_, i) => {
              const ring = i === 0 ? 0 : 50 + 12 * i, bearing = (i * 137.5 * Math.PI) / 180 // golden-angle scatter
              return { id: `syn-${i}`, airframe: i % 2 ? 'x10' : 'teal2', lng: uav.lng + (Math.sin(bearing) * ring) / 85_000, lat: uav.lat + (Math.cos(bearing) * ring) / 111_320,
                elevationM: ground + 40 + (i % 4) * 18, headingDeg: (i * 47) % 360, speedMs: i ? 5 : 0, propRpm: 5400, gimbalYawDeg: 0, gimbalPitchDeg: -35, color: ['#00e5ff', '#ffb300', '#7cff6b', '#ff5ea8'][i % 4] }
            })
            await H(([list, s]) => { const h = window.__harness; h.fleet.synthetic(list); h.lighting.override(s); h.camera.follow('syn-0'); h.atmosphere.enable(true) }, [fleet, sun])
            await H((m) => { const h = window.__harness; h.camera.mode(m); for (let i = 0; i < 240; i++) h.camera.advance(0.05) }, camera)
            await H((t) => window.__harness.ready(t), 4_000).catch(() => H(() => window.__harness.render.pump(20)))

            const on = await measure()
            const png = await probe.shot(`review/cells/${name}.png`)
            const stats = await H(() => { const h = window.__harness; return { info: h.render.info(), bands: h.fleet.stats()?.bands, atmosphere: h.atmosphere.stats(), quality: h.quality.state(), pitch: h.map.getPitch(), zoom: h.map.getZoom() } })
            await H(() => window.__harness.quality.mounted(false))
            const off = await measure()
            await H(() => window.__harness.quality.mounted(true))

            const cell = { name, count, sun: sunName, camera, terrain, frameMsP75: Number(p75(on.deltas).toFixed(2)), baselineFrameMsP75: Number(p75(off.deltas).toFixed(2)),
              layerMsP75: Number(p75(on.layer).toFixed(3)), pngBytes: png.length, ...stats }
            cell.addedMs = Number((cell.frameMsP75 - cell.baselineFrameMsP75).toFixed(2))
            cells.push(cell)
            writeFileSync(resolve(REVIEW_DIR, 'cells', `${name}.json`), JSON.stringify(cell, null, 2))
            log(`  cell ${name}: frame ${cell.frameMsP75} ms (map alone ${cell.baselineFrameMsP75}, layer render ${cell.layerMsP75}) rung ${stats.quality.rungName}`)
          }
        }
      }
    }
  } finally {
    await probe.close()
  }

  const rows = cells.map((c) => `<figure><a href="cells/${c.name}.png"><img loading="lazy" src="cells/${c.name}.png" alt="${c.name}"></a>`
    + `<figcaption><b>${c.count} ac · ${c.sun} · ${c.camera} · terrain ${c.terrain}</b><br>frame ${c.frameMsP75} ms · map alone ${c.baselineFrameMsP75} ms · layer ${c.layerMsP75} ms · ${c.quality.rungName}</figcaption></figure>`).join('\n')
  writeFileSync(resolve(REVIEW_DIR, 'index.html'), `<!doctype html><meta charset="utf-8"><title>3D scene layer — review matrix</title>
<style>body{font:13px system-ui;margin:16px;background:#11151a;color:#dde3ea}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
figure{margin:0;background:#1a2028;border-radius:6px;overflow:hidden}img{width:100%;display:block}figcaption{padding:8px 10px;line-height:1.45}h1{font-size:18px}p{max-width:80ch;color:#9fb0c0}</style>
<h1>3D scene layer — ${cells.length}-cell review matrix (quality: ${tier})</h1>
<p>What the gates cannot judge is here: light colour, fog density, material response, camera framing. Frame times are rAF-to-rAF p75 at a static camera;
"map alone" is the same view with the 3D layer removed. Generated by <code>harness/matrix.mjs</code>.</p><main>
${rows}
</main>`)
  writeFileSync(resolve(REVIEW_DIR, 'matrix.json'), JSON.stringify(cells, null, 2))
  return cells
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'matrix.mjs')) {
  const { startServer } = await import('./server.mjs')
  const server = await startServer({ build: !process.argv.includes('--no-build') })
  try { await runMatrix() } finally { server.stop() }
}
