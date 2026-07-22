#!/usr/bin/env node
// Fixture pipeline CLI (REALISM_ROADMAP WP-0).
//
// Run by a maintainer at authoring time; NEVER part of any build, NEVER in CI. Reads the AO
// list from tools/fixtures/scenarios.json, fetches real geodata, and freezes it into committed
// fixtures under src/scenarios/fixtures/<id>/ with a provenance manifest (source URL, retrieval
// date, licence, SHA-256). src/ never fetches anything at runtime — it imports these frozen files.
//
//   node tools/fixtures/index.mjs                 # all scenarios in scenarios.json
//   node tools/fixtures/index.mjs demo_basic      # one scenario by id
//
// Provenance is not optional: manifest.json records where every number came from and its hash,
// which is what lets you answer "where did this come from" in a diligence conversation and
// satisfies the Open-Meteo CC BY 4.0 attribution obligation.

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { fetchObservedWeather } from './openMeteo.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const fixturesRoot = new URL('../../src/scenarios/fixtures/', import.meta.url)

const sha256 = (s) => createHash('sha256').update(s).digest('hex')

async function main() {
  const only = process.argv[2]
  const catalog = JSON.parse(await readFile(new URL('./scenarios.json', import.meta.url), 'utf8'))
  const targets = catalog.scenarios.filter((s) => !only || s.id === only)
  if (targets.length === 0) {
    console.error(`No scenario matched "${only}". Known: ${catalog.scenarios.map((s) => s.id).join(', ')}`)
    process.exit(1)
  }

  for (const scn of targets) {
    process.stdout.write(`• ${scn.id} … `)
    const weather = await fetchObservedWeather({ lat: scn.lat, lng: scn.lng, date: scn.realDate })
    const weatherJson = JSON.stringify(weather.observed, null, 2) + '\n'

    const dir = new URL(`${scn.id}/`, fixturesRoot)
    await mkdir(dir, { recursive: true })
    await writeFile(new URL('weather.json', dir), weatherJson)

    const manifest = {
      scenarioId: scn.id,
      area: { lat: scn.lat, lng: scn.lng },
      realDate: scn.realDate,
      generatedAt: new Date().toISOString().slice(0, 10),
      sources: [
        {
          fixture: 'weather.json',
          source: 'Open-Meteo ERA5 archive',
          url: weather.url,
          license: weather.license,
          sha256: sha256(weatherJson),
        },
      ],
    }
    await writeFile(new URL('manifest.json', dir), JSON.stringify(manifest, null, 2) + '\n')
    console.log(`wind ${weather.observed.windKts}kt gust ${weather.observed.gustKts}kt temp ${weather.observed.tempF}°F ✓`)
  }
  console.log(`\nWrote ${targets.length} fixture set(s) under src/scenarios/fixtures/. Commit them; src/ imports, never fetches.`)
  void root
}

main().catch((e) => {
  console.error('fixture pipeline failed:', e.message)
  process.exit(1)
})
