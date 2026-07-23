import { haversineDistanceM } from '@/utils/geometry'
import type { OcclusionService } from '@/sim/terrain/OcclusionService'
import type { ClutterClass, LatLng, WeatherLocationTag } from '@/types'

// RF link budget (REALISM_ROADMAP WP-8 / §18.4).
//
//   PL(d) = PL(d₀) + 10·n·log₁₀(d/d₀) + X_σ + NLOS_penalty        d₀ = 1 m
//
// MODEL SELECTION, AND WHY NOT HATA. §18.4 is explicit and most write-ups get this wrong:
// Okumura-Hata is valid 150 MHz–1.5 GHz and COST-231 Hata reaches ~2 GHz. Drone C2 and video run
// at 2.4/5.8 GHz — outside both. Reaching for Hata because it is the famous name would be using
// a model past its stated validity. This is log-distance with a per-scenario clutter exponent,
// which §18.4 selects, plus true LOS/NLOS from the WP-4 occlusion service.
//
// WHAT THIS REPLACES. Comms was a timer: authored blackout windows plus a weather factor, ramping
// signal up and down regardless of where the aircraft was. The operator could not influence it,
// so it taught endurance rather than decision-making. Now range, altitude, terrain, structures
// and relay placement determine the link — which is the entire reason relay drones exist in the
// CBP and multi-agency scenarios.
//
// DETERMINISM (§3). Pure. Shadow fading is band-limited noise evaluated from the link geometry
// itself, not a per-tick RNG draw and not accumulated state — the same discipline WP-7 uses, and
// for the same reason: persistent RNG state would desynchronise under sub-stepping and break
// byte-identical replay.

export type { ClutterClass }

export interface ClutterProfile {
  /** Path-loss exponent n. */
  exponent: number
  /** Log-normal shadow fading standard deviation, dB. */
  shadowSigmaDb: number
  /** Representative height of the clutter itself (rooftops, canopy), m. */
  clutterHeightM: number
  label: string
}

/**
 * §18.4's table. Mid-range of each published band, so no class sits on a boundary.
 *
 * `clutterHeightM` is not in §18.4 — it is what `effectiveExponent` needs to know when a link
 * has climbed out of the clutter, and the values are ordinary rooftop heights for each class.
 */
export const CLUTTER_PROFILES: Record<ClutterClass, ClutterProfile> = {
  open:        { exponent: 2.1, shadowSigmaDb: 3, clutterHeightM: 2, label: 'Open / water' },
  rural:       { exponent: 2.65, shadowSigmaDb: 4, clutterHeightM: 6, label: 'Rural / desert' },
  suburban:    { exponent: 3.0, shadowSigmaDb: 5, clutterHeightM: 9, label: 'Suburban' },
  urban:       { exponent: 3.4, shadowSigmaDb: 7, clutterHeightM: 20, label: 'Urban' },
  dense_urban: { exponent: 4.0, shadowSigmaDb: 8, clutterHeightM: 40, label: 'Dense urban' },
}

/**
 * Default clutter class from the scenario's existing weather location tag, so every scenario
 * gets a defensible class without re-authoring all 21. `ScenarioConfig.rfClutter` overrides it
 * where the tag is too coarse — Times Square and the Financial District are dense urban, not the
 * plain 'urban' their weather tag implies.
 *
 * The wildfire AO maps to suburban, which is what §18.4's table names for the East Bay.
 */
export function clutterForLocationTag(tag: WeatherLocationTag | undefined): ClutterClass {
  switch (tag) {
    case 'coastal': return 'open'
    case 'mountain': return 'rural'
    case 'desert_border': return 'rural'
    case 'urban': return 'urban'
    case 'wildfire': return 'suburban'
    default: return 'suburban'
  }
}

export interface RadioConfig {
  frequencyMhz: number
  txPowerDbm: number
  txGainDbi: number
  rxGainDbi: number
  /** Below this received power the link cannot be closed at all. */
  sensitivityDbm: number
}

