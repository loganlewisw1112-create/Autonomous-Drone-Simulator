// Assertion primitives every gate is written in (plan Part 4). Pixel assertions are PROPERTY
// based — each states a claim about the image that fails on wrongness, not merely on change.
// Goldens exist only as regression tripwires, captured after a property assertion has passed.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { ROOT } from './config.mjs'

// ── PNG decode (8-bit RGB/RGBA, non-interlaced — what Chromium screenshots are). Inline so the
//    harness adds no dependency beyond @playwright/test. ────────────────────────────────────────
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0, height = 0, channels = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const colourType = data[9]
      if (data[8] !== 8 || (colourType !== 2 && colourType !== 6) || data[12] !== 0) {
        throw new Error(`unsupported PNG: depth=${data[8]} colour=${colourType} interlace=${data[12]}`)
      }
      channels = colourType === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = new Uint8Array(width * height * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let add = 0
      if (filter === 1) add = a
      else if (filter === 2) add = b
      else if (filter === 3) add = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = (line[i] + add) & 255
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4
      rgba[d] = line[s]; rgba[d + 1] = line[s + 1]; rgba[d + 2] = line[s + 2]
      rgba[d + 3] = channels === 4 ? line[s + 3] : 255
    }
    prev = line
  }
  return { width, height, data: rgba }
}

const asFrame = (f) => (Buffer.isBuffer(f) ? decodePng(f) : f)
const fullRoi = (frame) => ({ x: 0, y: 0, w: frame.width, h: frame.height })
const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]

