import { describe, expect, it } from 'vitest'
import { scene3dEnabled } from '@/scene3d/flag'
import { SCENE3D_FIT_PITCH, scenarioFitCamera } from '@/components/TacticalMap'

describe('scenarioFitCamera', () => {
  it('tilts scenario framing when the 3D layer is on', () => {
    expect(scenarioFitCamera('desktop', true)).toEqual({ padding: 80, maxZoom: 16, pitch: SCENE3D_FIT_PITCH })
  })

  it('passes no pitch at all with the layer off, so 2D framing is unchanged (a manual tilt survives a recenter)', () => {
    expect(scenarioFitCamera('desktop', false)).toEqual({ padding: 80, maxZoom: 16 })
    expect('pitch' in scenarioFitCamera('phone-portrait', false)).toBe(false)
    expect('pitch' in scenarioFitCamera('phone-landscape', false)).toBe(false)
  })
})

const TARGETS = ['windows', 'classroom', 'mobile'] as const
const MODES = ['desktop', 'phone-portrait', 'phone-landscape'] as const

describe('scene3dEnabled', () => {
  it('is on by default for the desktop presentation of windows and classroom', () => {
    expect(scene3dEnabled('', 'windows', 'desktop')).toBe(true)
    expect(scene3dEnabled('', 'classroom', 'desktop')).toBe(true)
    expect(scene3dEnabled('?map=fallback', 'windows', 'desktop')).toBe(true)
  })

  it('is off by default on the mobile target, which omits desktop 3D', () => {
    for (const mode of MODES) expect(scene3dEnabled('', 'mobile', mode)).toBe(false)
  })

  it('is off by default on a phone shell, whatever the target (classroom students join on phones)', () => {
    expect(scene3dEnabled('', 'classroom', 'phone-portrait')).toBe(false)
    expect(scene3dEnabled('', 'classroom', 'phone-landscape')).toBe(false)
    expect(scene3dEnabled('', 'windows', 'phone-portrait')).toBe(false)
  })

  it('?scene3d=1 forces it on for every target and presentation', () => {
    for (const target of TARGETS) for (const mode of MODES) expect(scene3dEnabled('?scene3d=1', target, mode)).toBe(true)
  })

  it('?scene3d=0 forces it off for every target and presentation', () => {
    for (const target of TARGETS) for (const mode of MODES) expect(scene3dEnabled('?scene3d=0', target, mode)).toBe(false)
  })

  it('ignores values other than 0 and 1', () => {
    expect(scene3dEnabled('?scene3d=yes', 'windows', 'desktop')).toBe(true)
    expect(scene3dEnabled('?scene3d=yes', 'mobile', 'desktop')).toBe(false)
  })
})