/**
 * A generic 2.4 GHz public-safety C2 link: ~500 mW at the aircraft, an omni on the airframe, a
 * directional patch on the ground controller, and a receiver good to −101 dBm at C2 data rates.
 *
 * These are ordinary for the class of radio these airframes carry and are not taken from any one
 * manufacturer's datasheet — nothing downstream depends on a specific vendor. The combination
 * closes a free-space link at roughly 10 km, which is the right order for the multi-kilometre
 * ranges these platforms advertise; a budget that could not do that would make the CBP and
 * multi-agency corridor scenarios unflyable for a reason that is an artefact rather than physics.
 */
export const DEFAULT_RADIO: RadioConfig = {
  frequencyMhz: 2400,
  txPowerDbm: 27,
  txGainDbi: 2,
  rxGainDbi: 8,
  sensitivityDbm: -101,
}

/** Margin at or above which the link is clean; below it, packet loss climbs. */
export const CLEAN_MARGIN_DB = 20

/** Reported signal is clamped to the scale the rest of the app already reasons about. */
export const MIN_REPORTED_DBM = -100
export const MAX_REPORTED_DBM = -30

/** Shadow fading decorrelation distance (m) — how far the aircraft moves before fading rerolls. */
const SHADOW_DECORRELATION_M = 40

const NOISE_HARMONICS = 4

/**
 * Free-space path loss in dB. `20·log₁₀(d) + 20·log₁₀(f) − 147.55` with d in metres and f in Hz.
 * At d₀ = 1 m and 2.4 GHz this is ~40 dB, which is the `PL(d₀)` term §18.4 anchors on.
 */
export function freeSpacePathLossDb(distanceM: number, frequencyMhz: number): number {
  const d = Math.max(1, distanceM)
  const fHz = frequencyMhz * 1e6
  return 20 * Math.log10(d) + 20 * Math.log10(fHz) - 147.55
}

/**
 * Effective path-loss exponent for a link that has climbed out of the clutter.
 *
 * MODELLING CHOICE, STATED. §18.4's exponents describe ground-level links, where the ray runs
 * *through* rooftops and vegetation. An air-to-ground link does not: once the aircraft is well
 * above the clutter the first Fresnel zone is clear and the channel approaches free space. So the
 * exponent is blended from the clutter value toward free-space 2.0 by how far the aircraft has
 * climbed above the clutter top.
 *
 * WHY HEIGHT AND NOT ELEVATION ANGLE. Elevation angle is the intuitive proxy and it is wrong at
 * range. A drone at 60 m and 2 km out subtends only 1.7°, which reads as a grazing ground-level
 * path — but the first Fresnel radius there is ~8 m against ~50 m of rooftop clearance, so the
 * link is in fact essentially free space. Scoring it by angle would impose ~30 dB of clutter loss
 * that physically is not there, and would make most of the catalog unflyable. Height above the
 * clutter top is the quantity that actually governs whether the ray is obstructed.
 *
 * Full clutter loss at the rooftops, free space by roughly three clutter-heights above them.
 * Terrain and individual structures are handled separately and exactly, by the WP-4 NLOS term —
 * this is only the statistical clutter the DEM does not resolve.
 */
export function effectiveExponent(
  clutterExponent: number,
  clutterHeightM: number,
  heightAboveGroundM: number,
): number {
  const excessM = heightAboveGroundM - clutterHeightM
  const scaleM = 3 * clutterHeightM + 10
  const blend = Math.min(1, Math.max(0, excessM / scaleM))
  return clutterExponent + (2.0 - clutterExponent) * blend
}

/**
 * NLOS penalty in dB. §18.4 specifies +15 to 25 dB "scaled by blocker height above the ray",
 * which is exactly `−clearanceM` from the WP-4 occlusion service: `LosResult.clearanceM` is
 * negative precisely when blocked, and its magnitude is the depth of the obstruction. A ray
 * clipped by a metre of ridge earns the floor; one buried 30 m inside a hill earns the ceiling.
 */
