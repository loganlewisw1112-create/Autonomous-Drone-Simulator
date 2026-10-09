// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

// TacticalMap cannot build a Map in jsdom, so MapLibre's Marker and Popup are replaced with
// recording fakes. syncVehicleMarkers is the diff between the plan and the marker refs, which is
// the part of the component that carries the c4b behaviour.
const created = vi.hoisted(() => ({ markers: [] as unknown[], popups: [] as unknown[] }))

vi.mock('maplibre-gl', () => {
  class FakePopup {
    node: HTMLElement | null = null
    open = false
    offset: unknown
    handlers: Record<string, Array<() => void>> = {}
    setHTMLCalls = 0
    constructor(opts: { offset?: unknown } = {}) { this.offset = opts.offset; created.popups.push(this) }
    setDOMContent(node: HTMLElement) { this.node = node; return this }
    setHTML() { this.setHTMLCalls += 1; return this }
    setOffset(o: unknown) { this.offset = o; return this }
    isOpen() { return this.open }
    on(event: string, fn: () => void) { (this.handlers[event] ??= []).push(fn); return this }
    emit(event: string) { for (const fn of this.handlers[event] ?? []) fn() }
  }
  class FakeMarker {
    el: HTMLElement
    opts: Record<string, unknown>
    lngLat: [number, number] | null = null
    rotation: number
    offset: { x: number; y: number }
    popup: FakePopup | null = null
    map: unknown = null
    removed = false
    setRotationCalls = 0
    constructor(opts: { element: HTMLElement; rotation?: number; offset?: [number, number] }) {
      this.opts = opts
      this.el = opts.element
      this.rotation = opts.rotation ?? 0
      this.offset = { x: opts.offset?.[0] ?? 0, y: opts.offset?.[1] ?? 0 }
      created.markers.push(this)
    }
    setLngLat(ll: [number, number]) { this.lngLat = ll; return this }
    setPopup(p: FakePopup) { this.popup = p; return this }
    addTo(map: unknown) { this.map = map; return this }
    getElement() { return this.el }
    getRotation() { return this.rotation }
    setRotation(r: number) { this.rotation = r; this.setRotationCalls += 1; return this }
    getOffset() { return this.offset }
    setOffset(o: [number, number]) { this.offset = { x: o[0], y: o[1] }; return this }
    remove() { this.removed = true; return this }
  }
  return { Marker: FakeMarker, Popup: FakePopup }
})

import { syncVehicleMarkers, type VehicleEntry } from '@/components/TacticalMap'
import type { VehiclePlan } from '@/components/vehicleMarkerPlan'

interface FakePopupT { node: HTMLElement; open: boolean; offset: unknown; setHTMLCalls: number; emit(e: string): void }
interface FakeMarkerT {
  el: HTMLElement; opts: Record<string, unknown>; lngLat: [number, number]; rotation: number
  offset: { x: number; y: number }; popup: FakePopupT; map: unknown; removed: boolean; setRotationCalls: number
}
const markerOf = (entry: VehicleEntry) => entry.marker as unknown as FakeMarkerT
const popupOf = (entry: VehicleEntry) => entry.popup as unknown as FakePopupT

const MAP = { fake: 'map' } as never

function plan(over: Partial<VehiclePlan> & { id: string }): VehiclePlan {
  return {
    kind: 'ground',
    variant: 'truck',
    role: 'intervention',
    status: 'enroute',
    lng: -122.4,
    lat: 37.77,
    headingDeg: 90,
    lengthPx: 36,
    widthPx: 19.2,
    hidden: false,
    popup: { title: 'INTERVENTION', status: 'enroute', etaSec: 40 },
    ...over,
  }
}

const recovery = (over: Partial<VehiclePlan> & { id: string }): VehiclePlan =>
  plan({
    kind: 'recovery', variant: 'pickup', role: undefined, widthPx: 18.8,
    chipOffset: [0, -28], popup: { title: 'DRONE RECOVERY TEAM', status: 'enroute', etaSec: 60 },
    ...over,
  })

beforeEach(() => { created.markers.length = 0; created.popups.length = 0 })

