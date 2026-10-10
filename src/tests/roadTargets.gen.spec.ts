// Author-time generator for tools/fixtures/roadTargets.json (DEMO_BLOCKERS c12a).
//
// Skipped unless WRITE_ROAD_TARGETS=1, so the normal suite never rewrites a committed file:
//   WRITE_ROAD_TARGETS=1 npx vitest run --pool=threads --maxWorkers=3 src/tests/roadTargets.gen.spec.ts
//
// tools/fixtures/roads.mjs is plain Node and cannot import the TypeScript catalog, so the catalog
// is flattened here into {id, bbox, startPosition, heatSources, usesRecovery}. roads.mjs owns the
// `parked[]` list and this generator preserves it untouched.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { INCIDENT_SCENARIOS } from '@/scenarios/catalog'
import { aoBbox } from '../../tools/fixtures/aoBbox.mjs'

const TARGETS_PATH = fileURLToPath(new URL('../../tools/fixtures/roadTargets.json', import.meta.url))
const MARGIN_M = 1500

/** The default AO box, widened to contain every heat source plus the same margin. */
export function roadTargetBbox(scenario: (typeof INCIDENT_SCENARIOS)[number]): [number, number, number, number] {
  const boxes = [aoBbox(scenario, { marginM: MARGIN_M })]
  for (const heat of scenario.heatSources) {
    boxes.push(aoBbox({ id: scenario.id, startPosition: heat.position }, { marginM: MARGIN_M }))
  }
  return [
    Math.min(...boxes.map((b) => b.xmin)),
    Math.min(...boxes.map((b) => b.ymin)),
    Math.max(...boxes.map((b) => b.xmax)),
    Math.max(...boxes.map((b) => b.ymax)),
  ]
}

export function buildRoadTargets() {
  return INCIDENT_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    bbox: roadTargetBbox(scenario),
    startPosition: { lat: scenario.startPosition.lat, lng: scenario.startPosition.lng },
    heatSources: scenario.heatSources.map((h) => ({ lat: h.position.lat, lng: h.position.lng })),
    // Any launched drone can need recovery and no scenario field says otherwise.
    usesRecovery: true,
  }))
}

describe.skipIf(process.env.WRITE_ROAD_TARGETS !== '1')('road target generator', () => {
  it('writes tools/fixtures/roadTargets.json from the incident catalog', () => {
    const previous = existsSync(TARGETS_PATH) ? JSON.parse(readFileSync(TARGETS_PATH, 'utf8')) : null
    const targets = buildRoadTargets()
    const out = { v: 1, targets, parked: Array.isArray(previous?.parked) ? previous.parked : [] }
    writeFileSync(TARGETS_PATH, JSON.stringify(out, null, 2) + '\n')
    expect(out.targets.length).toBeGreaterThan(0)
  })
})