export function nlosPenaltyDb(clearanceM: number): number {
  if (clearanceM >= 0) return 0
  const depthM = Math.min(30, -clearanceM)
  return 15 + 10 * (depthM / 30)
}

/**
 * Log-normal shadow fading, X_σ.
 *
 * Evaluated as band-limited noise over DISTANCE rather than time, which is the physically right
 * variable: shadowing is a property of what the link passes through, so it decorrelates as the
 * aircraft moves (~40 m here), not as the clock runs. A hovering drone therefore holds a steady
 * fade instead of shimmering, and a transiting one sees it evolve smoothly. Pure and seeded, so
 * it carries no RNG state.
 */
export function shadowFadingDb(seed: number, linkId: string, distanceM: number, sigmaDb: number): number {
  const base = hashIdentity(`${seed}|${linkId}`)
  let sum = 0
  for (let k = 0; k < NOISE_HARMONICS; k += 1) {
    const h = hashIdentity(`${base}|${k}`)
    const period = SHADOW_DECORRELATION_M / (1 + k * 0.6180339887) * (0.75 + ((h >>> 16) / 65535) * 0.5)
    const phase = ((h & 0xffff) / 65535) * Math.PI * 2
    sum += Math.sin((distanceM / period) * Math.PI * 2 + phase)
  }
  return (sum / NOISE_HARMONICS) * sigmaDb
}

export interface LinkEndpoint {
  position: LatLng
  /** Metres MSL. */
  altMslM: number
}

export interface LinkBudgetInput {
  from: LinkEndpoint
  to: LinkEndpoint
  clutter: ClutterClass
  seed: number
  /** Stable identity for this link, so its shadow fading is its own. */
  linkId: string
  occlusion?: OcclusionService
  radio?: RadioConfig
  /** Authored RF interference active right now (smoke, jamming, congestion), in dB. */
  interferenceDb?: number
}

export interface LinkBudget {
  distanceM: number
  elevationAngleDeg: number
  exponent: number
  pathLossDb: number
  shadowFadingDb: number
  nlosPenaltyDb: number
  interferenceDb: number
  rssiDbm: number
  /** rssi − sensitivity. Negative means the link cannot be closed. */
  marginDb: number
  los: boolean
}

/** One point-to-point link. */
export function computeLinkBudget(input: LinkBudgetInput): LinkBudget {
  const radio = input.radio ?? DEFAULT_RADIO
  const profile = CLUTTER_PROFILES[input.clutter]

  const groundM = haversineDistanceM(input.from.position, input.to.position)
  const riseM = input.to.altMslM - input.from.altMslM
  const distanceM = Math.max(1, Math.hypot(groundM, riseM))
  const elevationAngleDeg = (Math.atan2(Math.abs(riseM), Math.max(1, groundM)) * 180) / Math.PI

  // The higher endpoint is what determines whether the path clears the clutter: the ground
  // station is down in it by definition, so a link is only ever as clear as its aircraft is high.
  const aglOf = (end: LinkEndpoint) =>
    end.altMslM - (input.occlusion?.groundElevation(end.position.lat, end.position.lng) ?? 0)
  const clearingHeightM = Math.max(aglOf(input.from), aglOf(input.to))

  const exponent = effectiveExponent(profile.exponent, profile.clutterHeightM, clearingHeightM)

  // Log-distance about the 1 m free-space anchor.
  const anchorDb = freeSpacePathLossDb(1, radio.frequencyMhz)
  const spreadingDb = 10 * exponent * Math.log10(distanceM)

  const los = input.occlusion
    ? input.occlusion.hasLineOfSight(
        { ...input.from.position, altMslM: input.from.altMslM },
        { ...input.to.position, altMslM: input.to.altMslM },
      )
    : null
  // No occlusion fixture is honest ignorance, not clear air proven — but inventing an
  // obstruction from missing data would be worse. Absent evidence, the path is treated as clear,
  // exactly as WP-6 and WP-7 treat their absent fixtures.
  const nlos = los && !los.clear ? nlosPenaltyDb(los.clearanceM) : 0

  const shadow = shadowFadingDb(input.seed, input.linkId, distanceM, profile.shadowSigmaDb)
  const interference = input.interferenceDb ?? 0

  const pathLossDb = anchorDb + spreadingDb + shadow + nlos + interference
  const rssiDbm = radio.txPowerDbm + radio.txGainDbi + radio.rxGainDbi - pathLossDb

  return {
    distanceM,
    elevationAngleDeg,
    exponent,
    pathLossDb,
    shadowFadingDb: shadow,
    nlosPenaltyDb: nlos,
    interferenceDb: interference,
    rssiDbm,
    marginDb: rssiDbm - radio.sensitivityDbm,
    los: los ? los.clear : true,
  }
}

