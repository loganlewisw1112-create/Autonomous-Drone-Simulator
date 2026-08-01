#!/usr/bin/env node

/**
 * Build and execute all three release artifacts, then compare their emitted parity manifests.
 *
 * This is intentionally an artifact gate. Each Vite build emits target-parity-harness.js;
 * Vite then imports that generated file and writes target-parity.json from its result. This
 * verifier never imports the TypeScript harness or simulation source directly.
 */

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const root = process.cwd()
const outputRoot = resolve(root, 'outputs', 'target-parity')
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')
const targets = [
  { id: 'windows', mode: null, appTarget: 'windows' },
  { id: 'mobile', mode: null, appTarget: 'mobile' },
  { id: 'classroom', mode: 'classroom', appTarget: 'classroom' },
]

mkdirSync(outputRoot, { recursive: true })

const manifests = []
for (const target of targets) {
  const outDir = join(outputRoot, target.id)
  rmSync(outDir, { recursive: true, force: true })

  const args = [viteBin, 'build', '--outDir', outDir, '--emptyOutDir']
  if (target.mode) args.push('--mode', target.mode)
  const env = {
    ...process.env,
    VITE_APP_TARGET: target.appTarget,
    VITE_BUILD_TARGET: target.id,
  }
  execFileSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const manifestPath = join(outDir, 'target-parity.json')
  const harnessPath = join(outDir, 'target-parity-harness.js')
  if (!existsSync(harnessPath)) fail(`${target.id} did not emit target-parity-harness.js`)
  if (!existsSync(manifestPath)) fail(`${target.id} did not emit target-parity.json`)

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validateManifest(target.id, manifest, outDir)
  manifests.push(manifest)
}

const expected = comparable(manifests[0])
for (const manifest of manifests.slice(1)) {
  const actual = comparable(manifest)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${manifest.target} artifact diverged from windows\n`
      + `windows: ${JSON.stringify(expected, null, 2)}\n`
      + `${manifest.target}: ${JSON.stringify(actual, null, 2)}`,
    )
  }
}

const verification = {
  schemaVersion: 1,
  verifiedTargets: manifests.map((manifest) => manifest.target),
  aggregateDigest: manifests[0].aggregateDigest,
  fixtures: manifests[0].fixtures,
  missions: manifests[0].missions,
  build: manifests[0].build,
}
writeFileSync(
  join(outputRoot, 'verified-target-parity.json'),
  `${JSON.stringify(verification, null, 2)}\n`,
  'utf8',
)

console.log('Target artifact parity OK')
console.log(`  targets     : ${verification.verifiedTargets.join(', ')}`)
console.log(`  DEM packages: ${verification.fixtures.terrainPackageIds.length}`)
console.log(`  missions    : ${verification.missions.map((mission) => `${mission.kind}:${mission.digest.slice(0, 12)}`).join(', ')}`)
console.log(`  aggregate   : ${verification.aggregateDigest}`)

function validateManifest(target, manifest, outDir) {
  if (manifest.schemaVersion !== 1) fail(`${target} parity manifest has unsupported schema`)
  if (manifest.harnessVersion !== 1) fail(`${target} parity harness version is not 1`)
  if (manifest.target !== target) fail(`${target} artifact self-identifies as ${manifest.target}`)
  if (!/^[0-9a-f]{40}$|^unknown$/i.test(manifest.build?.gitSha ?? '')) {
    fail(`${target} parity manifest has invalid Git SHA`)
  }

  const terrainPackages = manifest.fixtures?.terrainPackageIds
  const terrainScenarios = manifest.fixtures?.terrainScenarioIds
  const buildingScenarios = manifest.fixtures?.buildingScenarioIds
  if (!Array.isArray(terrainPackages) || terrainPackages.length !== 7) {
    fail(`${target} artifact does not declare all seven physical DEM packages`)
  }
  if (!Array.isArray(terrainScenarios) || !terrainScenarios.includes('nist_obstructed_lane')) {
    fail(`${target} artifact lost the NIST terrain alias`)
  }
  if (!Array.isArray(buildingScenarios) || buildingScenarios.length < 3) {
    fail(`${target} artifact lost committed building fixtures`)
  }

  const assetNames = existsSync(join(outDir, 'assets'))
    ? readdirSync(join(outDir, 'assets'))
    : []
  for (const fixtureId of terrainPackages) {
    if (!assetNames.some((name) => name.startsWith(`${fixtureId}-`) && name.endsWith('.js'))) {
      fail(`${target} artifact manifest declares ${fixtureId}, but its executable chunk is missing`)
    }
  }

  const missions = manifest.missions
  if (!Array.isArray(missions) || missions.length !== 3) {
    fail(`${target} artifact did not execute all three representative missions`)
  }
  const byKind = new Map(missions.map((mission) => [mission.kind, mission]))
  for (const kind of ['terrain', 'building', 'thermal']) {
    const mission = byKind.get(kind)
    if (!mission) fail(`${target} artifact did not execute the ${kind} mission`)
    if (!/^[0-9a-f]{64}$/i.test(mission.digest ?? '')) {
      fail(`${target} ${kind} mission has no deterministic digest`)
    }
    if (!/^[0-9a-f]{64}$/i.test(mission.replayHash ?? '')) {
      fail(`${target} ${kind} mission has no replay hash`)
    }
    if (!/^[0-9a-f]{64}$/i.test(mission.eventChainHash ?? '')) {
      fail(`${target} ${kind} mission has no event-chain hash`)
    }
    if (mission.eventCount < 2 || mission.replayFrameCount < 2) {
      fail(`${target} ${kind} mission produced trivial evidence`)
    }
  }
  if (byKind.get('building').safetyDecisionCount < 1) {
    fail(`${target} building mission exercised no real safety decision`)
  }
  if (byKind.get('thermal').detectionCount < 1) {
    fail(`${target} thermal mission exercised no real detection`)
  }
  if (!/^[0-9a-f]{64}$/i.test(manifest.aggregateDigest ?? '')) {
    fail(`${target} artifact has no aggregate digest`)
  }
}

function comparable(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    harnessVersion: manifest.harnessVersion,
    fixtures: manifest.fixtures,
    missions: manifest.missions,
    aggregateDigest: manifest.aggregateDigest,
  }
}

function fail(message) {
  console.error(`Target artifact parity FAILED: ${message}`)
  process.exit(1)
}