describe('syncVehicleMarkers: ground units', () => {
  it('adds an image marker, map-aligned, rotated to the heading, with a DOM-content popup', () => {
    const entries = new Map<string, VehicleEntry>()
    syncVehicleMarkers(MAP, [plan({ id: 'g1', headingDeg: 135 })], entries)
    const entry = entries.get('g1')!
    const marker = markerOf(entry)
    expect(marker.opts.rotationAlignment).toBe('map')
    expect(marker.opts.pitchAlignment).toBe('map')
    expect(marker.opts.rotation).toBe(135)
    expect(marker.lngLat).toEqual([-122.4, 37.77])
    expect(marker.map).toBe(MAP)
    const img = marker.el.querySelector('img')!
    expect(img.getAttribute('src')).toContain('ground-unit-truck-128.png')
    expect(img.getAttribute('alt')).toBe('Intervention unit, enroute')
    expect(marker.el.dataset.vehicleId).toBe('g1')
    expect(marker.el.dataset.vehicleKind).toBe('ground')
    // MapLibre owns position and transform; the wrapper never sets either.
    expect(marker.el.style.position).toBe('')
    expect(marker.el.style.transform).toBe('')
    const popup = popupOf(entry)
    expect(popup.setHTMLCalls).toBe(0)
    expect(popup.node.textContent).toContain('INTERVENTION')
  })

  it('updates the same marker in place on every frame and only rotates when the heading changes', () => {
    const entries = new Map<string, VehicleEntry>()
    syncVehicleMarkers(MAP, [plan({ id: 'g1' })], entries)
    const first = entries.get('g1')!
    syncVehicleMarkers(MAP, [plan({ id: 'g1', lng: -122.399, lat: 37.771, status: 'on_scene' })], entries)
    expect(entries.get('g1')).toBe(first)
    expect(created.markers).toHaveLength(1)
    const marker = markerOf(first)
    expect(marker.lngLat).toEqual([-122.399, 37.771])
    expect(marker.setRotationCalls).toBe(0)   // heading unchanged
    expect(marker.el.dataset.status).toBe('on_scene')
    expect(marker.el.dataset.lng).toBe('-122.3990000')
    expect(marker.el.querySelector('img')!.getAttribute('alt')).toBe('Intervention unit, on scene')
    syncVehicleMarkers(MAP, [plan({ id: 'g1', headingDeg: 10 })], entries)
    expect(marker.rotation).toBe(10)
    expect(marker.setRotationCalls).toBe(1)
  })

  it('resizes with the zoom and hides the wrapper inside a tunnel', () => {
    const entries = new Map<string, VehicleEntry>()
    syncVehicleMarkers(MAP, [plan({ id: 'g1' })], entries)
    syncVehicleMarkers(MAP, [plan({ id: 'g1', lengthPx: 80, widthPx: 42.7, hidden: true })], entries)
    const el = markerOf(entries.get('g1')!).el
    expect(el.querySelector('img')!.style.height).toBe('80px')
    expect(el.style.opacity).toBe('0')
    expect(el.dataset.hidden).toBe('true')
    syncVehicleMarkers(MAP, [plan({ id: 'g1', lengthPx: 80, widthPx: 42.7 })], entries)
    expect(el.style.opacity).toBe('')
  })

  it('removes the marker when its id leaves the plan, and keeps the others', () => {
    const entries = new Map<string, VehicleEntry>()
    syncVehicleMarkers(MAP, [plan({ id: 'a' }), plan({ id: 'b' })], entries)
    const a = markerOf(entries.get('a')!)
    const b = markerOf(entries.get('b')!)
    syncVehicleMarkers(MAP, [plan({ id: 'b' })], entries)
    expect([...entries.keys()]).toEqual(['b'])
    expect(a.removed).toBe(true)
    expect(b.removed).toBe(false)
  })

  it('refreshes popup text on every update while open, and once on open', () => {
    const entries = new Map<string, VehicleEntry>()
    syncVehicleMarkers(MAP, [plan({ id: 'g1' })], entries)
    const entry = entries.get('g1')!
    const popup = popupOf(entry)
    const eta = () => popup.node.querySelector('[data-popup-field=eta]')!.textContent
    expect(eta()).toBe('ETA 40 s')
    // Closed: the text may lag...
    syncVehicleMarkers(MAP, [plan({ id: 'g1', popup: { title: 'INTERVENTION', status: 'enroute', etaSec: 30 } })], entries)
    expect(eta()).toBe('ETA 40 s')
    // ...and is brought up to date when the popup opens.
    popup.emit('open')
    expect(eta()).toBe('ETA 30 s')
    // Open: refreshed on each store update.
    popup.open = true
    syncVehicleMarkers(MAP, [plan({ id: 'g1', popup: { title: 'INTERVENTION', status: 'on_scene', crewOnFootM: 80 } })], entries)
    expect(popup.node.querySelector('[data-popup-field=status]')!.textContent).toBe('On scene · crew on foot 80 m')
    expect(eta()).toBe('')
  })
})

