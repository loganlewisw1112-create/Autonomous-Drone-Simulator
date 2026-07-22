import { describe, it, expect } from 'vitest'
import {
  pixelsAcrossTarget, rangeForPixels, platformTaskRanges, focalLengthFromHfov, JOHNSON_PIXELS,
} from '@/sim/sensors/thermalRange'
import { PLATFORM_CATALOG, LEGACY_PLATFORM } from '@/sim/drone/platformCatalog'

describe('Johnson thermal range geometry', () => {
  it('reproduces the §18.1 worked anchor: 12 µm, 13 mm, 100 m, 0.5 m → 5.4 px', () => {
    const px = pixelsAcrossTarget({ targetSizeM: 0.5, focalLengthMm: 13, pixelPitchUm: 12, rangeM: 100 })
    expect(px).toBeCloseTo(5.417, 2)
  })

  it('rangeForPixels inverts pixelsAcrossTarget', () => {
    const optics = { targetSizeM: 0.5, focalLengthMm: 13, pixelPitchUm: 12 }
    const rDet = rangeForPixels({ ...optics, pixelsRequired: JOHNSON_PIXELS.detection })
    expect(rDet).toBeCloseTo(270.83, 1)
    // At that range the target subtends exactly the detection threshold.
    expect(pixelsAcrossTarget({ ...optics, rangeM: rDet })).toBeCloseTo(JOHNSON_PIXELS.detection, 6)
  })

  it('orders detection > recognition > identification range', () => {
    const r = platformTaskRanges({ sensor: 'test', resolutionPx: [640, 512], pixelPitchUm: 12, focalLengthMm: 13, netdMk: 30 }, 0.5)
    expect(r).not.toBeNull()
    expect(r!.detectionM).toBeGreaterThan(r!.recognitionM)
    expect(r!.recognitionM).toBeGreaterThan(r!.identificationM)
  })

  it('returns null (not a guess) when focal length is unpublished', () => {
    // Every catalog focal length is currently null, so no platform yields a range yet.
    expect(platformTaskRanges(PLATFORM_CATALOG.skydio_x10.thermal, 0.5)).toBeNull()
    expect(platformTaskRanges(LEGACY_PLATFORM.thermal, 0.5)).toBeNull()
  })

  it('derives focal length from a published HFOV (the practical bridge)', () => {
    // A 640 px, 12 µm sensor at 32.914° HFOV back-solves to a 13 mm lens.
    expect(focalLengthFromHfov(32.914, 640, 12)).toBeCloseTo(13, 1)
  })
})

describe('platform thermal sensor specs (WP-1)', () => {
  it('carries sourced integrated payloads with 12 µm FLIR pitch', () => {
    expect(PLATFORM_CATALOG.skydio_x10.thermal).toMatchObject({ sensor: 'FLIR Boson+', resolutionPx: [640, 512], pixelPitchUm: 12, netdMk: 30 })
    expect(PLATFORM_CATALOG.skydio_x10d.thermal).toMatchObject({ resolutionPx: [640, 512], netdMk: 30 })
    expect(PLATFORM_CATALOG.parrot_anafi_usa.thermal).toMatchObject({ sensor: 'FLIR Boson', resolutionPx: [320, 256] })
    expect(PLATFORM_CATALOG.teal_2.thermal).toMatchObject({ resolutionPx: [640, 512] })
    expect(PLATFORM_CATALOG.brinc_lemur_2.thermal).toMatchObject({ sensor: 'FLIR Lepton', resolutionPx: [160, 120] })
  })

  it('leaves modular-payload airframes as null, never a guessed sensor', () => {
    expect(PLATFORM_CATALOG.freefly_astro_max.thermal).toBeNull()
  })

  it('never guesses an unpublished field (focal length always null so far)', () => {
    for (const spec of Object.values(PLATFORM_CATALOG)) {
      if (spec.thermal) expect(spec.thermal.focalLengthMm).toBeNull()
    }
  })
})