export interface RelayCandidate {
  id: string
  position: LatLng
  altMslM: number
}

export interface ResolvedLink extends LinkBudget {
  /** Drone id whose aircraft is relaying, or null for a direct link to the ground station. */
  viaRelayId: string | null
  packetLossPct: number
  controlLatencyMs: number
}

/**
 * Best available link to the ground control station: direct, or one hop via another airborne
 * aircraft. A relayed path is only as good as its worst leg, so the hop's margin is the MINIMUM
 * of ground→relay and relay→aircraft, and a hop is taken only when it beats flying direct.
 *
 * One hop, not many: a chain would let the fleet daisy-chain arbitrarily far from the operator,
 * which is not how these aircraft are flown and would quietly remove the range constraint the
 * model exists to impose.
 *
 * This is what makes the accept criterion true — moving a relay drone changes downstream margin,
 * because the relay's own position enters both legs.
 */
export function resolveLink(
  input: LinkBudgetInput,
  relays: readonly RelayCandidate[] = [],
): ResolvedLink {
  const direct = computeLinkBudget(input)
  let best = direct
  let viaRelayId: string | null = null

  for (const relay of relays) {
    const uplink = computeLinkBudget({
      ...input,
      to: { position: relay.position, altMslM: relay.altMslM },
      linkId: `${input.linkId}|relay-up:${relay.id}`,
    })
    const downlink = computeLinkBudget({
      ...input,
      from: { position: relay.position, altMslM: relay.altMslM },
      linkId: `${input.linkId}|relay-down:${relay.id}`,
    })
    const worst = uplink.marginDb <= downlink.marginDb ? uplink : downlink
    if (worst.marginDb > best.marginDb) {
      best = worst
      viaRelayId = relay.id
    }
  }

  return {
    ...best,
    viaRelayId,
    packetLossPct: packetLossFromMargin(best.marginDb),
    controlLatencyMs: controlLatencyFromLoss(packetLossFromMargin(best.marginDb)),
  }
}

/**
 * Packet loss from link margin. Clean above CLEAN_MARGIN_DB, total at or below zero margin, and
 * a smooth quadratic between — losses accelerate as margin collapses rather than degrading
 * linearly, which is the characteristic shape of a real digital link approaching its threshold.
 */
export function packetLossFromMargin(marginDb: number): number {
  if (marginDb >= CLEAN_MARGIN_DB) return 0
  if (marginDb <= 0) return 100
  const shortfall = (CLEAN_MARGIN_DB - marginDb) / CLEAN_MARGIN_DB
  return Math.min(100, Math.max(0, shortfall * shortfall * 100))
}

/** Control latency from packet loss: retransmission inflates round-trip time. */
export function controlLatencyFromLoss(packetLossPct: number): number {
  const base = 45
  const p = Math.min(0.99, Math.max(0, packetLossPct / 100))
  return Math.round(base / (1 - p))
}

/** Reported signal on the app's existing dBm scale. */
export function reportedSignalDbm(rssiDbm: number): number {
  return Math.round(Math.min(MAX_REPORTED_DBM, Math.max(MIN_REPORTED_DBM, rssiDbm)))
}

/** Stable FNV-1a, matching the hashing used by the thermal and GNSS models. */
function hashIdentity(value: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
