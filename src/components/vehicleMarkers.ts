import type { GroundUnitRole } from '@/types'
import { vehicleImageUrls, type VehicleKind, type VehicleVariant } from '@/components/vehicleAvatars'

/**
 * DOM factories for the vehicle avatars. Plain DOM only: no maplibre import, so
 * jsdom specs (and anything that must not drag in the map) can build and
 * inspect these. MapLibre owns the root element's position and transform; this
 * module never sets either on it. Phase 2 hands the elements to
 * `new maplibregl.Marker({ element })`.
 */

export const RECOVERY_CHIP_TEXT = 'DRONE RECOVERY'

const STATUS_LABEL: Readonly<Record<string, string>> = {
  standby: 'Standby',
  dispatched: 'Dispatched',
  enroute: 'Enroute',
  on_scene: 'On scene',
  returning: 'Returning',
  extracted: 'Recovered',
}

export const GROUND_ROLE_LABEL: Readonly<Record<GroundUnitRole, string>> = {
  intervention: 'Intervention',
  medical: 'Medical',
  fire: 'Fire',
  law_enforcement: 'Law enforcement',
  maintenance: 'Maintenance',
  recovery: 'Recovery',
}

const has = (record: object, key: string) => Object.prototype.hasOwnProperty.call(record, key)

export function vehicleStatusLabel(status: string): string {
  return has(STATUS_LABEL, status) ? STATUS_LABEL[status] : status
}

function groundRoleLabel(role: string | undefined): string {
  return role !== undefined && has(GROUND_ROLE_LABEL, role) ? GROUND_ROLE_LABEL[role as GroundUnitRole] : 'Ground'
}

/** `alt` text: role + status, e.g. "Drone recovery team, on scene" or "Fire unit, enroute". */
export function vehicleAltText(kind: VehicleKind, role: string | undefined, status: string): string {
  const subject = kind === 'recovery' ? 'Drone recovery team' : `${groundRoleLabel(role)} unit`
  return `${subject}, ${vehicleStatusLabel(status).toLowerCase()}`
}

/** Popup heading: the old popup's upper-case role, or the recovery team. */
export function vehicleTitle(kind: VehicleKind, role: string | undefined): string {
  return kind === 'recovery' ? 'DRONE RECOVERY TEAM' : groundRoleLabel(role).toUpperCase()
}

// ─── Marker element ─────────────────────────────────────────────────────────────

export interface VehicleMarkerInit {
  id: string
  kind: VehicleKind
  variant: VehicleVariant
  /** Ground unit role; ignored for recovery teams. */
  role?: string
  status: string
  /** Degrees clockwise from north. MapLibre does the rotating (`setRotation`); this is for data-heading. */
  headingDeg: number
  lng: number
  lat: number
  lengthPx: number
  widthPx: number
  /** Hidden inside a tunnel or covered range: opacity 0, no pointer events. */
  hidden?: boolean
}

export type VehicleMarkerPatch = Partial<Omit<VehicleMarkerInit, 'id' | 'kind' | 'variant'>>

const px = (n: number) => `${Math.round(n * 100) / 100}px`

function applySize(el: HTMLElement, lengthPx: number, widthPx: number): void {
  el.style.width = px(widthPx)
  el.style.height = px(lengthPx)
  el.style.setProperty('--vehicle-pulse-px', px(Math.max(lengthPx, widthPx) * 1.5))
  const img = el.querySelector('img')
  if (img) {
    img.style.width = px(widthPx)
    img.style.height = px(lengthPx)
  }
}

function applyHidden(el: HTMLElement, hidden: boolean): void {
  el.dataset.hidden = hidden ? 'true' : 'false'
  el.style.opacity = hidden ? '0' : ''
  el.style.pointerEvents = hidden ? 'none' : ''
}

/**
 * The wrapper MapLibre transforms. Its children are the front-up `<img>` and a
 * `.vehicle-pulse` ring (shown only on scene), so the animated ring never
 * touches the element MapLibre positions.
 */
export function createVehicleMarkerElement(init: VehicleMarkerInit): HTMLDivElement {
  const el = document.createElement('div')
  el.className = `vehicle-marker vehicle-marker--${init.kind}`
  el.dataset.vehicleId = init.id
  el.dataset.vehicleKind = init.kind
  if (init.role !== undefined) el.dataset.vehicleRole = init.role

  const urls = vehicleImageUrls(init.variant)
  const img = document.createElement('img')
  img.className = 'vehicle-marker__img'
  img.setAttribute('decoding', 'async')
  img.setAttribute('src', urls.src)
  img.setAttribute('srcset', urls.srcSet)
  img.setAttribute('draggable', 'false')

  const pulse = document.createElement('div')
  pulse.className = 'vehicle-pulse'
  pulse.setAttribute('aria-hidden', 'true')

  el.append(pulse, img)
  applySize(el, init.lengthPx, init.widthPx)
  applyHidden(el, init.hidden === true)
  updateVehicleMarkerElement(el, {
    status: init.status,
    headingDeg: init.headingDeg,
    lng: init.lng,
    lat: init.lat,
  })
  return el
}

