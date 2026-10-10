import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VEHICLE_ASPECT } from '@/components/vehicleAvatars'

const DIR = join(process.cwd(), 'public', 'ground-units')

const SIX = [
  'ground-unit-truck-128.png',
  'ground-unit-truck-256.png',
  'ground-unit-suv-128.png',
  'ground-unit-suv-256.png',
  'recovery-unit-pickup-128.png',
  'recovery-unit-pickup-256.png',
] as const

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ihdr(name: string) {
  const bytes = readFileSync(join(DIR, name))
  return {
    signature: [...bytes.subarray(0, 8)],
    chunk: bytes.subarray(12, 16).toString('latin1'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
  }
}

describe('ground unit vehicle art', () => {
  it('ships all six PNGs in public/ground-units', () => {
    for (const name of SIX) expect(existsSync(join(DIR, name)), name).toBe(true)
  })

  it('ships nothing else there (no -full or preview files)', () => {
    expect(readdirSync(DIR).sort()).toEqual([...SIX].sort())
  })

  it.each(SIX)('%s is a real PNG with an RGBA IHDR', (name) => {
    const header = ihdr(name)
    expect(header.signature).toEqual(PNG_SIGNATURE)
    expect(header.chunk).toBe('IHDR')
    expect(header.colourType).toBe(6)
    expect(header.bitDepth).toBe(8)
  })

  // Owner's final art (files dated 2026-10-09 11:18). The plan text still says 75 x 128
  // for the truck and SUV; the delivered 128 files measure 68 and 66 px wide.
  it.each([
    ['ground-unit-truck-128.png', 68, 128, 'truck'],
    ['ground-unit-suv-128.png', 66, 128, 'suv'],
    ['recovery-unit-pickup-128.png', 67, 128, 'pickup'],
  ] as const)('%s is %i x %i and matches the aspect constant', (name, width, height, variant) => {
    const header = ihdr(name)
    expect(header.width).toBe(width)
    expect(header.height).toBe(height)
    expect(Math.abs(header.width / header.height - VEHICLE_ASPECT[variant])).toBeLessThanOrEqual(0.01)
  })

  it.each([
    ['ground-unit-truck-256.png', 137, 256],
    ['ground-unit-suv-256.png', 131, 256],
    ['recovery-unit-pickup-256.png', 134, 256],
  ] as const)('%s is %i x %i', (name, width, height) => {
    const header = ihdr(name)
    expect(header.width).toBe(width)
    expect(header.height).toBe(height)
  })
})
