#!/usr/bin/env node
// Asserts, against BUILT output, that the shipping bundles contain no networking code.
//
// COORDINATOR_BUILD_PLAN §7 asks for "a CI assertion that the mobile and Windows bundles contain
// no networking code — make the guarantee mechanical, not a promise." The unit spec
// (src/tests/classroomBundleGuard.spec.ts) can only grep source: it proves WebSocket usage is
// confined to src/classroom and that main.tsx reaches it via a flag-gated dynamic import. That
// is the *precondition* for tree-shaking, not proof it happened. This script checks the artifact.
//
// It builds the release targets and asserts the differences:
//   default build  -> no classroom chunk, no WebSocket token anywhere
//   mobile build   -> no authored 3D-building layer code in non-MapLibre app chunks
//   classroom build -> classroom chunk exists, and WebSocket appears ONLY inside it
//
// Audit F-12 (startup performance) adds a mechanical startup-path budget to every target:
// the entry chunk plus its static-import graph (cross-checked against index.html's
// modulepreload list) must stay under a raw-byte cap, no single non-maplibre startup chunk
// may exceed 600 KB, and the committed building fixtures must remain lazy async chunks —
// they are the payload that used to bloat the startup `catalog` chunk to ~1.6 MB.
//
// The second half matters as much as the first. A guard that only checks the default build would
// still pass if the classroom feature silently stopped shipping at all.
//
//   node scripts/assert-bundle-isolation.mjs
//
// Run in CI after the build step. Exits non-zero with a specific message on any violation.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const dist = join(root, 'dist')
// Run vite's own JS entry under the current node rather than shelling out to `npx`. On Windows
// `npx` is a .cmd shim, which execFileSync cannot spawn without a shell (EINVAL), and going
// through a shell would drag in quoting problems on a path containing spaces — which this
// project's checkout has.
const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')

