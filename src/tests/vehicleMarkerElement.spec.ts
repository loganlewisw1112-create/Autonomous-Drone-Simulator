// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  RECOVERY_CHIP_TEXT,
  createRecoveryChipElement,
  createVehicleMarkerElement,
  createVehiclePopupContent,
  popupStatusLine,
  updateVehicleMarkerElement,
  vehicleAltText,
  vehicleStatusLabel,
  vehicleTitle,
  type VehicleMarkerInit,
} from '@/components/vehicleMarkers'

const TACTICAL_CSS = readFileSync(join(process.cwd(), 'src/styles/tactical.css'), 'utf8')
const MARKERS_SRC = readFileSync(join(process.cwd(), 'src/components/vehicleMarkers.ts'), 'utf8')

const recoveryInit: VehicleMarkerInit = {
  id: 'rec-1',
  kind: 'recovery',
  variant: 'pickup',
  status: 'enroute',
  headingDeg: 123.4,
  lng: -122.41942,
  lat: 37.77493,
  lengthPx: 40,
  widthPx: 40 * 0.523,
}

const groundInit: VehicleMarkerInit = {
  id: 'gu-1',
  kind: 'ground',
  variant: 'truck',
  role: 'fire',
  status: 'enroute',
  headingDeg: 0,
  lng: -122.4,
  lat: 37.77,
  lengthPx: 36,
  widthPx: 36 * 0.534,
}

beforeAll(() => {
  const style = document.createElement('style')
  style.textContent = TACTICAL_CSS
  document.head.append(style)
})

afterEach(() => {
  document.body.replaceChildren()
})

describe('createVehicleMarkerElement', () => {
  it('builds the recovery pickup marker with the data attributes the browser checks read', () => {
    const el = createVehicleMarkerElement(recoveryInit)
    document.body.append(el)
    expect(el.dataset.vehicleId).toBe('rec-1')
    expect(el.dataset.vehicleKind).toBe('recovery')
    expect(el.dataset.status).toBe('enroute')
    expect(Number(el.dataset.heading)).toBeCloseTo(123.4, 1)
    expect(Number(el.dataset.lng)).toBeCloseTo(-122.41942, 6)
    expect(Number(el.dataset.lat)).toBeCloseTo(37.77493, 6)
  })

  it('draws the pickup art: 128 src, 256 at 2x, async decoding and a role + status alt', () => {
    const el = createVehicleMarkerElement(recoveryInit)
    const img = el.querySelector('img') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.getAttribute('src')!.endsWith('recovery-unit-pickup-128.png')).toBe(true)
    expect(img.getAttribute('srcset')).toContain('recovery-unit-pickup-256.png 2x')
    expect(img.getAttribute('srcset')).toContain('recovery-unit-pickup-128.png 1x')
    expect(img.getAttribute('decoding')).toBe('async')
    expect(img.getAttribute('alt')).toBe('Drone recovery team, enroute')
    expect(img.getAttribute('draggable')).toBe('false')
    expect(img.style.width).toBe('20.92px')
    expect(img.style.height).toBe('40px')
    expect(el.style.width).toBe('20.92px')
    expect(el.style.height).toBe('40px')
  })

  it('draws the truck or suv for ground units and labels them by role', () => {
    const truck = createVehicleMarkerElement(groundInit)
    expect(truck.dataset.vehicleKind).toBe('ground')
    expect(truck.querySelector('img')!.getAttribute('src')!.endsWith('ground-unit-truck-128.png')).toBe(true)
    expect(truck.querySelector('img')!.getAttribute('alt')).toBe('Fire unit, enroute')
    const suv = createVehicleMarkerElement({ ...groundInit, id: 'gu-2', variant: 'suv', role: 'law_enforcement' })
    expect(suv.querySelector('img')!.getAttribute('src')!.endsWith('ground-unit-suv-128.png')).toBe(true)
    expect(suv.querySelector('img')!.getAttribute('alt')).toBe('Law enforcement unit, enroute')
  })

  it('leaves position and transform to MapLibre', () => {
    const el = createVehicleMarkerElement(recoveryInit)
    expect(el.style.position).toBe('')
    expect(el.style.transform).toBe('')
  })

  it('holds a .vehicle-pulse child that shows only while on scene', () => {
    const el = createVehicleMarkerElement(recoveryInit)
    const pulse = el.querySelector('.vehicle-pulse') as HTMLElement
    expect(pulse).not.toBeNull()
    expect(pulse.parentElement).toBe(el)
    expect(pulse.hidden).toBe(true)
    updateVehicleMarkerElement(el, { status: 'on_scene' })
    expect(pulse.hidden).toBe(false)
    updateVehicleMarkerElement(el, { status: 'extracted' })
    expect(pulse.hidden).toBe(true)
    const onScene = createVehicleMarkerElement({ ...recoveryInit, id: 'rec-2', status: 'on_scene' })
    expect((onScene.querySelector('.vehicle-pulse') as HTMLElement).hidden).toBe(false)
  })
})