function eachPixel(frame, roi, visit) {
  const r = roi ?? fullRoi(frame)
  const x1 = Math.min(frame.width, r.x + r.w), y1 = Math.min(frame.height, r.y + r.h)
  for (let y = Math.max(0, r.y); y < y1; y++) {
    for (let x = Math.max(0, r.x); x < x1; x++) visit((y * frame.width + x) * 4, x, y)
  }
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** Pixels within `tolerance` (per channel) of `rgb`. Presence / absence claims. */
export function colourCount(frame, roi, [r, g, b], tolerance = 0) {
  const f = asFrame(frame)
  let count = 0
  eachPixel(f, roi, (i) => {
    if (Math.abs(f.data[i] - r) <= tolerance && Math.abs(f.data[i + 1] - g) <= tolerance
      && Math.abs(f.data[i + 2] - b) <= tolerance) count++
  })
  return count
}

export function meanLuminance(frame, roi) {
  const f = asFrame(frame)
  let sum = 0, n = 0
  eachPixel(f, roi, (i) => { sum += luma(f.data, i); n++ })
  return n ? sum / n : 0
}

/** Signed % change in mean luminance of `roi` from frameA to frameB. Shadows, fog, night. */
export function luminanceDelta(roi, frameA, frameB) {
  const a = meanLuminance(frameA, roi)
  return a === 0 ? 0 : ((meanLuminance(frameB, roi) - a) / a) * 100
}

/** Centroid of pixels satisfying `predicate(r, g, b)`; null when none match. */
export function centroid(frame, roi, predicate) {
  const f = asFrame(frame)
  let sx = 0, sy = 0, n = 0
  eachPixel(f, roi, (i, x, y) => {
    if (predicate(f.data[i], f.data[i + 1], f.data[i + 2])) { sx += x; sy += y; n++ }
  })
  return n ? { x: sx / n, y: sy / n, count: n } : null
}

/** White-on-black mask of every pixel that differs from `background` — how a silhouette is lifted
 *  off a busy map without knowing the subject's colours. */
export function diffMask(frame, background, tolerance = 24) {
  const f = asFrame(frame), b = asFrame(background)
  const data = new Uint8Array(f.data.length)
  let count = 0
  for (let i = 0; i < f.data.length; i += 4) {
    const on = Math.abs(f.data[i] - b.data[i]) > tolerance || Math.abs(f.data[i + 1] - b.data[i + 1]) > tolerance
      || Math.abs(f.data[i + 2] - b.data[i + 2]) > tolerance
    data[i] = data[i + 1] = data[i + 2] = on ? 255 : 0
    data[i + 3] = 255
    if (on) count++
  }
  return { width: f.width, height: f.height, data, count }
}

/** IoU of two binary silhouettes, each defined by `predicate`. Airframe differentiation, LOD. */
export function silhouetteIoU(frameA, frameB, predicate, roi) {
  const a = asFrame(frameA), b = asFrame(frameB)
  let inter = 0, union = 0
  eachPixel(a, roi, (i) => {
    const inA = predicate(a.data[i], a.data[i + 1], a.data[i + 2])
    const inB = predicate(b.data[i], b.data[i + 1], b.data[i + 2])
    if (inA && inB) inter++
    if (inA || inB) union++
  })
  return union ? inter / union : 1
}

/** First row (from the top) where a majority of pixels stop matching `isSky`. */
export function horizonRow(frame, isSky) {
  const f = asFrame(frame)
  for (let y = 0; y < f.height; y++) {
    let sky = 0
    for (let x = 0; x < f.width; x++) {
      const i = (y * f.width + x) * 4
      if (isSky(f.data[i], f.data[i + 1], f.data[i + 2])) sky++
    }
    if (sky < f.width / 2) return y
  }
  return f.height
}

/** True when any pixel in `roi` flips A→B→A across three consecutive frames. Z-fighting. */
export function flicker(frames, roi, tolerance = 2) {
  const fs = frames.map(asFrame)
  let flips = 0
  for (let k = 0; k + 2 < fs.length; k++) {
    eachPixel(fs[k], roi, (i) => {
      const d01 = Math.abs(luma(fs[k].data, i) - luma(fs[k + 1].data, i))
      const d02 = Math.abs(luma(fs[k].data, i) - luma(fs[k + 2].data, i))
      if (d01 > tolerance && d02 <= tolerance) flips++
    })
  }
  return { flickers: flips > 0, flips }
}

/** % of pixels differing by more than `tolerance` in any channel. Determinism, kill-switch. */
export function noiseFloorDiff(frameA, frameB, roi, tolerance = 0) {
  const a = asFrame(frameA), b = asFrame(frameB)
  if (a.width !== b.width || a.height !== b.height) return 100
  let differing = 0, n = 0
  eachPixel(a, roi, (i) => {
    n++
    if (Math.abs(a.data[i] - b.data[i]) > tolerance || Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance
      || Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance) differing++
  })
  return n ? (differing / n) * 100 : 0
}

// ── Regression tripwires. Never the primary check. ──────────────────────────────────────────────
const goldenPath = (name) => resolve(ROOT, 'harness', 'goldens', `${name}.png`)

export function saveGolden(name, pngBuffer) {
  mkdirSync(dirname(goldenPath(name)), { recursive: true })
  writeFileSync(goldenPath(name), pngBuffer)
}

export function diffGolden(name, pngBuffer, thresholdPct) {
  if (!existsSync(goldenPath(name))) return { exists: false, pass: false, diffPct: null }
  const diffPct = noiseFloorDiff(readFileSync(goldenPath(name)), pngBuffer)
  return { exists: true, pass: diffPct <= thresholdPct, diffPct }
}

// ── Structural probes: run in the page, no pixels — cheap and exact. ────────────────────────────
export const structural = {
  layerCount: (probe) => probe.eval(() => window.__harness.map.getStyle().layers.length),
  layerVisibility: (probe, id) => probe.eval(
    (layerId) => window.__harness.map.getLayoutProperty(layerId, 'visibility') ?? 'visible', id),
  renderInfo: (probe) => probe.eval(() => window.__harness.render.info()),
  frameTimeP75: (probe) => probe.eval(() => {
    const t = window.__harness.render.frameTimes().slice().sort((a, b) => a - b)
    return t.length ? t[Math.floor(t.length * 0.75)] : null
  }),
  screenPosition: (probe, lngLat) => probe.eval((ll) => {
    const p = window.__harness.map.project(ll)
    return { x: p.x, y: p.y }
  }, lngLat),
}

// ── Gate bookkeeping ────────────────────────────────────────────────────────────────────────────
export function createGate(name) {
  const results = []
  const skipped = []
  return {
    check(id, claim, pass, detail = '') {
      results.push({ id, pass: Boolean(pass) })
      console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${id} ${claim}${detail ? ` — ${detail}` : ''}`)
      return Boolean(pass)
    },
    /** A criterion that does not apply to this run (a pre-approved fallback was taken). Never counted as a pass. */
    skip(id, claim, reason) {
      skipped.push(id)
      console.log(`  [SKIP] ${id} ${claim} — ${reason}`)
    },
    /** Prints the machine-readable summary line and returns the process exit code. */
    finish({ p75LayerMs = 'n/a', artifacts = 'artifacts/' } = {}) {
      const failed = results.filter((r) => !r.pass).map((r) => r.id)
      const passed = results.length - failed.length
      console.log(`GATE ${name} ${failed.length ? 'FAIL' : 'PASS'} assertions=${passed}/${results.length} `
        + `failed=[${failed.join(',')}]${skipped.length ? ` skipped=[${skipped.join(',')}]` : ''} p75_layer_ms=${p75LayerMs} artifacts=${artifacts}`)
      return failed.length ? 1 : 0
    },
  }
}
