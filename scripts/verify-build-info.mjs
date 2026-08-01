#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const file = resolve(process.cwd(), 'dist', 'build-info.json')
const info = JSON.parse(readFileSync(file, 'utf8'))
const expectedTarget = arg('--target') ?? process.env.VITE_BUILD_TARGET
const expectedSha = (arg('--sha') ?? process.env.VITE_GIT_SHA ?? process.env.GITHUB_SHA)?.toLowerCase()

const failures = []
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(info.version ?? ''))) {
  failures.push(`invalid version: ${String(info.version)}`)
}
if (!['windows', 'mobile', 'classroom'].includes(info.target)) {
  failures.push(`invalid target: ${String(info.target)}`)
}
if (!/^(?:[0-9a-f]{40}|unknown)$/.test(String(info.gitSha ?? ''))) {
  failures.push(`invalid gitSha: ${String(info.gitSha)}`)
}
if (expectedTarget && info.target !== expectedTarget) {
  failures.push(`target mismatch: expected ${expectedTarget}, got ${info.target}`)
}
if (expectedSha && info.gitSha !== expectedSha) {
  failures.push(`SHA mismatch: expected ${expectedSha}, got ${info.gitSha}`)
}
if (!['development', 'public_demo', 'windows_evaluation', 'classroom_pilot', 'agency_training_pilot'].includes(info.distributionChannel)) {
  failures.push(`invalid distributionChannel: ${String(info.distributionChannel)}`)
}
if (info.distributionChannel !== 'development' && info.distributionChannel !== 'public_demo') {
  if (!info.licenseExpiresAt || !Number.isFinite(Date.parse(info.licenseExpiresAt))) {
    failures.push('evaluation/pilot build requires a valid licenseExpiresAt')
  }
}

if (failures.length > 0) {
  console.error('Build info verification FAILED:')
  failures.forEach((failure) => console.error(`  - ${failure}`))
  process.exit(1)
}

console.log(`Build info OK: v${info.version} · ${info.target} · ${info.gitSha}`)
