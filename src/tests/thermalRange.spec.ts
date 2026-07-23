import { describe, it, expect } from 'vitest'
import {
  pixelsAcrossTarget, rangeForPixels, platformTaskRanges, focalLengthFromHfov,
  effectiveFocalLengthMm, JOHNSON_PIXELS, thermalContrastThresholdC,
  thermalTransmission, effectiveDetectionRangeM,
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
    const r = platformTaskRanges({ sensor: 'test', resolutionPx: [640, 512], pixelPitchUm: 12, focalLengthMm: 13, hfovDeg: null, netdMk: 30 }, 0.5)
    expect(r).not.toBeNull()
    expect(r!.detectionM).toBeGreaterThan(r!.recognitionM)
    expect(r!.recognitionM).toBeGreaterThan(r!.identificationM)
  })

  it('returns null (not a guess) when neither focal length nor HFOV is published', () => {
    // BRINC does not state which Lepton lens variant the Lemur 2 carries (50/57/95/160° are all
    // offered), so its range genuinely cannot be computed — and must not be invented.
    expect(platformTaskRanges(PLATFORM_CATALOG.brinc_lemur_2.thermal, 0.5)).toBeNull()
    expect(platformTaskRanges(LEGACY_PLATFORM.thermal, 0.5)).toBeNull()
    expect(platformTaskRanges(null, 0.5)).toBeNull()
  })

  it('computes a real range for every platform whose optics are published', () => {
    for (const id of ['skydio_x10', 'skydio_x10d', 'parrot_anafi_usa', 'teal_2'] as const) {
      const r = platformTaskRanges(PLATFORM_CATALOG[id].thermal, 0.5)
      expect(r, id).not.toBeNull()
      expect(r!.detectionM).toBeGreaterThan(r!.recognitionM)
      expect(r!.recognitionM).toBeGreaterThan(r!.identificationM)
    }
  })

  it('detects a 0.5 m human further with a 640 px core than a 320 px one', () => {
    // Same 12 µm pitch and the same Johnson threshold: the wider-aperture 640 core wins.
    const x10 = platformTaskRanges(PLATFORM_CATALOG.skydio_x10.thermal, 0.5)!
    const anafi = platformTaskRanges(PLATFORM_CATALOG.parrot_anafi_usa.thermal, 0.5)!
    expect(x10.detectionM).toBeGreaterThan(anafi.detectionM)
  })

  it('derives focal length from a published HFOV (the practical bridge)', () => {
    // A 640 px, 12 µm sensor at 32.914° HFOV back-solves to a 13 mm lens.
    expect(focalLengthFromHfov(32.914, 640, 12)).toBeCloseTo(13, 1)
  })
})

describe('live thermal range gates (WP-5)', () => {
  it('scales the 2 C contrast threshold from published NETD', () => {
    expect(thermalContrastThresholdC(PLATFORM_CATALOG.skydio_x10.thermal)).toBe(2)
    expect(thermalContrastThresholdC(PLATFORM_CATALOG.parrot_anafi_usa.thermal)).toBe(2.4)
    expect(thermalContrastThresholdC(PLATFORM_CATALOG.teal_2.thermal)).toBeNull()
    expect(thermalContrastThresholdC(null)).toBeNull()
  })

  it('keeps clear LWIR at 1 and bounds fog/marine transmission to 0.5..0.7', () => {
    expect(thermalTransmission()).toBe(1)
    expect(thermalTransmission({ activeHazards: [], visibilityMi: 0 })).toBe(1)
    expect(thermalTransmission({ activeHazards: ['fog'], visibilityMi: 0 })).toBe(0.5)
    expect(thermalTransmission({ activeHazards: ['fog'], visibilityMi: 2.5 })).toBe(0.6)
    expect(thermalTransmission({ activeHazards: ['marine_layer'], visibilityMi: 5 })).toBe(0.7)
    expect(thermalTransmission({ activeHazards: ['marine_layer'], visibilityMi: 50 })).toBe(0.7)
  })

  it('does not invent rain or smoke transmission coefficients', () => {
    expect(thermalTransmission({ activeHazards: ['rain'], visibilityMi: 0.1 })).toBe(1)
    expect(thermalTransmission({ activeHazards: ['smoke'], visibilityMi: 0.1 })).toBe(1)
  })

  it('multiplies Johnson range by transmission and fails closed on unknown sensor data', () => {
    const sensor = PLATFORM_CATALOG.skydio_x10.thermal
    const clearRange = platformTaskRanges(sensor, 0.5)!.detectionM
    expect(effectiveDetectionRangeM(sensor, 0.5, 1)).toBeCloseTo(clearRange, 10)
    expect(effectiveDetectionRangeM(sensor, 0.5, 0.6)).toBeCloseTo(clearRange * 0.6, 10)

    // Teal has optics but no published NETD; BRINC has neither published optics nor NETD.
    expect(effectiveDetectionRangeM(PLATFORM_CATALOG.teal_2.thermal, 0.5)).toBeNull()
    expect(effectiveDetectionRangeM(PLATFORM_CATALOG.brinc_lemur_2.thermal, 0.5)).toBeNull()
    expect(effectiveDetectionRangeM(null, 0.5)).toBeNull()
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

  it('sources optics from the manufacturer by either published route, or leaves them null', () => {
    // Skydio and Teal publish an EFL directly; Parrot publishes only an HFOV, which the model
    // back-solves. BRINC publishes neither, so the Lemur 2 must stay uncomputable.
    expect(PLATFORM_CATALOG.skydio_x10.thermal!.focalLengthMm).toBe(13.6)
    expect(PLATFORM_CATALOG.teal_2.thermal!.focalLengthMm).toBe(13.6)
    expect(PLATFORM_CATALOG.parrot_anafi_usa.thermal!.focalLengthMm).toBeNull()
    expect(PLATFORM_CATALOG.parrot_anafi_usa.thermal!.hfovDeg).toBe(50)
    expect(PLATFORM_CATALOG.brinc_lemur_2.thermal!.focalLengthMm).toBeNull()
    expect(PLATFORM_CATALOG.brinc_lemur_2.thermal!.hfovDeg).toBeNull()
  })

  it('reproduces the published FOV from the sourced focal length', () => {
    // Teal publishes 32° HFOV for the Hadron 640R at EFL 13.6 mm; the geometry must agree.
    expect(focalLengthFromHfov(32, 640, 12)).toBeCloseTo(13.6, 0)
    // And the Parrot derivation is a real number, not a fallback.
    const anafi = effectiveFocalLengthMm(PLATFORM_CATALOG.parrot_anafi_usa.thermal)
    expect(anafi).toBeCloseTo(4.12, 1)
  })
})
