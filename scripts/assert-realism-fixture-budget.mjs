#!/usr/bin/env node
// REALISM_ROADMAP §19/§21: keep each sourced scenario fixture under 500 KB shipped,
// with Overture buildings under 250 KB gzip. This checks committed artifacts directly.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = join(process.cwd(), 'src', 'scenarios', 'fixtures')
const MAX_SCENARIO_BYTES = 500 * 1024
const MAX_BUILDINGS_GZIP_BYTES = 250 * 1024
const MAX_RING_VERTICES = 10
const failures = []

for (const scenarioId of readdirSync(root)) {
  const dir = join(root, scenarioId)
  let shippedBytes = 0
  let buildingsGzip = 0

  for (const name of ['terrain.png', 'terrain.json', 'terrain-refpoints.json', 'buildings.json', 'manifest.json']) {
    let bytes
    try { bytes = readFileSync(join(dir, name)) } catch { continue }
    const size = name.endsWith('.png') ? bytes.length : gzipSync(bytes, { level: 9 }).length
    shippedBytes += size
    if (name === 'buildings.json') {
      buildingsGzip = size
      const fixture = JSON.parse(bytes.toString('utf8'))
      for (const feature of fixture.features ?? []) {
        const polygons = feature.geometry?.type === 'Polygon'
          ? [feature.geometry.coordinates]
          : feature.geometry?.coordinates ?? []
        for (const polygon of polygons) {
          for (const ring of polygon) {
            if (ring.length > MAX_RING_VERTICES) {
              failures.push(`${scenarioId}: building ring has ${ring.length} vertices (max ${MAX_RING_VERTICES})`)
            }
          }
        }
      }
    }
  }

  if (buildingsGzip > MAX_BUILDINGS_GZIP_BYTES) {
    failures.push(`${scenarioId}: buildings ${buildingsGzip} bytes gzip exceeds ${MAX_BUILDINGS_GZIP_BYTES}`)
  }
  if (shippedBytes > MAX_SCENARIO_BYTES) {
    failures.push(`${scenarioId}: realism fixtures ${shippedBytes} shipped bytes exceed ${MAX_SCENARIO_BYTES}`)
  }
  if (shippedBytes > 0) {
    console.log(`${scenarioId}: ${(shippedBytes / 1024).toFixed(1)} KB shipped` +
      (buildingsGzip ? ` · buildings ${(buildingsGzip / 1024).toFixed(1)} KB gzip` : ''))
  }
}

if (failures.length > 0) {
  console.error('Realism fixture budget FAILED:')
  failures.forEach((failure) => console.error(`  - ${failure}`))
  process.exit(1)
}
console.log('Realism fixture budget OK')
