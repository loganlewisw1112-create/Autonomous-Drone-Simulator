/**
 * The ground AS MAPLIBRE DRAWS IT — one model for everything in the scene that touches the ground
 * (aircraft heights, shadow receivers, later the sensor volumes), so they can never disagree.
 *
 * It is the sim's own DEM (the same pixels the app feeds MapLibre) times the live exaggeration,
 * with two measured caveats about what the map actually renders:
 *   1. relief exists only inside the block of WHOLE DEM tiles (`extractTile` drops partial tiles);
 *   2. relief exists only above a zoom floor (measured: none at z14, present at z15).
 * Everywhere else the drawn ground is flat at 0 m. Rather than model MapLibre's zoom rule, the
 * model ASKS it once per frame: one `queryTerrainElevation` at an on-block point, compared with the
 * DEM. Pure array maths after that — no per-vertex MapLibre calls, and no dependence on which
 * terrain tiles happen to be loaded off-screen (where MapLibre answers 0).
 */
import type * as maplibregl from 'maplibre-gl'
import { resolveTerrainFixtureId, terrainFixtureFor, terrainRasterFor } from '@/scenarios/terrainFixtures'
import { elevationAt, type TerrainRaster } from '@/sim/terrain/terrainRaster'

export interface Bounds {
  west: number
  south: number
  east: number
  north: number
}

export interface TerrainModel {
  /** Call once per frame, before anything asks for ground. */
  refresh(): void
  /** Drawn ground elevation, metres MSL, at lng/lat — 0 where the map draws no relief. */
  groundAt(lng: number, lat: number): number
  reliefLive(): boolean
  liveBounds(): Bounds | null
}

interface HeaderWithOrigin {
  zoom: number
  width: number
  height: number
  tileSize?: number
  mercatorPixelOrigin?: { x: number; y: number }
}

/** The lng/lat box covered by whole DEM tiles — the only place the map draws relief. */
export function wholeTileBounds(header: HeaderWithOrigin | undefined): Bounds | null {
  if (!header?.mercatorPixelOrigin) return null
  const tile = header.tileSize ?? 256
  const { x: ox, y: oy } = header.mercatorPixelOrigin
  const x0 = Math.ceil(ox / tile), x1 = Math.floor((ox + header.width) / tile)
  const y0 = Math.ceil(oy / tile), y1 = Math.floor((oy + header.height) / tile)
  if (x1 <= x0 || y1 <= y0) return null
  const n = 2 ** header.zoom
  const lng = (x: number) => (x / n) * 360 - 180
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  return { west: lng(x0), east: lng(x1), north: lat(y0), south: lat(y1) }
}

export function createTerrainModel(map: maplibregl.Map, scenario: { id: string; terrainFixtureId?: string } | null): TerrainModel {
  const fixtureId = scenario ? resolveTerrainFixtureId(scenario) : undefined
  const raster: TerrainRaster | undefined = fixtureId ? terrainRasterFor(fixtureId) : undefined
  const bounds = fixtureId ? wholeTileBounds(terrainFixtureFor(fixtureId)?.header as HeaderWithOrigin | undefined) : null
  let exaggeration = 0
  let live = false

  const inside = (lng: number, lat: number) =>
    bounds !== null && lng > bounds.west && lng < bounds.east && lat > bounds.south && lat < bounds.north

  return {
    refresh() {
      exaggeration = map.getTerrain()?.exaggeration ?? 0
      live = false
      if (!raster || !bounds || exaggeration === 0) return
      // Ask about the on-block point nearest the view centre: if the block is on screen, so is this.
      const c = map.getCenter()
      const inset = 0.0005
      const lng = Math.min(bounds.east - inset, Math.max(bounds.west + inset, c.lng))
      const lat = Math.min(bounds.north - inset, Math.max(bounds.south + inset, c.lat))
      const drawn = map.queryTerrainElevation([lng, lat])
      const dem = elevationAt(raster, lat, lng) * exaggeration
      // Low-lying AOs (dem ≈ 0) pass either way, and either answer is then right to within metres.
      live = drawn !== null && Math.abs(drawn - dem) < Math.max(5, Math.abs(dem) * 0.05)
    },
    groundAt: (lng, lat) => (live && raster && inside(lng, lat) ? elevationAt(raster, lat, lng) * exaggeration : 0),
    reliefLive: () => live,
    liveBounds: () => bounds,
  }
}
