import type * as maplibregl from 'maplibre-gl'
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

  // Reject only tiles that do not touch the crop at all. A tile that straddles the crop edge used to be
  // dropped whole, which stopped the drawn relief a full tile (up to 256 px) short of the DEM's real bounds
  // on every side. Instead, serve it: pixels inside the crop are the DEM, pixels outside are edge-clamped —
  // the SAME clamp `elevationAt` (terrainRaster.ts) applies, so the scene's ground model and MapLibre agree.
  if (offX + TILE_PX <= 0 || offY + TILE_PX <= 0 || offX >= decodedWidth || offY >= decodedHeight) {
    return null
  }

  const clampInt = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  const tile = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
  for (let row = 0; row < TILE_PX; row++) {
    const sy = clampInt(offY + row, decodedHeight - 1)
    for (let col = 0; col < TILE_PX; col++) {
      const sx = clampInt(offX + col, decodedWidth - 1)
      const src = (sy * decodedWidth + sx) * 4
      const dst = (row * TILE_PX + col) * 4
      tile[dst] = decodedPixels[src]
      tile[dst + 1] = decodedPixels[src + 1]
      tile[dst + 2] = decodedPixels[src + 2]
      tile[dst + 3] = 255
    }
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
  try {
    if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID)
  } catch {
    // Responsive shell changes and React cleanup can run after MapLibre has
    // destroyed its style object. Teardown must remain safe and repeatable.
  }
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