describe('syncVehicleMarkers: drone recovery teams', () => {
  it('adds the pickup and a separate viewport-aligned chip carrying only data-recovery-chip', () => {
    const entries = new Map<string, VehicleEntry>()
    const chips = new Map<string, unknown>()
    syncVehicleMarkers(MAP, [recovery({ id: 'r1' })], entries, chips as never)
    const pickup = markerOf(entries.get('r1')!)
    expect(pickup.el.querySelector('img')!.getAttribute('src')).toContain('recovery-unit-pickup-128.png')
    expect(pickup.el.querySelector('img')!.getAttribute('alt')).toBe('Drone recovery team, enroute')
    const chip = chips.get('r1') as unknown as FakeMarkerT
    expect(chip.opts.rotationAlignment).toBe('viewport')
    expect(chip.opts.pitchAlignment).toBe('viewport')
    expect(chip.opts.offset).toEqual([0, -28])
    expect(chip.el.textContent).toBe('DRONE RECOVERY')
    expect(chip.el.dataset.recoveryChip).toBe('r1')
    expect(chip.el.dataset.vehicleId).toBeUndefined()
    expect(chip.lngLat).toEqual([-122.4, 37.77])
  })

  it('re-offsets the chip on zoom and moves it with the vehicle', () => {
    const entries = new Map<string, VehicleEntry>()
    const chips = new Map<string, unknown>()
    syncVehicleMarkers(MAP, [recovery({ id: 'r1' })], entries, chips as never)
    syncVehicleMarkers(MAP, [recovery({ id: 'r1', lng: -122.3, chipOffset: [0, -50] })], entries, chips as never)
    const chip = chips.get('r1') as unknown as FakeMarkerT
    expect(chip.offset).toEqual({ x: 0, y: -50 })
    expect(chip.lngLat).toEqual([-122.3, 37.77])
    expect(created.markers).toHaveLength(2)   // one pickup, one chip, no duplicates
  })

  it('removes the vehicle and its chip together when the team leaves the plan', () => {
    const entries = new Map<string, VehicleEntry>()
    const chips = new Map<string, unknown>()
    syncVehicleMarkers(MAP, [recovery({ id: 'r1' })], entries, chips as never)
    const pickup = markerOf(entries.get('r1')!)
    const chip = chips.get('r1') as unknown as FakeMarkerT
    syncVehicleMarkers(MAP, [], entries, chips as never)
    expect(entries.size).toBe(0)
    expect(chips.size).toBe(0)
    expect(pickup.removed).toBe(true)
    expect(chip.removed).toBe(true)
  })

  it('fades the chip with the vehicle inside a tunnel', () => {
    const entries = new Map<string, VehicleEntry>()
    const chips = new Map<string, unknown>()
    syncVehicleMarkers(MAP, [recovery({ id: 'r1', hidden: true })], entries, chips as never)
    expect((chips.get('r1') as unknown as FakeMarkerT).el.style.opacity).toBe('0')
    syncVehicleMarkers(MAP, [recovery({ id: 'r1' })], entries, chips as never)
    expect((chips.get('r1') as unknown as FakeMarkerT).el.style.opacity).toBe('')
  })

  it('makes no chip for ground vehicles', () => {
    const entries = new Map<string, VehicleEntry>()
    const chips = new Map<string, unknown>()
    syncVehicleMarkers(MAP, [plan({ id: 'g1' })], entries, chips as never)
    expect(chips.size).toBe(0)
  })
})
