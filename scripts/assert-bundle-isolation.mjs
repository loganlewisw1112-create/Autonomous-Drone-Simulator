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
// The second half matters as much as the first. A guard that only checks the default build would
// still pass if the classroom feature silently stopped shipping at all.
//
//   node scripts/assert-bundle-isolation.mjs
//
// Run in CI after the build step. Exits non-zero with a specific message on any violation.

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
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

const failures = []

// ── Shipping build (mobile / Windows): classroom must be absent entirely ──────
build(null)
const shipping = bundleFiles()
const shippingClassroom = shipping.filter((f) => /Classroom/i.test(f.name)).map((f) => f.name)
const shippingNet = withNetworking(shipping)

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
if (mobileBuilding3d.length > 0) {
  failures.push(`mobile app chunks contain the desktop building implementation: ${mobileBuilding3d.join(', ')}`)
}

// ── Classroom build: the feature ships, and its networking stays quarantined ──
build('classroom')
const classroom = bundleFiles()
const classroomChunks = classroom.filter((f) => /Classroom/i.test(f.name)).map((f) => f.name)
const classroomNet = withNetworking(classroom)

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