/** Refresh an existing marker element in place. Only the fields present in `patch` change. */
export function updateVehicleMarkerElement(el: HTMLElement, patch: VehicleMarkerPatch): void {
  if (patch.role !== undefined) el.dataset.vehicleRole = patch.role
  if (patch.status !== undefined) {
    el.dataset.status = patch.status
    const pulse = el.querySelector<HTMLElement>('.vehicle-pulse')
    if (pulse) pulse.hidden = patch.status !== 'on_scene'
  }
  if (patch.status !== undefined || patch.role !== undefined) {
    const img = el.querySelector('img')
    if (img) {
      const kind: VehicleKind = el.dataset.vehicleKind === 'recovery' ? 'recovery' : 'ground'
      const next = vehicleAltText(kind, el.dataset.vehicleRole, el.dataset.status ?? '')
      if (img.getAttribute('alt') !== next) img.setAttribute('alt', next)
    }
  }
  if (patch.headingDeg !== undefined) el.dataset.heading = patch.headingDeg.toFixed(1)
  if (patch.lng !== undefined) el.dataset.lng = patch.lng.toFixed(7)
  if (patch.lat !== undefined) el.dataset.lat = patch.lat.toFixed(7)
  if (patch.lengthPx !== undefined || patch.widthPx !== undefined) {
    const img = el.querySelector('img')
    const length = patch.lengthPx ?? parseFloat(img?.style.height ?? '0')
    const width = patch.widthPx ?? parseFloat(img?.style.width ?? '0')
    applySize(el, length, width)
  }
  if (patch.hidden !== undefined) applyHidden(el, patch.hidden)
}

// ─── Recovery chip ──────────────────────────────────────────────────────────────

/**
 * The "DRONE RECOVERY" chip. A separate, non-rotating marker element (give it
 * `rotationAlignment: 'viewport'` and `offset: recoveryChipOffset(lengthPx)`).
 * It deliberately carries no `data-vehicle-id`, so vehicle queries never pick it up.
 */
export function createRecoveryChipElement(init: { id: string; text?: string }): HTMLDivElement {
  const chip = document.createElement('div')
  chip.className = 'vehicle-chip vehicle-chip--recovery'
  chip.dataset.recoveryChip = init.id
  chip.setAttribute('aria-hidden', 'true')
  chip.textContent = init.text ?? RECOVERY_CHIP_TEXT
  return chip
}

// ─── Popup content ──────────────────────────────────────────────────────────────

export interface VehiclePopupModel {
  /** Role heading, e.g. `vehicleTitle(...)`. */
  title: string
  /** Raw status token: standby, dispatched, enroute, on_scene, returning, extracted. */
  status: string
  etaSec?: number
  /** Metres the crew walks from the access point; pass only when it matters (accessGapM > 15). */
  crewOnFootM?: number
  /** Seconds of walk-in left (recovery teams). */
  walkSecLeft?: number
  note?: string
}

export interface VehiclePopupContent {
  node: HTMLDivElement
  /** Rewrite the text nodes in place. Safe to call every store update. */
  update(model: VehiclePopupModel): void
}

const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n)

/** "On scene · crew on foot N m · M s" while the crew walks in, else the plain status word. */
export function popupStatusLine(model: VehiclePopupModel): string {
  const label = vehicleStatusLabel(model.status)
  if (model.status === 'on_scene' && finite(model.crewOnFootM) && model.crewOnFootM > 0) {
    const walk = finite(model.walkSecLeft) ? ` · ${Math.ceil(Math.max(0, model.walkSecLeft))} s` : ''
    return `${label} · crew on foot ${Math.round(model.crewOnFootM)} m${walk}`
  }
  return label
}

function popupEtaLine(model: VehiclePopupModel): string {
  if (model.status === 'on_scene' || !finite(model.etaSec) || model.etaSec <= 0) return ''
  return `ETA ${Math.round(model.etaSec)} s`
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
  el.hidden = text === ''
}

/** Role, status and ETA as DOM text nodes (never `setHTML`), for `popup.setDOMContent(node)`. */
export function createVehiclePopupContent(model: VehiclePopupModel): VehiclePopupContent {
  const node = document.createElement('div')
  node.className = 'vehicle-popup'
  const field = (name: string) => {
    const el = document.createElement('div')
    el.className = `vehicle-popup__${name}`
    el.dataset.popupField = name
    node.append(el)
    return el
  }
  const title = field('title')
  const status = field('status')
  const eta = field('eta')
  const note = field('note')

  const update = (next: VehiclePopupModel) => {
    setText(title, next.title)
    setText(status, popupStatusLine(next))
    setText(eta, popupEtaLine(next))
    setText(note, next.note ?? '')
  }
  update(model)
  return { node, update }
}
