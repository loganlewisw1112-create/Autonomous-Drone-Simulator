import type maplibregl from 'maplibre-gl'
import type { DeviceMode } from '@/hooks/useDeviceMode'
import { terrainFixtureFor, type TerrainFixture } from '@/scenarios/terrainFixtures'

const SOURCE_ID = 'scenario-terrain-dem'
const PROTOCOL = 'scenario-dem'
const TILE_PX = 256

let protocolRegistered = false
let activeFixture: TerrainFixture | null = null
let decodedPixels: Uint8ClampedArray | null = null
let decodedWidth = 0
let decodedHeight = 0

function decodeDataUriPng(dataUri: string): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('2d context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, img.width, img.height)
      resolve({ width: img.width, height: img.height, pixels: data })
    }
    img.onerror = () => reject(new Error('terrain PNG decode failed'))
    img.src = dataUri
  })
}

function encodeRgbPngTile(pixels: Uint8ClampedArray, width: number, height: number): ArrayBuffer {
  // MapLibre only needs a valid Terrarium RGB PNG. Use canvas encode for browser tiles —
  // this path is view-only and never feeds the deterministic sim kernel.
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return new ArrayBuffer(0)
  const image = ctx.createImageData(width, height)
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    image.data[j] = pixels[j]
    image.data[j + 1] = pixels[j + 1]
    image.data[j + 2] = pixels[j + 2]
    image.data[j + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  const dataUrl = canvas.toDataURL('image/png')
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1))
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out.buffer
}

interface TerrainHeaderWithOrigin {
  zoom: number
  width: number
  height: number
  mercatorPixelOrigin?: { x: number; y: number }
  bounds: { west: number; south: number; east: number; north: number }
}

function extractTile(z: number, x: number, y: number): ArrayBuffer | null {
  const fixture = activeFixture
  if (!fixture || !decodedPixels) return null
  const header = fixture.header as TerrainHeaderWithOrigin
  if (z !== header.zoom || !header.mercatorPixelOrigin) return null

  const originX = header.mercatorPixelOrigin.x
  const originY = header.mercatorPixelOrigin.y
  const tileAbsX = x * TILE_PX
  const tileAbsY = y * TILE_PX
  const offX = tileAbsX - originX
  const offY = tileAbsY - originY

  // Entire tile must lie inside the committed crop — partial tiles omitted.
  if (offX < 0 || offY < 0 || offX + TILE_PX > decodedWidth || offY + TILE_PX > decodedHeight) {
    return null
  }

  const tile = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
  for (let row = 0; row < TILE_PX; row++) {
    const src = ((offY + row) * decodedWidth + offX) * 4
    const dst = row * TILE_PX * 4
    tile.set(decodedPixels.subarray(src, src + TILE_PX * 4), dst)
  }
  return encodeRgbPngTile(tile, TILE_PX, TILE_PX)
}

function ensureProtocol(maplibre: typeof maplibregl): void {
  if (protocolRegistered) return
  // MapLibre 5: Promise-based custom protocols (view-only tile extraction from committed DEM).
  maplibre.addProtocol(PROTOCOL, async (params) => {
    const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(params.url)
    if (!match) throw new Error('bad terrain tile url')
    const data = extractTile(Number(match[1]), Number(match[2]), Number(match[3]))
    if (!data || data.byteLength === 0) throw new Error('terrain tile outside fixture')
    return { data }
  })
  protocolRegistered = true
}

export function removeScenarioTerrainLayer(map: maplibregl.Map): void {
  try {
    if (map.getTerrain()) map.setTerrain(null)
  } catch {
    /* map may already be gone */
  }
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
}

/**
 * Desktop / classroom / Windows: feed the committed Terrarium PNG into MapLibre as raster-dem
 * so pitch/terrain exaggeration matches the same DEM the sim samples. Mobile omits this.
 */
export async function addScenarioTerrainLayer(
  map: maplibregl.Map,
  maplibre: typeof maplibregl,
  fixtureId: string | undefined,
  _deviceMode: DeviceMode,
): Promise<void> {
  removeScenarioTerrainLayer(map)
  activeFixture = null
  decodedPixels = null

  if (!fixtureId) return
  const fixture = terrainFixtureFor(fixtureId)
  if (!fixture) return

  const header = fixture.header as TerrainHeaderWithOrigin
  if (!header.mercatorPixelOrigin) return

  ensureProtocol(maplibre)
  const decoded = await decodeDataUriPng(fixture.payload)
  decodedPixels = decoded.pixels
  decodedWidth = decoded.width
  decodedHeight = decoded.height
  activeFixture = fixture

  map.addSource(SOURCE_ID, {
    type: 'raster-dem',
    tiles: [`${PROTOCOL}://fixture/{z}/{x}/{y}.png`],
    tileSize: TILE_PX,
    maxzoom: header.zoom,
    minzoom: header.zoom,
    encoding: 'terrarium',
    bounds: [header.bounds.west, header.bounds.south, header.bounds.east, header.bounds.north],
  })
  map.setTerrain({ source: SOURCE_ID, exaggeration: 1.15 })
}