// `new WebSocket(` / `WebSocketServer` survive minification as-is: the global is not renameable
// and the property access is preserved. A bare /WebSocket/ would false-positive on unrelated
// vendor strings, so match the construction form the app actually uses.
const NET_TOKENS = [/new WebSocket\s*\(/, /\bWebSocketServer\b/]
const MOBILE_BUILDING_3D_TOKENS = [/scenario-buildings-extrusion/, /fill-extrusion/]
const TERRAIN_PACKAGES = [
  'demo_wildfire',
  'hist_camp_fire_paradise_2018',
  'hist_helene_asheville_2024',
  'hist_oso_sr530_2014',
  'hist_surfside_cts_2021',
  'train_mountain_sar',
  'train_wildfire_flank',
]

// ── F-12 startup-path budget ─────────────────────────────────────────────────
// Measured post-fix startup path (entry + catalog + maplibre) is ~1,670 KB raw per target;
// the cap adds ~15% headroom so ordinary feature growth passes while re-pinning a fixture
// (each committed buildings chunk alone is 270 KB–1.2 MB) fails immediately.
const STARTUP_BUDGET_BYTES = 1_950_000
// No single startup chunk may exceed 600 KB raw — except the maplibre vendor chunk (~1.06 MB),
// which is deliberately pinned via manualChunks: the core map is needed at first paint, so it
// is a documented static exception rather than a lazy candidate.
const STARTUP_CHUNK_BUDGET_BYTES = 600 * 1024
// The committed building fixtures ship as exactly two physical async chunks (demo_wildfire is
// aliased by nist_obstructed_lane; hist_surfside_cts_2021 is the other). Their source files are
// both named buildings.json, so both emitted chunks share the `buildings-` prefix.
const BUILDING_CHUNK_PREFIX = 'buildings-'
const BUILDING_CHUNK_COUNT = 2

function build(mode, appTarget) {
  rmSync(dist, { recursive: true, force: true })
  const args = [viteBin, 'build']
  if (mode) args.push('--mode', mode)
  const env = { ...process.env }
  if (appTarget) env.VITE_APP_TARGET = appTarget
  else delete env.VITE_APP_TARGET
  execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe', env })
}

function bundleFiles() {
  const assets = join(dist, 'assets')
  if (!existsSync(assets)) throw new Error('no dist/assets after build')
  return readdirSync(assets).filter((f) => f.endsWith('.js')).map((f) => ({ name: f, path: join(assets, f) }))
}

const withNetworking = (files) =>
  files.filter((f) => {
    const src = readFileSync(f.path, 'utf8')
    return NET_TOKENS.some((re) => re.test(src))
  }).map((f) => f.name)

const withTokens = (files, tokens) =>
  files.filter((f) => {
    const src = readFileSync(f.path, 'utf8')
    return tokens.some((re) => re.test(src))
  }).map((f) => f.name)

function terrainPackages(files) {
  return TERRAIN_PACKAGES.filter((id) => files.some((file) => file.name.startsWith(`${id}-`)))
}

// Static ESM references in Rollup output: `import ... from "./x.js"`, `export ... from "./x.js"`,
// and bare `import "./x.js"`. Dynamic imports are always `import(` and match neither pattern,
// so lazy chunks (terrain DEMs, building fixtures, recharts, panels) stay out of the graph.
const STATIC_REF_PATTERNS = [/\bfrom\s*["']\.\/([^"']+\.js)["']/g, /\bimport\s*["']\.\/([^"']+\.js)["']/g]

function staticDependencies(source) {
  const deps = new Set()
  for (const pattern of STATIC_REF_PATTERNS) {
    for (const match of source.matchAll(pattern)) deps.add(match[1])
  }
  return deps
}

/**
 * The startup path is what the browser must fetch before the app renders: the entry module
 * named by index.html plus every chunk reachable through static imports, unioned with the
 * modulepreload list Vite emitted (belt and braces — either alone could under-count if the
 * other regressed).
 */
function startupChunks(files) {
  const html = readFileSync(join(dist, 'index.html'), 'utf8')
  const byName = new Map(files.map((f) => [f.name, f]))
  const queue = []
  const entry = /<script[^>]+type="module"[^>]+src="[^"]*\/assets\/([^"]+\.js)"/.exec(html)?.[1]
  if (entry) queue.push(entry)
  for (const preload of html.matchAll(/<link rel="modulepreload"[^>]+href="[^"]*\/assets\/([^"]+\.js)"/g)) {
    queue.push(preload[1])
  }

  const reached = new Set()
  while (queue.length > 0) {
    const name = queue.shift()
    if (reached.has(name) || !byName.has(name)) continue
    reached.add(name)
    for (const dep of staticDependencies(readFileSync(byName.get(name).path, 'utf8'))) queue.push(dep)
  }
  // Raw bytes on disk, not string length — the budget is about transfer/parse cost.
  return [...reached].map((name) => ({ name, bytes: statSync(byName.get(name).path).size }))
}

function assertStartupBudget(target, files, failures) {
  const startup = startupChunks(files)
  if (startup.length === 0) {
    failures.push(`${target} build has no resolvable startup entry in dist/index.html`)
    return { totalBytes: 0, chunkCount: 0 }
  }
  const totalBytes = startup.reduce((sum, chunk) => sum + chunk.bytes, 0)
  if (totalBytes > STARTUP_BUDGET_BYTES) {
    failures.push(
      `${target} startup path is ${totalBytes} bytes (budget ${STARTUP_BUDGET_BYTES}): `
      + startup.map((chunk) => `${chunk.name}=${chunk.bytes}`).join(', '),
    )
  }
  for (const chunk of startup) {
    if (/^maplibre-/i.test(chunk.name)) continue // documented static exception, see budget consts
    if (chunk.bytes > STARTUP_CHUNK_BUDGET_BYTES) {
      failures.push(
        `${target} startup chunk ${chunk.name} is ${chunk.bytes} bytes `
        + `(single-chunk budget ${STARTUP_CHUNK_BUDGET_BYTES})`,
      )
    }
  }

  // The regression F-12 guards against: building fixtures riding the startup path again.
  const buildingChunks = files.filter((f) => f.name.startsWith(BUILDING_CHUNK_PREFIX))
  if (buildingChunks.length !== BUILDING_CHUNK_COUNT) {
    failures.push(
      `${target} build emitted ${buildingChunks.length} building fixture chunks, expected `
      + `${BUILDING_CHUNK_COUNT}: ${buildingChunks.map((f) => f.name).join(', ') || 'none'}`,
    )
  }
  const preloadedBuildings = startup.filter((chunk) => chunk.name.startsWith(BUILDING_CHUNK_PREFIX))
  if (preloadedBuildings.length > 0) {
    failures.push(
      `${target} startup path statically reaches building fixtures: `
      + preloadedBuildings.map((chunk) => chunk.name).join(', '),
    )
  }
  return { totalBytes, chunkCount: startup.length }
}

function assertTerrainManifest(target, files, failures) {
  const actual = terrainPackages(files)
  if (JSON.stringify(actual) !== JSON.stringify(TERRAIN_PACKAGES)) {
    failures.push(`${target} terrain manifest mismatch: expected ${TERRAIN_PACKAGES.join(', ')}, got ${actual.join(', ') || 'none'}`)
  }
  return actual
}

const failures = []

// ── Shipping build (mobile / Windows): classroom must be absent entirely ──────
build(null)
const shipping = bundleFiles()
const shippingClassroom = shipping.filter((f) => /Classroom/i.test(f.name)).map((f) => f.name)
const shippingNet = withNetworking(shipping)
const shippingTerrain = assertTerrainManifest('default', shipping, failures)
const shippingStartup = assertStartupBudget('default', shipping, failures)

if (shippingClassroom.length > 0) {
  failures.push(`default build emitted a classroom chunk: ${shippingClassroom.join(', ')}`)
}
if (shippingNet.length > 0) {
  failures.push(`default build contains networking code in: ${shippingNet.join(', ')}`)
}

// MapLibre itself supports every MapLibre style layer type, so its vendor chunk necessarily
// contains the generic 3D-layer vocabulary. The release guarantee is that our mobile app code
// neither contains nor registers the authored scenario-building extrusion implementation.
build(null, 'mobile')
const mobile = bundleFiles()
const mobileApp = mobile.filter((f) => !/^maplibre-/i.test(f.name))
const mobileBuilding3d = withTokens(mobileApp, MOBILE_BUILDING_3D_TOKENS)
const mobileTerrain = assertTerrainManifest('mobile', mobile, failures)
const mobileStartup = assertStartupBudget('mobile', mobile, failures)
if (mobileBuilding3d.length > 0) {
  failures.push(`mobile app chunks contain the desktop building implementation: ${mobileBuilding3d.join(', ')}`)
}

// ── Classroom build: the feature ships, and its networking stays quarantined ──
build('classroom')
const classroom = bundleFiles()
const classroomChunks = classroom.filter((f) => /Classroom/i.test(f.name)).map((f) => f.name)
const classroomNet = withNetworking(classroom)
const classroomTerrain = assertTerrainManifest('classroom', classroom, failures)
const classroomStartup = assertStartupBudget('classroom', classroom, failures)

if (classroomChunks.length === 0) {
  failures.push('classroom build emitted no classroom chunk — the feature stopped shipping')
}
const strays = classroomNet.filter((n) => !/Classroom/i.test(n))
if (strays.length > 0) {
  failures.push(`classroom build leaked networking outside the classroom chunk: ${strays.join(', ')}`)
}
if (classroomChunks.length > 0 && classroomNet.length === 0) {
  failures.push('classroom build has a classroom chunk but no networking in it — the relay client was dropped')
}

if (failures.length > 0) {
  console.error('Bundle isolation FAILED:')
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}

console.log('Bundle isolation OK')
console.log(`  shipping build : ${shipping.length} chunks, no classroom chunk, no networking`)
console.log(`  mobile build   : ${mobileApp.length} app chunks, no scenario-building extrusion code`)
console.log(`  classroom build: networking confined to ${classroomNet.join(', ')}`)
console.log(`  terrain parity : ${shippingTerrain.length} canonical packages in default/mobile/classroom (${mobileTerrain.length}/${classroomTerrain.length})`)
console.log(
  '  startup budget : '
  + `default ${shippingStartup.totalBytes}/${STARTUP_BUDGET_BYTES} bytes (${shippingStartup.chunkCount} chunks), `
  + `mobile ${mobileStartup.totalBytes}, classroom ${classroomStartup.totalBytes}; building fixtures lazy`,
)
