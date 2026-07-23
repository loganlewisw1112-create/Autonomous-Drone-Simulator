#!/usr/bin/env node
// Authoring-time Overture building fixture generator (REALISM_ROADMAP WP-4).
//
// This tool downloads a frozen GeoJSON extract, keeps only footprints whose height is
// measured or can be inferred from an authored floor count, and records terrain-derived
// base elevation in metres MSL. The app imports the resulting JSON; it never fetches Overture
// data at runtime.
//
//   node tools/fixtures/buildings.mjs --id demo_wildfire
//   node tools/fixtures/buildings.mjs --id demo_wildfire --input raw-buildings.geojson

// The official Python client is invoked through uvx for downloads:
// https://docs.overturemaps.org/getting-data/overturemaps-py/

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { decodePng, terrariumToMeters } from './terrain.mjs'

export const OVERTURE_BUILDINGS_SOURCE = 'Overture Maps Foundation — buildings theme'
export const OVERTURE_BUILDINGS_LICENSE = 'ODbL 1.0; upstream attribution retained by Overture'
export const OVERTURE_BUILDINGS_DOCS = 'https://docs.overturemaps.org/guides/buildings/'
export const OVERTURE_ATTRIBUTION = '© OpenStreetMap contributors, Overture Maps Foundation'
export const OVERTURE_DATA_RELEASE = '2026-06-17.0'
export const OVERTURE_SCHEMA_VERSION = 'v1.17.0'
export const OVERTURE_CLIENT_VERSION = '1.0.1'
export const OVERTURE_STAC_COLLECTION =
  `https://stac.overturemaps.org/${OVERTURE_DATA_RELEASE}/buildings/building/collection.json`

const MAX_RING_VERTICES = 10
const FLOOR_HEIGHT_M = 3

const finitePositive = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function evenlySpacedIndexes(length, count) {
  if (count >= length) return Array.from({ length }, (_, i) => i)
  const result = []
  for (let i = 0; i < count; i++) result.push(Math.floor(i * length / count))
  return result
}

/** Deterministically reduce a closed ring to at most ten coordinates, including closure. */
export function simplifyClosedRing(ring, maxVertices = MAX_RING_VERTICES) {
  if (!Array.isArray(ring) || ring.length < 4) return null
  const open = ring.slice(0, -1)
  const first = ring[0]
  const last = ring[ring.length - 1]
  const isClosed = first?.[0] === last?.[0] && first?.[1] === last?.[1]
  const unique = isClosed ? open : ring
  if (unique.length < 3) return null
  const limit = Math.max(3, maxVertices - 1)
  const sampled = evenlySpacedIndexes(unique.length, Math.min(unique.length, limit))
    .map((i) => [Number(unique[i][0]), Number(unique[i][1])])
    .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
  if (sampled.length < 3) return null
  return [...sampled, [...sampled[0]]]
}

function simplifyPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null
  const rings = polygon.map((ring) => simplifyClosedRing(ring)).filter(Boolean)
  return rings.length > 0 ? rings : null
}

function simplifyGeometry(geometry) {
  if (geometry?.type === 'Polygon') {
    const coordinates = simplifyPolygon(geometry.coordinates)
    return coordinates ? { type: 'Polygon', coordinates } : null
  }
  if (geometry?.type === 'MultiPolygon') {
    const coordinates = geometry.coordinates.map(simplifyPolygon).filter(Boolean)
    return coordinates.length > 0 ? { type: 'MultiPolygon', coordinates } : null
  }
  return null
}

function exteriorCoordinates(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates[0]
  return geometry.coordinates.flatMap((polygon) => polygon[0])
}

function centroid(geometry) {
  const points = exteriorCoordinates(geometry)
  const sum = points.reduce((acc, [lng, lat]) => [acc[0] + lng, acc[1] + lat], [0, 0])
  return { lng: sum[0] / points.length, lat: sum[1] / points.length }
}

function resolvedHeight(properties = {}) {
  const measured = finitePositive(properties.height)
  if (measured !== null) return { h: measured, hSrc: 'measured' }
  const floors = finitePositive(properties.num_floors)
  if (floors !== null) return { h: Math.round(floors * FLOOR_HEIGHT_M * 100) / 100, hSrc: 'inferred' }
  return null
}

