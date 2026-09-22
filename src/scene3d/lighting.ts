/**
 * Solar-driven lighting: a sun DirectionalLight, a sky-fill HemisphereLight and an image-based
 * environment, all read from one palette (skyPalette.ts) keyed to the sun's elevation.
 *
 * Two rules carry this file:
 *  - The shadow camera is fitted to WHAT THE CAMERA SEES, never to the AOI. An ortho shadow camera
 *    over a whole wildfire flank at 2048² is about one texel per two metres — mud.
 *  - The environment map is regenerated only when the sun has moved noticeably, never per frame.
 *    `pmremPasses` is the instrumented count the gate reads.
 */
import * as THREE from 'three'
import type { FrameContext } from './SceneLayer'
import { skyPalette, type SkyPalette } from './skyPalette'
import { sunDirection, type SunPosition } from './sun'

const SHADOW_MAP_SIZE = 2048
const SHADOW_MIN_RADIUS_M = 40
const SHADOW_MAX_RADIUS_M = 1500
const ENV_REFRESH_ELEVATION_DEG = 1
const ENV_REFRESH_AZIMUTH_DEG = 3
/** Below the horizon the only directional light left is twilight glow, which comes from low in the sky. */
const GLOW_ELEVATION_DEG = 6

export class LightingRig {
  readonly sun = new THREE.DirectionalLight(0xffffff, 1)
  readonly fill = new THREE.HemisphereLight(0xffffff, 0x444444, 1)
  /** How many times the environment map has been (re)built. Must not grow while the sun stands still. */
  pmremPasses = 0
  /** Half-width of the view-fitted shadow box, metres. The receivers are built to match it. */
  shadowRadius = SHADOW_MIN_RADIUS_M
  palette: SkyPalette = skyPalette(45)
  position: SunPosition = { azimuthDeg: 180, elevationDeg: 45 }

  private pmrem: THREE.PMREMGenerator | null = null
  private environment: THREE.WebGLRenderTarget | null = null
  private envAt: SunPosition | null = null
  private readonly skyScene = new THREE.Scene()
  private readonly dome: THREE.Mesh
  private readonly disc: THREE.Mesh
  private readonly toSun = new THREE.Vector3()
  private readonly colour = new THREE.Color()

  constructor(private readonly scene: THREE.Scene) {
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    this.sun.shadow.bias = -0.0002
    this.sun.shadow.normalBias = 0.04
    scene.add(this.sun, this.sun.target, this.fill)

    // A little world for the environment map: gradient dome (+Z up, like the scene) and a sun disc.
    const geometry = new THREE.SphereGeometry(100, 32, 16)
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3), 3))
    this.dome = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false }))
    this.disc = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 8), new THREE.MeshBasicMaterial({ toneMapped: false }))
    this.skyScene.add(this.dome, this.disc)
  }

  update(frame: FrameContext, renderer: THREE.WebGLRenderer, position: SunPosition): void {
    this.position = position
    const palette = (this.palette = skyPalette(position.elevationDeg))

    const lit = position.elevationDeg >= 0
    const [x, y, z] = sunDirection(lit ? position : { azimuthDeg: position.azimuthDeg, elevationDeg: GLOW_ELEVATION_DEG })
    this.toSun.set(x, y, z)

    this.sun.color.set(palette.sun)
    this.sun.intensity = palette.sunIntensity
    this.fill.color.set(palette.zenith).lerp(this.colour.set(palette.horizon), 0.5)
    this.fill.groundColor.set(palette.ground)
    this.fill.intensity = palette.fillIntensity
    // HemisphereLight takes "up" from its position; the scene is +Z up.
    this.fill.position.set(0, 0, 1)

    // Fit the shadow box to the patch of world in view: centred on what the camera looks at, wide
    // enough to cover the view at that distance, clamped so a zoomed-out view degrades gracefully.
    const reach = frame.cameraPosition.distanceTo(frame.focus)
    const radius = THREE.MathUtils.clamp(reach * Math.tan(frame.fovRad / 2) * 1.8, SHADOW_MIN_RADIUS_M, SHADOW_MAX_RADIUS_M)
    this.shadowRadius = radius
    this.sun.target.position.copy(frame.focus)
    this.sun.position.copy(frame.focus).addScaledVector(this.toSun, radius + 300)
    this.sun.target.updateMatrixWorld()
    const box = this.sun.shadow.camera
    box.left = box.bottom = -radius
    box.right = box.top = radius
    box.near = 1
    box.far = 2 * radius + 600
    // Bias in world units has to grow with the shadow texel, or a wide box acnes and a tight one peter-pans.
    this.sun.shadow.normalBias = Math.max(0.04, ((2 * radius) / this.sun.shadow.mapSize.x) * 1.5)
    box.updateProjectionMatrix()

    const moved = !this.envAt
      || Math.abs(this.envAt.elevationDeg - position.elevationDeg) > ENV_REFRESH_ELEVATION_DEG
      || Math.abs(((this.envAt.azimuthDeg - position.azimuthDeg + 540) % 360) - 180) > ENV_REFRESH_AZIMUTH_DEG
    if (moved) this.rebuildEnvironment(renderer, palette, lit)
    this.scene.environmentIntensity = palette.environmentIntensity
  }

  private rebuildEnvironment(renderer: THREE.WebGLRenderer, palette: SkyPalette, lit: boolean): void {
    const positions = this.dome.geometry.getAttribute('position')
    const colours = this.dome.geometry.getAttribute('color') as THREE.BufferAttribute
    const zenith = new THREE.Color(palette.zenith)
    const horizon = new THREE.Color(palette.horizon)
    const ground = new THREE.Color(palette.ground)
    for (let i = 0; i < positions.count; i++) {
      const up = positions.getZ(i) / 100 // -1 nadir … +1 zenith
      const c = up >= 0 ? this.colour.copy(horizon).lerp(zenith, Math.pow(up, 0.55)) : this.colour.copy(horizon).lerp(ground, Math.min(1, -up * 6))
      colours.setXYZ(i, c.r, c.g, c.b)
    }
    colours.needsUpdate = true
    this.disc.position.copy(this.toSun).multiplyScalar(90)
    ;(this.disc.material as THREE.MeshBasicMaterial).color.set(palette.sun).multiplyScalar(lit ? 12 * palette.sunIntensity : palette.sunIntensity)

    this.pmrem ??= new THREE.PMREMGenerator(renderer)
    const next = this.pmrem.fromScene(this.skyScene, 0, 1, 400)
    this.environment?.dispose()
    this.environment = next
    this.scene.environment = next.texture
    this.envAt = { ...this.position }
    this.pmremPasses++
  }

  /** Shadow map edge in texels. three only honours a new size once the old map is thrown away. */
  setShadowMapSize(size: number): void {
    if (this.sun.shadow.mapSize.x === size) return
    this.sun.shadow.mapSize.set(size, size)
    this.sun.shadow.map?.dispose()
    this.sun.shadow.map = null
  }

  dispose(): void {
    this.scene.remove(this.sun, this.sun.target, this.fill)
    this.scene.environment = null
    this.environment?.dispose()
    this.pmrem?.dispose()
    this.sun.shadow.map?.dispose()
    this.dome.geometry.dispose()
    this.disc.geometry.dispose()
  }
}