describe('updateVehicleMarkerElement', () => {
  it('refreshes the attributes, alt, size and hidden state in place', () => {
    const el = createVehicleMarkerElement(groundInit)
    const img = el.querySelector('img') as HTMLImageElement
    updateVehicleMarkerElement(el, {
      status: 'on_scene',
      headingDeg: 271.26,
      lng: -122.5,
      lat: 37.8,
      lengthPx: 80,
      widthPx: 80 * 0.534,
      hidden: true,
    })
    expect(el.dataset.status).toBe('on_scene')
    expect(Number(el.dataset.heading)).toBeCloseTo(271.3, 1)
    expect(Number(el.dataset.lng)).toBeCloseTo(-122.5, 6)
    expect(Number(el.dataset.lat)).toBeCloseTo(37.8, 6)
    expect(img.getAttribute('alt')).toBe('Fire unit, on scene')
    expect(img.style.height).toBe('80px')
    expect(el.style.height).toBe('80px')
    expect(el.style.opacity).toBe('0')
    expect(el.dataset.hidden).toBe('true')
    updateVehicleMarkerElement(el, { hidden: false })
    expect(el.style.opacity).toBe('')
    expect(el.dataset.hidden).toBe('false')
    // Untouched fields stay as they were.
    expect(el.dataset.vehicleId).toBe('gu-1')
    expect(img.getAttribute('src')!.endsWith('ground-unit-truck-128.png')).toBe(true)
  })

  it('keeps the identity attributes when only the status changes', () => {
    const el = createVehicleMarkerElement(recoveryInit)
    updateVehicleMarkerElement(el, { status: 'on_scene' })
    expect(el.dataset.vehicleId).toBe('rec-1')
    expect(el.dataset.vehicleKind).toBe('recovery')
    expect(el.querySelector('img')!.getAttribute('alt')).toBe('Drone recovery team, on scene')
  })
})

describe('vehicle labels', () => {
  it('maps status tokens to words', () => {
    expect(vehicleStatusLabel('enroute')).toBe('Enroute')
    expect(vehicleStatusLabel('on_scene')).toBe('On scene')
    expect(vehicleStatusLabel('extracted')).toBe('Recovered')
    expect(vehicleStatusLabel('dispatched')).toBe('Dispatched')
    expect(vehicleStatusLabel('returning')).toBe('Returning')
    expect(vehicleStatusLabel('standby')).toBe('Standby')
    expect(vehicleStatusLabel('mystery')).toBe('mystery')
  })

  it('builds the alt text from role and status', () => {
    expect(vehicleAltText('recovery', 'recovery', 'on_scene')).toBe('Drone recovery team, on scene')
    expect(vehicleAltText('ground', 'medical', 'enroute')).toBe('Medical unit, enroute')
    expect(vehicleAltText('ground', undefined, 'enroute')).toBe('Ground unit, enroute')
    expect(vehicleAltText('ground', 'constructor', 'enroute')).toBe('Ground unit, enroute')
  })

  it('titles the popup by role', () => {
    expect(vehicleTitle('recovery', undefined)).toBe('DRONE RECOVERY TEAM')
    expect(vehicleTitle('ground', 'law_enforcement')).toBe('LAW ENFORCEMENT')
    expect(vehicleTitle('ground', 'fire')).toBe('FIRE')
  })
})

describe('createRecoveryChipElement', () => {
  it('reads DRONE RECOVERY and is tied to its team', () => {
    const chip = createRecoveryChipElement({ id: 'rec-1' })
    document.body.append(chip)
    expect(RECOVERY_CHIP_TEXT).toBe('DRONE RECOVERY')
    expect(chip.textContent).toBe('DRONE RECOVERY')
    expect(chip.dataset.recoveryChip).toBe('rec-1')
    // No vehicle attributes: the browser checks that iterate [data-vehicle-id] must not see the chip.
    expect(chip.dataset.vehicleId).toBeUndefined()
    expect(chip.dataset.vehicleKind).toBeUndefined()
    expect(chip.getAttribute('aria-hidden')).toBe('true')
  })

  it('computes to at least 12px from tactical.css', () => {
    const chip = createRecoveryChipElement({ id: 'rec-1' })
    document.body.append(chip)
    const size = parseFloat(getComputedStyle(chip).fontSize)
    expect(Number.isFinite(size)).toBe(true)
    expect(size).toBeGreaterThanOrEqual(12)
  })

  it('does not rotate or intercept pointer events (the marker is viewport aligned)', () => {
    const chip = createRecoveryChipElement({ id: 'rec-1' })
    document.body.append(chip)
    expect(chip.style.transform).toBe('')
    expect(getComputedStyle(chip).pointerEvents).toBe('none')
  })
})