/**
 * Convert an Overture GeoJSON FeatureCollection into the compact frozen app fixture.
 * A terrain sampler is mandatory: `base` is ground elevation MSL, never a guessed zero.
 */
export function normalizeOvertureBuildings(collection, { groundElevation }) {
  if (typeof groundElevation !== 'function') throw new Error('groundElevation sampler is required')
  const stats = { input: 0, output: 0, noHeight: 0, noTerrain: 0, invalidGeometry: 0 }
  const features = []

  for (const feature of collection?.features ?? []) {
    stats.input++
    const height = resolvedHeight(feature.properties)
    if (!height) { stats.noHeight++; continue }
    const geometry = simplifyGeometry(feature.geometry)
    if (!geometry) { stats.invalidGeometry++; continue }
    const center = centroid(geometry)
    const base = groundElevation(center.lat, center.lng)
    if (!Number.isFinite(base)) { stats.noTerrain++; continue }

    features.push({
      type: 'Feature',
      id: feature.id ?? feature.properties?.id,
      geometry,
      properties: {
        h: Math.round(height.h * 10) / 10,
        hSrc: height.hSrc,
        base: Math.round(base * 10) / 10,
      },
    })
  }

  features.sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
  stats.output = features.length
  return { collection: { type: 'FeatureCollection', features }, stats }
}

