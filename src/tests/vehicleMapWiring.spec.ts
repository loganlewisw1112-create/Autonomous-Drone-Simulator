/**
 * c4b map plumbing that needs a live MapLibre map to run (no WebGL in the test runner), checked at
 * source level the way roadMapLayers.spec does: layer registration, effect deps, teardown.
 * The behaviour itself is covered by vehicleMarkerPlan.spec and vehicleMarkerSync.spec.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/components/TacticalMap.tsx'), 'utf8')

const between = (from: string, to: string) => {
  const a = source.indexOf(from)
  expect(a, from).toBeGreaterThan(-1)
  const b = source.indexOf(to, a)
  expect(b, to).toBeGreaterThan(a)
  return source.slice(a, b)
}

describe('vehicle layers', () => {
  const register = between('const registerPermanentLayers = () => {', 'const markMapReady')

  it('registers the unit, unit-walk and recovery-walk layers idempotently in registerPermanentLayers', () => {
    for (const id of ['unit-routes', 'unit-walk', 'recovery-walk']) {
      expect(register).toContain(`if (!map.getSource('${id}'))`)
    }
    for (const id of ['unit-route-line', 'unit-route-covered-line', 'unit-walk-line', 'recovery-walk-line', 'recovery-route-covered-line']) {
      expect(register, id).toContain(`id: '${id}'`)
    }
  })

  it('dashes the remaining route and draws tunnel spans on their own, finer layer', () => {
    expect(register).toMatch(/id: 'unit-route-line'[^\n]*'line-dasharray': \[2, 1\.5\]/)
    expect(register).toMatch(/id: 'unit-route-covered-line'[^\n]*\['==', \['get', 'covered'\], true\]/)
    expect(register).toMatch(/id: 'recovery-route-line'[^\n]*'line-dasharray': \[2, 1\.5\]/)
  })

  it('writes the vehicle line sources from the 10 fps interval, via the latest-data refs', () => {
    const interval = between('GeoJSON interval: all setData() calls at 10fps', '// ── Effect 1')
    expect(interval).toContain('writeVehicleLines(map, {')
    expect(interval).toContain('groundUnits: latestGroundUnitsRef.current')
    expect(interval).toContain('recoveryTeams: latestRecoveryTeamsRef.current')
  })
})

describe('vehicle markers effect', () => {
  const effect9 = between('// ── Effect 9: Vehicle avatars', '// Fallback basemap roads.')

  it('re-runs when the map becomes ready, and never uses rAF or a wall-clock lerp', () => {
    expect(effect9).toContain('}, [groundUnits, recoveryTeams, scenario, mapReady])')
    expect(effect9.replace(/\/\/.*$/gm, '')).not.toMatch(/requestAnimationFrame|Date\.now|lerp/)
  })

  it('resizes on zoom and removes its listener', () => {
    expect(effect9).toContain("map.on('zoom', sync)")
    expect(effect9).toContain("map.off('zoom', sync)")
  })

  it('re-sets the line sources when the map becomes ready or the scenario changes (style switch)', () => {
    expect(effect9).toContain('}, [mapReady, scenario])')
    expect(effect9).toContain('writeVehicleLines(map, {')
  })

  it('never builds popup HTML with setHTML, and the dead role===recovery emoji branch is gone', () => {
    expect(source).not.toMatch(/\.setHTML\(\s*\n?\s*`<div style="font-family:monospace;font-size:10px/)
    expect(source).not.toContain("unit.role === 'recovery' ? '⛑'")
    expect(source).toContain('.setDOMContent(content.node)')
  })

  it('never adds recovery teams to groundUnits', () => {
    expect(effect9).not.toMatch(/groundUnits\.(push|concat)|\[\.\.\.groundUnits/)
  })
})

describe('vehicle marker refs', () => {
  it('captures all three refs at setup and removes then clears them in the teardown', () => {
    for (const name of ['vehicleMarkers', 'recoveryMarkers', 'recoveryChips']) {
      expect(source, name).toContain(`const ${name}AtSetup = `)
      expect(source, name).toContain(`${name}AtSetup.clear()`)
    }
    expect(source).toContain('vehicleMarkersAtSetup.forEach((e) => e.marker.remove())')
    expect(source).toContain('recoveryMarkersAtSetup.forEach((e) => e.marker.remove())')
    expect(source).toContain('recoveryChipsAtSetup.forEach((m) => m.remove())')
  })
})

describe('contact panel on-scene line', () => {
  it('shows "On scene · crew on foot N m" at 12px or more', () => {
    const at = source.indexOf('data-testid="unit-on-scene"')
    expect(at).toBeGreaterThan(0)
    const sizes = [...source.slice(Math.max(0, at - 260), at).matchAll(/fontSize: *([0-9]+)/g)]
    expect(Number(sizes[sizes.length - 1][1])).toBeGreaterThanOrEqual(12)
    expect(source).toContain("crewOnFootM: (parkedUnit.accessGapM ?? 0) > 15 ? parkedUnit.accessGapM : undefined")
  })
})

describe('accessGapM source', () => {
  it('reads the unit or team own accessGapM, never the shared route object (routes are cached per snap point)', () => {
    const plan = readFileSync(join(process.cwd(), 'src/components/vehicleMarkerPlan.ts'), 'utf8')
    for (const text of [source, plan]) expect(text).not.toMatch(/route\.accessGapM/)
  })
})