describe('createVehiclePopupContent', () => {
  const model = { title: 'DRONE RECOVERY TEAM', status: 'enroute', etaSec: 42.4 }

  it('builds role, status and ETA as text nodes', () => {
    const popup = createVehiclePopupContent(model)
    const field = (name: string) => popup.node.querySelector(`[data-popup-field="${name}"]`) as HTMLElement
    expect(field('title').textContent).toBe('DRONE RECOVERY TEAM')
    expect(field('status').textContent).toBe('Enroute')
    expect(field('eta').textContent).toBe('ETA 42 s')
    expect(field('note').hidden).toBe(true)
  })

  it('never parses markup: hostile text stays text', () => {
    const popup = createVehiclePopupContent({
      title: '<img src=x onerror=alert(1)>',
      status: 'enroute',
      note: '<b>wind</b>',
    })
    expect(popup.node.querySelector('img')).toBeNull()
    expect(popup.node.querySelector('b')).toBeNull()
    expect(popup.node.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(popup.node.textContent).toContain('<b>wind</b>')
  })

  it('updates the same nodes in place so an open popup never goes stale', () => {
    const popup = createVehiclePopupContent(model)
    const eta = popup.node.querySelector('[data-popup-field="eta"]') as HTMLElement
    const status = popup.node.querySelector('[data-popup-field="status"]') as HTMLElement
    popup.update({ ...model, etaSec: 7 })
    expect(popup.node.querySelector('[data-popup-field="eta"]')).toBe(eta)
    expect(eta.textContent).toBe('ETA 7 s')
    popup.update({ title: 'DRONE RECOVERY TEAM', status: 'on_scene', crewOnFootM: 82.6, walkSecLeft: 31.2, note: 'Gusts 12 kt' })
    expect(popup.node.querySelector('[data-popup-field="status"]')).toBe(status)
    expect(status.textContent).toBe('On scene · crew on foot 83 m · 32 s')
    expect(eta.hidden).toBe(true)
    expect(eta.textContent).toBe('')
    const note = popup.node.querySelector('[data-popup-field="note"]') as HTMLElement
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe('Gusts 12 kt')
    popup.update({ ...model, status: 'enroute' })
    expect(note.hidden).toBe(true)
    expect(eta.hidden).toBe(false)
  })

  it('formats the status line', () => {
    expect(popupStatusLine({ title: 't', status: 'on_scene', crewOnFootM: 40 })).toBe('On scene · crew on foot 40 m')
    expect(popupStatusLine({ title: 't', status: 'on_scene', crewOnFootM: 40, walkSecLeft: 10 })).toBe('On scene · crew on foot 40 m · 10 s')
    expect(popupStatusLine({ title: 't', status: 'on_scene' })).toBe('On scene')
    expect(popupStatusLine({ title: 't', status: 'on_scene', crewOnFootM: 0 })).toBe('On scene')
    expect(popupStatusLine({ title: 't', status: 'enroute', crewOnFootM: 40 })).toBe('Enroute')
  })

  it('is at least 12px', () => {
    const popup = createVehiclePopupContent(model)
    document.body.append(popup.node)
    expect(parseFloat(getComputedStyle(popup.node).fontSize)).toBeGreaterThanOrEqual(12)
  })
})

describe('tactical.css pulse rules', () => {
  it('defines the vehicle-pulse keyframes', () => {
    expect(TACTICAL_CSS).toMatch(/@keyframes\s+vehicle-pulse\s*\{/)
    expect(TACTICAL_CSS).toMatch(/\.vehicle-pulse\s*\{[^}]*animation:\s*vehicle-pulse/)
  })

  it('stills the ring under prefers-reduced-motion', () => {
    expect(TACTICAL_CSS).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.vehicle-pulse\s*\{\s*animation:\s*none;\s*opacity:\s*\.6;?\s*\}\s*\}/,
    )
  })
})

describe('module hygiene', () => {
  it('does not import maplibre-gl, so jsdom specs and non-map code can use it', () => {
    // Comments may mention maplibre; an import (static, type-only or dynamic) may not.
    expect(MARKERS_SRC).not.toMatch(/(?:from|import)\s*\(?\s*['"]maplibre/i)
    expect(MARKERS_SRC).not.toMatch(/require\(\s*['"]maplibre/i)
  })
})
