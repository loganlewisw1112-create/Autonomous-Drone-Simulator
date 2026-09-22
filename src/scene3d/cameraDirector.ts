/**
 * Cinematic camera rig. Every mode solves a camera POSITION and a LOOK-AT point in
 * (lng, lat, rendered elevation), then hands both to `map.calculateCameraOptionsFromTo()` and
 * `jumpTo()`s the result. MapLibre does the zoom/pitch/bearing maths, and it is the only path that
 * yields pitch > 90 (camera below the subject, looking up).
 *
 * Rules learned the hard way (see README › Things measured):
 *  - `jumpTo`, never `easeTo`: per-frame eased moves queue up and fight each other.
 *  - FOV is set BEFORE calculateCameraOptionsFromTo (zoom is derived from it), and presets keep the
 *    derived zoom under maxZoom, or the camera silently lands further away than asked.
 *  - Ground height comes from the scene's ground model, never queryTerrainElevation (0 off-screen).
 *  - The sky that makes a look-up shot possible is owned by atmosphere.ts, not by this rig.
 *  - Nothing here touches React: drag-to-orbit mutates plain fields read by the next frame.
 *
 * Time: `update(dt)` is the whole rig. Live, a rAF loop feeds it wall-clock dt; under the harness the
 * loop is stopped and the gate feeds it fixed steps, so camera paths replay exactly.
 */
import { LngLat } from 'maplibre-gl'
import type * as maplibregl from 'maplibre-gl'

export type CameraMode = 'TACTICAL' | 'ORBIT' | 'CHASE' | 'FPV' | 'GROUND'
export const CAMERA_MODES: CameraMode[] = ['TACTICAL', 'ORBIT', 'CHASE', 'FPV', 'GROUND']

export interface CameraSubject {
  lng: number
  lat: number
  /** Rendered elevation, metres MSL. */
  elevationM: number
  headingDeg: number
}

interface Point {
  lng: number
  lat: number
  alt: number
}

const DEG = Math.PI / 180
const M_PER_DEG_LAT = 111_320
const DEFAULT_FOV_DEG = 36.87

/** Tunables. Smoothing = seconds to close ~63 % of the gap. Starting values — see PROGRESS.md. */
export const CAMERA_PRESETS = {
  ORBIT: { radiusM: 220, elevDeg: 28, spinDegPerSec: 6, fovDeg: 42, smoothSec: 0.8 },
  CHASE: { behindM: 90, aboveM: 35, leadM: 60, fovDeg: 55, smoothSec: 0.35 },
  FPV: { aheadM: 260, downDeg: 18, fovDeg: 78, smoothSec: 0.18 },
  // Eye height 1.7 m. The aim sits below the subject so the aircraft rides in the upper part of the
  // frame with ground and horizon under it — and the standoff is short enough that this still looks UP.
  GROUND: { eyeM: 1.7, standoffM: 45, aimBelowFovFraction: 0.17, fovDeg: 62, smoothSec: 1.1 },
} as const

const offset = (p: { lng: number; lat: number }, eastM: number, northM: number) => ({
  lng: p.lng + eastM / (M_PER_DEG_LAT * Math.cos(p.lat * DEG)),
  lat: p.lat + northM / M_PER_DEG_LAT,
})
const damp = (current: number, target: number, smoothSec: number, dt: number) =>
  smoothSec <= 0 ? target : current + (target - current) * (1 - Math.exp(-dt / smoothSec))

export interface CameraDirectorOptions {
  getSubject(): CameraSubject | null
  groundAt(lng: number, lat: number): number
}

export interface CameraDirector {
  readonly mode: CameraMode
  /** `manual`: do not start the rAF loop — the caller drives update() itself (gates, replays). */
  setMode(mode: CameraMode, manual?: boolean): void
  setGroundAnchor(anchor: { lng: number; lat: number } | null): void
  /** The next map click places the GROUND observer. */
  placeGroundAnchorOnNextClick(): void
  /** Advance the rig by `dt` seconds and move the map camera. */
  update(dtSec: number): void
  /** Live mode: drive update() from requestAnimationFrame. */
  start(): void
  stop(): void
  state(): { mode: CameraMode; camera: Point | null; lookAt: Point | null; orbitBearingDeg: number; fovDeg: number }
  destroy(): void
}

