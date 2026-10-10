/**
 * c12b map surface: attribution text, the faint fallback roads layer, and the routed recovery line.
 * Source-level checks for the pieces that need a live MapLibre map (no WebGL in the test runner).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOCAL_DEMO_MAP_STYLE,
  OVERTURE_ATTRIBUTION_HTML,
  OVERTURE_ATTRIBUTION_TEXT,
  roadsFeatureCollection,
} from '@/components/TacticalMap'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import { getRoadNetwork, prepareScenarioRoads } from '@/scenarios/roadFixtures'
import { remainingPolyline, routeOnRoads, snapToRoad, pointAtDistance } from '@/sim/mission/roadRouter'

const source = readFileSync(join(process.cwd(), 'src/components/TacticalMap.tsx'), 'utf8')

describe('attribution', () => {
  it('credits Overture for buildings and roads', () => {
    expect(OVERTURE_ATTRIBUTION_TEXT).toBe('Buildings & roads © Overture Maps Foundation')
    expect(OVERTURE_ATTRIBUTION_HTML).toContain('Buildings &amp; roads © Overture Maps Foundation')
    expect(OVERTURE_ATTRIBUTION_HTML).toContain('https://overturemaps.org/')
    // The map actually uses it, and the old buildings-only credit is gone.
    expect(source).toContain('OVERTURE_ATTRIBUTION_HTML,')
    expect(source).not.toContain('Buildings © Overture Maps Foundation')
  })
})

describe('roads-fallback layer', () => {
  it('is registered first in registerPermanentLayers and is not part of LOCAL_DEMO_MAP_STYLE', () => {
    const start = source.indexOf('const registerPermanentLayers = () => {')
    expect(start).toBeGreaterThan(0)
    const roads = source.indexOf("map.addSource('roads-fallback'", start)
    const thermal = source.indexOf("map.addSource('thermal-detections'", start)
    expect(roads).toBeGreaterThan(start)
    expect(roads).toBeLessThan(thermal)
    expect(source).toMatch(/id: 'roads-fallback', type: 'line', source: 'roads-fallback'/)
    expect(LOCAL_DEMO_MAP_STYLE.layers.some((l) => l.id === 'roads-fallback')).toBe(false)
    expect(Object.keys(LOCAL_DEMO_MAP_STYLE.sources)).not.toContain('roads-fallback')
  })

  it('is filled by an effect keyed on [mapReady, scenario id, mapMode] and shown only in fallback mode', () => {
    expect(source).toContain('}, [mapReady, scenarioId, mapMode])')
    expect(source).toContain("mapMode === 'fallback' && net ? 'visible' : 'none'")
  })

  it('builds one LineString per road edge, once per network', async () => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic')!
    await prepareScenarioRoads(scenario.id)
    const net = getRoadNetwork(scenario)!
    const fc = roadsFeatureCollection(net)
    expect(fc.features).toHaveLength(net.edges.length)
    expect(fc.features[0].geometry.type).toBe('LineString')
    expect(roadsFeatureCollection(net)).toBe(fc)   // memoised
  })
})

describe('recovery lines', () => {
  it('draws only the remaining routed polyline and nothing when the team has no road access', async () => {
    const scenario = ALL_SCENARIOS.find((s) => s.id === 'demo_basic')!
    await prepareScenarioRoads(scenario.id)
    const net = getRoadNetwork(scenario)!
    const target = snapToRoad(net, scenario.heatSources[0].position, { role: 'target' })!
    const route = routeOnRoads(net, net.entries[0], target)
    expect(route.status).toBe('ok')
    const halfway = route.lengthM / 2
    const ahead = remainingPolyline(route, halfway)
    expect(ahead[0]).toEqual(pointAtDistance(route, halfway))
    expect(ahead[ahead.length - 1]).toEqual(route.points[route.points.length - 1])
    expect(ahead.length).toBeLessThan(route.points.length)
    expect(remainingPolyline(route, route.lengthM)).toHaveLength(1)
    // The map effect filters on roadRouted and reads the route through getTeamRoute (no straight line).
    expect(source).toContain("t.roadRouted !== true")
    expect(source).toContain('getTeamRoute(t, scenario)')
    expect(source).not.toMatch(/coordinates: \[\[t\.position\.lng, t\.position\.lat\], \[t\.targetPosition\.lng/)
    expect(source).toContain("id: 'recovery-foot-line'")
  })
})

describe('contact panel', () => {
  it('shows a disabled No road access button with a reason, and an additional-unit button at 12px or more', () => {
    expect(source).toContain('No road access')
    expect(source).toContain('data-testid="no-road-access"')
    expect(source).toContain('+ Additional unit')
    expect(source).toContain('contactUnits.length < 3')
    // Every new contact-panel element uses at least 12px.
    for (const id of ['no-road-access', 'additional-unit', 'no-road-reason']) {
      const at = source.indexOf(`data-testid="${id}"`)
      expect(at, id).toBeGreaterThan(0)
      const sizes = [...source.slice(Math.max(0, at - 260), at).matchAll(/fontSize: *([0-9]+)/g)]
      expect(sizes.length, id).toBeGreaterThan(0)
      expect(Number(sizes[sizes.length - 1][1]), id).toBeGreaterThanOrEqual(12)
    }
  })

  it('outlines only the first-unit Dispatch button (c4 coach), never No road access or + Additional unit', () => {
    const buttonAround = (testId: string) => {
      const at = source.indexOf(`data-testid="${testId}"`)
      return source.slice(source.lastIndexOf('<button', at), source.indexOf('</button>', at))
    }
    for (const id of ['no-road-access', 'additional-unit']) {
      const block = buttonAround(id)
      expect(block, id).not.toContain('coach-outline')
      expect(block, id).not.toContain('data-coach')
    }
    expect(source.match(/data-coach="dispatch"/g)).toHaveLength(1)
    expect(source.match(/coach-outline/g)).toHaveLength(1)
    // The single outlined Dispatch button sits in the branch that replaces No road access.
    expect(source.indexOf('coach-outline')).toBeGreaterThan(source.indexOf('data-testid="no-road-access"'))
    expect(source).toContain("className={holdActive && !contact.groundUnitId ? 'btn coach-outline' : 'btn'}")
  })
})