/** Build a bilinear terrain sampler from this repo's frozen Terrarium fixture. */
export function createTerrainSampler(pngBytes, header) {
  const decoded = decodePng(pngBytes)
  if (decoded.width !== header.width || decoded.height !== header.height) {
    throw new Error(`terrain PNG/header size mismatch: ${decoded.width}x${decoded.height} vs ${header.width}x${header.height}`)
  }
  const { west, south, east, north } = header.bounds
  const elevations = new Float64Array(decoded.width * decoded.height)
  for (let i = 0; i < elevations.length; i++) {
    const o = i * decoded.channels
    elevations[i] = terrariumToMeters(decoded.pixels[o], decoded.pixels[o + 1], decoded.pixels[o + 2])
  }

  const mercatorY = (lat) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat))
    const rad = clamped * Math.PI / 180
    return (1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2
  }
  const yNorth = mercatorY(north)
  const ySouth = mercatorY(south)

  return (lat, lng) => {
    if (lng < west || lng > east || lat < south || lat > north) return undefined
    const x = (lng - west) / (east - west) * (decoded.width - 1)
    const y = (mercatorY(lat) - yNorth) / (ySouth - yNorth) * (decoded.height - 1)
    const x0 = Math.max(0, Math.min(decoded.width - 1, Math.floor(x)))
    const y0 = Math.max(0, Math.min(decoded.height - 1, Math.floor(y)))
    const x1 = Math.min(decoded.width - 1, x0 + 1)
    const y1 = Math.min(decoded.height - 1, y0 + 1)
    const tx = x - x0
    const ty = y - y0
    const at = (px, py) => elevations[py * decoded.width + px]
    const a = at(x0, y0) * (1 - tx) + at(x1, y0) * tx
    const b = at(x0, y1) * (1 - tx) + at(x1, y1) * tx
    return a * (1 - ty) + b * ty
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

async function downloadOvertureGeoJson(bbox, output) {
  const uvx = process.platform === 'win32' ? 'uvx.exe' : 'uvx'
  await run(uvx, [
    '--from', `overturemaps==${OVERTURE_CLIENT_VERSION}`,
    'overturemaps', 'download',
    `--bbox=${bbox.join(',')}`,
    `--release=${OVERTURE_DATA_RELEASE}`,
    '--type=building',
    '-f', 'geojson',
    '-o', output,
  ])
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

export async function writeBuildingFixture({ dir, scenarioId, inputPath }) {
  const terrainHeader = JSON.parse(await readFile(new URL('terrain.json', dir), 'utf8'))
  const terrainPng = await readFile(new URL('terrain.png', dir))
  const groundElevation = createTerrainSampler(terrainPng, terrainHeader)
  const bbox = Object.values(terrainHeader.requestedBbox ?? terrainHeader.bounds)
  const temp = await mkdtemp(join(tmpdir(), 'drone-buildings-'))
  const downloadedPath = join(temp, 'overture-buildings.geojson')

  try {
    const sourcePath = inputPath ? inputPath : downloadedPath
    if (!inputPath) await downloadOvertureGeoJson(bbox, downloadedPath)
    const raw = JSON.parse(await readFile(sourcePath, 'utf8'))
    const normalized = normalizeOvertureBuildings(raw, { groundElevation })
    // GERS IDs are useful upstream join keys, but the runtime needs only geometry and
    // {h,hSrc,base}. Omitting UUIDs saves about 100 KB gzipped in this AO. Five decimal
    // coordinate places are roughly one metre here, aligned with the fixture's real accuracy.
    const runtimeCollection = {
      ...normalized.collection,
      features: normalized.collection.features.map(({ id: _id, ...feature }) => ({
        ...feature,
        geometry: {
          ...feature.geometry,
          coordinates: roundCoordinates(feature.geometry.coordinates, 5),
        },
      })),
    }
    const json = JSON.stringify(runtimeCollection) + '\n'
    const gzipBytes = gzipSync(json, { level: 9 }).byteLength
    await mkdir(dir, { recursive: true })
    await writeFile(new URL('buildings.json', dir), json)

    const manifestUrl = new URL('manifest.json', dir)
    const previous = await readFile(manifestUrl, 'utf8').then(JSON.parse).catch(() => null)
    const kept = (previous?.sources ?? []).filter((source) => source.fixture !== 'buildings.json')
    const source = {
      fixture: 'buildings.json',
      source: OVERTURE_BUILDINGS_SOURCE,
      url: OVERTURE_BUILDINGS_DOCS,
      license: OVERTURE_BUILDINGS_LICENSE,
      attribution: OVERTURE_ATTRIBUTION,
      retrievedAt: new Date().toISOString().slice(0, 10),
      sha256: sha256(json),
      rawBytes: Buffer.byteLength(json),
      gzipBytes,
      input: inputPath ? basename(inputPath) : `overturemaps==${OVERTURE_CLIENT_VERSION}`,
      dataRelease: OVERTURE_DATA_RELEASE,
      schemaVersion: OVERTURE_SCHEMA_VERSION,
      stacCollection: OVERTURE_STAC_COLLECTION,
      client: { package: 'overturemaps', version: OVERTURE_CLIENT_VERSION },
      filters: 'measured height, or num_floors × 3m; unknown-height footprints excluded',
    }
    const manifest = {
      scenarioId,
      area: { ...(previous?.area ?? {}), aoBbox: bbox },
      generatedAt: new Date().toISOString().slice(0, 10),
      sources: [...kept, source].sort((a, b) => a.fixture.localeCompare(b.fixture)),
    }
    await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n')
    return { ...normalized, bytes: Buffer.byteLength(json), gzipBytes, sha256: source.sha256 }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

function roundCoordinates(value, digits) {
  if (!Array.isArray(value)) return value
  if (typeof value[0] === 'number') return value.map((n) => Number(Number(n).toFixed(digits)))
  return value.map((child) => roundCoordinates(child, digits))
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[++i]
  }
  return out
}

async function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.id) throw new Error('usage: node tools/fixtures/buildings.mjs --id <scenarioId> [--input raw.geojson]')
  const dir = new URL(`../../src/scenarios/fixtures/${args.id}/`, import.meta.url)
  const result = await writeBuildingFixture({ dir, scenarioId: args.id, inputPath: args.input })
  console.log(
    `buildings: ${result.stats.output}/${result.stats.input} retained · ` +
    `${result.stats.noHeight} without height · ${(result.bytes / 1024).toFixed(1)} KB raw · ` +
    `${(result.gzipBytes / 1024).toFixed(1)} KB gzip`,
  )
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (invoked === import.meta.url || process.argv[1]?.endsWith('buildings.mjs')) {
  cli().catch((error) => {
    console.error('building fixture failed:', error.message)
    process.exit(1)
  })
}