export function createCameraDirector(map: maplibregl.Map, options: CameraDirectorOptions): CameraDirector {
  let mode: CameraMode = 'TACTICAL'
  let raf: number | null = null
  let last = 0
  let cam: Point | null = null
  let look: Point | null = null
  let fov = DEFAULT_FOV_DEG
  let orbitBearing = 0
  let orbitElev: number = CAMERA_PRESETS.ORBIT.elevDeg
  let orbitRadius: number = CAMERA_PRESETS.ORBIT.radiusM
  let groundAnchor: { lng: number; lat: number } | null = null
  let dragging = false
  let lastPointer: { x: number; y: number } | null = null
  let handlersBefore: Array<[{ enable(): void; disable(): void; isEnabled(): boolean }, boolean]> = []

  const container = map.getCanvasContainer()

  function solve(subject: CameraSubject, dt: number): { cam: Point; look: Point; fovDeg: number; smoothSec: number } | null {
    const at = { lng: subject.lng, lat: subject.lat }
    const h = subject.headingDeg * DEG
    if (mode === 'ORBIT') {
      const p = CAMERA_PRESETS.ORBIT
      if (!dragging) orbitBearing = (orbitBearing + p.spinDegPerSec * dt) % 360
      const flat = orbitRadius * Math.cos(orbitElev * DEG)
      return {
        cam: { ...offset(at, flat * Math.sin(orbitBearing * DEG), flat * Math.cos(orbitBearing * DEG)), alt: subject.elevationM + orbitRadius * Math.sin(orbitElev * DEG) },
        look: { ...at, alt: subject.elevationM }, fovDeg: p.fovDeg, smoothSec: dragging ? 0.08 : p.smoothSec,
      }
    }
    if (mode === 'CHASE') {
      const p = CAMERA_PRESETS.CHASE
      // Lead the look-at point so turns read as turns rather than as drift.
      return {
        cam: { ...offset(at, -p.behindM * Math.sin(h), -p.behindM * Math.cos(h)), alt: subject.elevationM + p.aboveM },
        look: { ...offset(at, p.leadM * Math.sin(h), p.leadM * Math.cos(h)), alt: subject.elevationM }, fovDeg: p.fovDeg, smoothSec: p.smoothSec,
      }
    }
    if (mode === 'FPV') {
      const p = CAMERA_PRESETS.FPV
      return {
        cam: { ...at, alt: subject.elevationM },
        look: { ...offset(at, p.aheadM * Math.sin(h), p.aheadM * Math.cos(h)), alt: subject.elevationM - p.aheadM * Math.tan(p.downDeg * DEG) },
        fovDeg: p.fovDeg, smoothSec: p.smoothSec,
      }
    }
    if (mode === 'GROUND') {
      const p = CAMERA_PRESETS.GROUND
      groundAnchor ??= offset(at, -p.standoffM * Math.sin(h), -p.standoffM * Math.cos(h))
      const eye = { ...groundAnchor, alt: options.groundAt(groundAnchor.lng, groundAnchor.lat) + p.eyeM }
      const flat = Math.max(1, Math.hypot((at.lng - eye.lng) * M_PER_DEG_LAT * Math.cos(eye.lat * DEG), (at.lat - eye.lat) * M_PER_DEG_LAT))
      const aimAngle = Math.atan2(subject.elevationM - eye.alt, flat) - p.aimBelowFovFraction * p.fovDeg * DEG
      return { cam: eye, look: { ...at, alt: eye.alt + flat * Math.tan(aimAngle) }, fovDeg: p.fovDeg, smoothSec: p.smoothSec }
    }
    return null
  }

  function unlock(): void {
    map.setMaxPitch(180)
    map.setCenterClampedToGround(false)
    handlersBefore = [map.dragPan, map.dragRotate, map.keyboard, map.doubleClickZoom, map.touchZoomRotate, map.scrollZoom].map((h) => [h, h.isEnabled()])
    for (const [h] of handlersBefore) h.disable()
  }

  function relock(): void {
    for (const [h, was] of handlersBefore) if (was) h.enable()
    handlersBefore = []
    map.setCenterClampedToGround(true)
    map.setVerticalFieldOfView(DEFAULT_FOV_DEG)
    map.setRoll(0)
    if (map.getPitch() > 60) map.jumpTo({ pitch: 60 })
    map.setMaxPitch(60)
  }

  // Drag-to-orbit: pointer events mutate plain fields; the next update() reads them. No React, no store.
  const onPointerDown = (e: PointerEvent) => { if (mode === 'ORBIT') { dragging = true; lastPointer = { x: e.clientX, y: e.clientY } } }
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !lastPointer) return
    orbitBearing = (orbitBearing - (e.clientX - lastPointer.x) * 0.3 + 360) % 360
    orbitElev = Math.min(80, Math.max(4, orbitElev + (e.clientY - lastPointer.y) * 0.2))
    lastPointer = { x: e.clientX, y: e.clientY }
  }
  const onPointerUp = () => { dragging = false; lastPointer = null }
  const onWheel = (e: WheelEvent) => { if (mode === 'ORBIT') orbitRadius = Math.min(1200, Math.max(40, orbitRadius * (e.deltaY > 0 ? 1.1 : 0.9))) }
  container.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  container.addEventListener('wheel', onWheel, { passive: true })

  const director: CameraDirector = {
    get mode() { return mode },
    setMode(next, manual = false) {
      if (next === mode) return
      const was = mode
      mode = next
      cam = look = null // snap to the new rig, then smooth from there
      groundAnchor = null
      if (next === 'TACTICAL') { director.stop(); relock() } else if (was === 'TACTICAL') unlock()
      if (next !== 'TACTICAL') { if (manual) director.stop(); else director.start() }
    },
    setGroundAnchor(anchor) { groundAnchor = anchor; cam = look = null },
    placeGroundAnchorOnNextClick() { void map.once('click').then((e) => director.setGroundAnchor({ lng: e.lngLat.lng, lat: e.lngLat.lat })) },
    update(dtSec) {
      if (mode === 'TACTICAL') return
      const subject = options.getSubject()
      const want = subject && solve(subject, dtSec)
      if (!want) return
      if (!cam || !look) {
        cam = { ...want.cam }
        look = { ...want.look }
      } else {
        for (const k of ['lng', 'lat', 'alt'] as const) {
          cam[k] = damp(cam[k], want.cam[k], want.smoothSec, dtSec)
          look[k] = damp(look[k], want.look[k], want.smoothSec, dtSec)
        }
      }
      fov = damp(fov, want.fovDeg, 0.6, dtSec)
      map.setVerticalFieldOfView(fov) // before calculateCameraOptionsFromTo: zoom is derived from FOV
      map.jumpTo(map.calculateCameraOptionsFromTo(new LngLat(cam.lng, cam.lat), cam.alt, new LngLat(look.lng, look.lat), look.alt))
    },
    start() {
      if (raf !== null) return
      last = performance.now()
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame)
        director.update(Math.min((now - last) / 1000, 0.1)) // clamp after a tab stall
        last = now
      }
      raf = requestAnimationFrame(frame)
    },
    stop() {
      if (raf !== null) cancelAnimationFrame(raf)
      raf = null
    },
    state: () => ({ mode, camera: cam && { ...cam }, lookAt: look && { ...look }, orbitBearingDeg: orbitBearing, fovDeg: fov }),
    destroy() {
      director.stop()
      if (mode !== 'TACTICAL') { mode = 'TACTICAL'; relock() }
      container.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      container.removeEventListener('wheel', onWheel)
    },
  }
  return director
}
