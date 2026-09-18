/**
 * Atmosphere: the sky, visibility fog, wildfire smoke and sun glare.
 *
 *  - SKY is mandatory, not polish: above ~80° pitch a style with no sky shows raw canvas. The scene
 *    owns `map.setSky()` while it is enabled and gives the style's own sky back afterwards.
 *  - FOG is keyed to the sim's visibility (weatherState.visibilityMi — seeded, deterministic). It is
 *    applied twice so the two renderers agree: MapLibre's horizon/ground fog terms for the map, and a
 *    matching three.js FogExp2 for everything the scene draws.
 *  - SMOKE rises from the scenario's hot heat sources: instanced camera-facing billboards whose every
 *    parameter comes from a PRNG seeded with the SCENARIO SEED and whose motion is a function of SIM
 *    time. No Math.random, no wall clock — a replay smokes exactly as the original run did.
 *  - GLARE is one screen-space sprite at the sun's projected position. There is no post-processing
 *    pass anywhere in this directory, by design (the gate greps for one).
 */
import * as THREE from 'three'
import type * as maplibregl from 'maplibre-gl'
import type { FrameContext } from './SceneLayer'
import type { SkyPalette } from './skyPalette'

const MAX_PARTICLES = 640
const PARTICLE_LIFETIME_SEC = 42
const FIRE_MIN_TEMP_C = 300

export interface FireSource {
  lng: number
  lat: number
  radiusM: number
  tempC: number
}

export interface AtmosphereFrame {
  visibilityKm: number
  windKts: number
  simTimeSec: number
  /** Scenario seed — the only source of randomness. */
  seed: number
  fires: FireSource[]
}

interface Deps {
  toScene(lng: number, lat: number, elevationM: number, target: THREE.Vector3): THREE.Vector3
  groundAt(lng: number, lat: number): number
}

/** mulberry32 — small, fast, and the same everywhere. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Particle {
  fire: number
  phase: number
  f1: number
  f2: number
  p1: number
  p2: number
  size: number
}

function softDisc(): THREE.Texture {
  const size = 64
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.min(1, Math.hypot(x - (size - 1) / 2, y - (size - 1) / 2) / (size / 2))
      const v = (1 - r * r) ** 2
      data.set([255, 255, 255, Math.round(v * 255)], (y * size + x) * 4)
    }
  }
  const texture = new THREE.DataTexture(data, size, size)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return texture
}

export class Atmosphere {
  readonly root = new THREE.Group()
  /** `skyWrites` counts map.setSky() calls: each one dirties the style, so it must stay rare. */
  readonly stats = { smokeParticles: 0, glareVisible: false, visibilityKm: 0, fogDensity: 0, skyWrites: 0 }
  /** 0–1. The quality ladder turns this down before anything else. */
  smokeAmount = 1
  glareEnabled = true
  /** Off = the scene draws no sky, fog, smoke or glare and the map keeps its own sky. */
  enabled = true

  private readonly smoke: THREE.InstancedMesh
  private readonly alpha: THREE.InstancedBufferAttribute
  private readonly glare: THREE.Mesh
  private readonly fog = new THREE.FogExp2(0xffffff, 0)
  private particles: Particle[] = []
  private builtFor = ''
  private drift = { east: 1, north: 0 }
  private skyBefore: maplibregl.SkySpecification | undefined
  private skyOwned = false
  private skyKey = ''
  private readonly p = new THREE.Vector3()
  private readonly base = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly matrix = new THREE.Matrix4()
  private readonly colour = new THREE.Color()
  private readonly cool = new THREE.Color('#8d8d8f')
  private readonly hot = new THREE.Color('#2e2722')
  private readonly clip = new THREE.Vector4()
  private readonly grey = new THREE.Color()
  private daylight = 1

  constructor(private readonly map: maplibregl.Map, private readonly scene: THREE.Scene, private readonly deps: Deps) {
    this.root.name = 'atmosphere'
    const material = new THREE.MeshBasicMaterial({ map: softDisc(), transparent: true, depthWrite: false, toneMapped: false })
    // Per-particle fade: three's instancing carries colour but not alpha.
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;')
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vAlpha;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vAlpha;')
    }
    this.smoke = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, MAX_PARTICLES)
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PARTICLES), 1)
    this.alpha.setUsage(THREE.DynamicDrawUsage)
    this.smoke.geometry.setAttribute('aAlpha', this.alpha)
    this.smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.smoke.setColorAt(0, this.colour.set('#ffffff'))
    this.smoke.frustumCulled = false
    this.smoke.renderOrder = 8
    this.smoke.count = 0
    this.smoke.visible = false

    // Glare lives in clip space: the vertex shader ignores the camera entirely.
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { uCentre: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2() }, uColour: { value: new THREE.Color() }, uStrength: { value: 0 } },
      vertexShader: 'uniform vec2 uCentre; uniform vec2 uSize; varying vec2 vUv; void main() { vUv = position.xy; gl_Position = vec4(uCentre + position.xy * uSize, 0.99995, 1.0); }',
      // At the far plane and depth-tested: a ridge in front of the sun hides its glare, the sky does not.
      fragmentShader: 'uniform vec3 uColour; uniform float uStrength; varying vec2 vUv; void main() { float r = length(vUv); float core = smoothstep(0.16, 0.0, r); float halo = pow(max(0.0, 1.0 - r), 3.0); gl_FragColor = vec4(uColour * (core * 1.6 + halo * 0.55) * uStrength, 1.0); }',
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
    }))
    this.glare.frustumCulled = false
    this.glare.renderOrder = 20
    this.glare.visible = false
    this.root.add(this.smoke, this.glare)
  }

  update(frame: FrameContext, mvp: THREE.Matrix4, palette: SkyPalette, toSun: THREE.Vector3, sunElevationDeg: number, atmosphere: AtmosphereFrame | null): void {
    this.root.visible = this.enabled
    if (!this.enabled) {
      this.release()
      this.stats.smokeParticles = 0
      this.stats.glareVisible = false
      return
    }
    // Smoke and haze are lit by the sky, they do not glow: at night they go nearly black with it.
    this.daylight = 0.06 + 0.94 * (1 - palette.darkness)
    const visibilityKm = atmosphere?.visibilityKm ?? 40
    this.applySky(palette, visibilityKm, (atmosphere?.fires.length ?? 0) > 0 && visibilityKm < 8)
    this.updateSmoke(frame, atmosphere)
    this.updateGlare(frame, mvp, palette, toSun, sunElevationDeg)
  }

  private applySky(palette: SkyPalette, visibilityKm: number, smoky: boolean): void {
    if (!this.skyOwned) {
      this.skyBefore = this.map.getSky()
      this.skyOwned = true
    }
    const v = THREE.MathUtils.clamp(visibilityKm, 0.5, 40)
    this.grey.set(smoky ? '#9a8f80' : '#c9d2da').multiplyScalar(this.daylight)
    const haze = this.colour.set(palette.horizon).lerp(this.grey, THREE.MathUtils.clamp(1 - v / 25, 0, 0.75))
    const fogColour = `#${haze.getHexString()}`
    // 95 % extinction at the stated visibility: exp(-(density·d)²) = 0.05  →  density = 1.73 / V.
    const density = 1.73 / (v * 1000)
    this.fog.color.copy(haze)
    this.fog.density = density
    this.scene.fog = this.fog
    this.stats.visibilityKm = v
    this.stats.fogDensity = density

    const key = `${palette.zenith}${palette.horizon}${fogColour}${v.toFixed(1)}`
    this.stats.skyWrites += key === this.skyKey ? 0 : 1
    if (key === this.skyKey) return
    this.skyKey = key
    this.map.setSky({
      'sky-color': palette.zenith, 'horizon-color': palette.horizon, 'fog-color': fogColour,
      'sky-horizon-blend': 0.55,
      // Low visibility drags the fog from the horizon toward the viewer and thickens it at the horizon.
      'fog-ground-blend': THREE.MathUtils.clamp(0.12 + 0.036 * v, 0.12, 0.92),
      'horizon-fog-blend': THREE.MathUtils.clamp(1.05 - 0.028 * v, 0.45, 1),
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0.6, 20, 0.35],
    })
  }

  private seedParticles(atmosphere: AtmosphereFrame, fires: FireSource[]): void {
    const random = prng(atmosphere.seed)
    // The fleet model has wind SPEED but no direction; the plume's heading is part of the scenario's seed.
    const heading = random() * Math.PI * 2
    this.drift = { east: Math.sin(heading), north: Math.cos(heading) }
    this.particles = []
    fires.forEach((fire, index) => {
      const count = Math.min(140, Math.max(36, Math.round(fire.radiusM * 3)))
      for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
        this.particles.push({ fire: index, phase: random(), f1: 0.05 + random() * 0.09, f2: 0.03 + random() * 0.06, p1: random() * 6.283, p2: random() * 6.283, size: 0.75 + random() * 0.6 })
      }
    })
  }

  private updateSmoke(frame: FrameContext, atmosphere: AtmosphereFrame | null): void {
    const fires = (atmosphere?.fires ?? []).filter((f) => f.tempC >= FIRE_MIN_TEMP_C)
    if (!atmosphere || fires.length === 0 || this.smokeAmount <= 0) {
      this.smoke.visible = false
      this.smoke.count = 0
      this.stats.smokeParticles = 0
      return
    }
    const key = `${atmosphere.seed}|${fires.map((f) => `${f.lng},${f.lat},${f.radiusM}`).join(';')}`
    if (key !== this.builtFor) {
      this.builtFor = key
      this.seedParticles(atmosphere, fires)
    }
    const t = atmosphere.simTimeSec
    const windMs = atmosphere.windKts * 0.5144
    this.forward.crossVectors(frame.cameraRight, frame.cameraUp)
    const live = Math.floor(this.particles.length * this.smokeAmount)
    for (let i = 0; i < live; i++) {
      const particle = this.particles[i]
      const fire = fires[particle.fire]
      const age = (t / PARTICLE_LIFETIME_SEC + particle.phase) % 1
      const rise = Math.pow(age, 0.8) * (80 + fire.radiusM * 6)
      const spread = fire.radiusM * (0.35 + 2.4 * age)
      // Two incommensurate sines per axis stand in for curl noise: divergence-free enough to read as
      // billowing, and a pure function of (seed, sim time).
      const wobbleE = Math.sin(particle.f1 * t + particle.p1) * 0.6 + Math.sin(particle.f2 * t * 0.37 + particle.p2) * 0.4
      const wobbleN = Math.cos(particle.f2 * t + particle.p2) * 0.6 + Math.cos(particle.f1 * t * 0.41 + particle.p1) * 0.4
      const downwind = age * PARTICLE_LIFETIME_SEC * windMs * 0.55
      const east = wobbleE * spread + this.drift.east * downwind
      const north = wobbleN * spread + this.drift.north * downwind
      this.deps.toScene(fire.lng, fire.lat, 0, this.base)
      this.p.set(this.base.x + east, this.base.y + north, this.deps.groundAt(fire.lng, fire.lat) + 4 + rise)
      const size = fire.radiusM * (0.9 + 3.4 * age) * particle.size
      this.matrix.makeBasis(frame.cameraRight, frame.cameraUp, this.forward).scale(this.scale.set(size, size, 1)).setPosition(this.p)
      this.smoke.setMatrixAt(i, this.matrix)
      this.smoke.setColorAt(i, this.colour.copy(this.hot).lerp(this.cool, Math.min(1, age * 1.6)).multiplyScalar(this.daylight))
      this.alpha.setX(i, THREE.MathUtils.smoothstep(age, 0, 0.07) * Math.pow(1 - age, 1.3) * 0.55)
    }
    this.smoke.count = live
    this.smoke.visible = live > 0
    this.smoke.instanceMatrix.needsUpdate = true
    this.alpha.needsUpdate = true
    if (this.smoke.instanceColor) this.smoke.instanceColor.needsUpdate = true
    this.stats.smokeParticles = live
  }

  private updateGlare(frame: FrameContext, mvp: THREE.Matrix4, palette: SkyPalette, toSun: THREE.Vector3, sunElevationDeg: number): void {
    this.p.copy(frame.cameraPosition).addScaledVector(toSun, 10_000)
    const c = this.clip.set(this.p.x, this.p.y, this.p.z, 1).applyMatrix4(mvp)
    const strength = this.glareEnabled ? THREE.MathUtils.clamp(sunElevationDeg / 6, 0, 1) * (1 - palette.darkness) : 0
    const onScreen = c.w > 0 && Math.abs(c.x / c.w) < 1.4 && Math.abs(c.y / c.w) < 1.4
    this.glare.visible = this.stats.glareVisible = onScreen && strength > 0.02
    if (!this.glare.visible) return
    const uniforms = (this.glare.material as THREE.ShaderMaterial).uniforms
    ;(uniforms.uCentre.value as THREE.Vector2).set(c.x / c.w, c.y / c.w)
    const canvas = this.map.getCanvas()
    ;(uniforms.uSize.value as THREE.Vector2).set(0.34 * (canvas.height / canvas.width), 0.34)
    ;(uniforms.uColour.value as THREE.Color).set(palette.sun)
    uniforms.uStrength.value = strength
  }

  /** Give the map back exactly the sky (or lack of one) its style came with. */
  release(): void {
    this.scene.fog = null
    if (!this.skyOwned) return
    this.map.setSky(this.skyBefore as maplibregl.SkySpecification)
    this.skyOwned = false
    this.skyKey = ''
  }

  dispose(): void {
    this.release()
    this.smoke.geometry.dispose()
    ;(this.smoke.material as THREE.MeshBasicMaterial).map?.dispose()
    ;(this.smoke.material as THREE.Material).dispose()
    this.glare.geometry.dispose()
    ;(this.glare.material as THREE.Material).dispose()
  }
}
