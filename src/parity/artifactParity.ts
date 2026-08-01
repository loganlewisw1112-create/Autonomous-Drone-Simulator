import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { ALL_SCENARIOS } from '@/scenarios/catalog'
import {
  buildingFixtureFor,
  buildingIndexFor,
  scenariosWithBuildings,
} from '@/scenarios/buildingFixtures'
import {
  occlusionServiceFor,
  prepareScenarioTerrain,
  resolveTerrainFixtureId,
  scenariosWithTerrain,
  terrainPackageIds,
} from '@/scenarios/terrainFixtures'
import { createDroneState, stepDrone } from '@/sim/drone/DroneEntity'
import { PLATFORM_CATALOG, platformForDrone } from '@/sim/drone/platformCatalog'
import { buildMissionOutcomeSummary } from '@/sim/demo/missionOutcome'
import { detectConflicts, applyConflictFlags } from '@/sim/safety/DeconflictEngine'
import {
  applyCommsModel,
  applyGeofenceFlags,
  applySurfaceClearanceSafety,
} from '@/sim/safety/SafetyManager'
import { checkThermalDetections } from '@/sim/sensors/ThermalSim'
import { getDefaultWeatherState } from '@/sim/weather/weatherEngine'
import { bearingDeg, haversineDistanceM, offsetLatLng } from '@/utils/geometry'
import { getGenesisHash, hashEvent, verifyChain } from '@/utils/chainOfCustody'
import type {
  DroneState,
  EventType,
  FullMissionFrame,
  LatLng,
  MissionEvent,
  MissionMetrics,
  ScenarioConfig,
  ThermalContactState,
} from '@/types'

const HARNESS_VERSION = 1
const FIXED_DT = 0.05
const TICK_COUNT = 120
const EVENT_EPOCH_MS = Date.UTC(2026, 0, 1)

type MissionKind = 'terrain' | 'building' | 'thermal'

interface MissionCase {
  kind: MissionKind
  scenarioId: string
}

const MISSION_CASES: readonly MissionCase[] = [
  { kind: 'terrain', scenarioId: 'train_mountain_sar' },
  { kind: 'building', scenarioId: 'hist_surfside_cts_2021' },
  { kind: 'thermal', scenarioId: 'demo_wildfire' },
]

export interface ArtifactMissionDigest {
  kind: MissionKind
  scenarioId: string
  terrainFixtureId: string
  digest: string
  replayHash: string
  eventChainHash: string
  eventCount: number
  replayFrameCount: number
  detectionCount: number
  safetyDecisionCount: number
  score: {
    searchCoveragePct: number
    fleetHealthScore: number
    detectedContacts: number
    evidenceEvents: number
  }
}

export interface TargetParityManifest {
  schemaVersion: 1
  harnessVersion: number
  target: 'windows' | 'mobile' | 'classroom'
  build: {
    version: string
    gitSha: string
  }
  fixtures: {
    terrainPackageIds: string[]
    terrainScenarioIds: string[]
    buildingScenarioIds: string[]
  }
  missions: ArtifactMissionDigest[]
  aggregateDigest: string
}

interface BuildTargetParityManifestInput {
  target: TargetParityManifest['target']
  version: string
  gitSha: string
}

interface MissionEvidence {
  kind: MissionKind
  scenarioId: string
  terrainFixtureId: string
  terrain: {
    minElevationM: number
    maxElevationM: number
    samplesM: number[]
    lineOfSight: Array<{ clear: boolean; blockedBy: string | null; clearanceM: number | null }>
  }
  buildings: {
    fixtureCount: number
    sampledTopMslM: number | null
    sampledHeightM: number | null
  }
  finalDrones: Array<{
    id: string
    position: LatLng
    altitudeFt: number
    batteryPct: number
    signalDbm: number
    missionState: string
    conflictFlag: boolean
    geofenceBreachFlag: boolean
  }>
  safetyDecisions: Array<Record<string, unknown>>
  detections: Array<{
    sourceId: string
    confidence: number
    tick: number
    position: LatLng
  }>
  score: ArtifactMissionDigest['score']
  metrics: MissionMetrics
  eventTypes: EventType[]
  eventChainHash: string
  eventChainVerified: boolean
  replayHash: string
}

/**
 * Execute three representative missions from the bundled artifact itself.
 *
 * The Vite release plugin calls this function only after Rollup has written the target's JS.
 * It therefore proves that the executable artifact contains and can run the same DEM,
 * structures, physics, safety, thermal, scoring, event-chain and replay code for all targets.
 */
export async function buildTargetParityManifest(
  input: BuildTargetParityManifestInput,
): Promise<TargetParityManifest> {
  const fixtures = {
    terrainPackageIds: terrainPackageIds().sort(),
    terrainScenarioIds: scenariosWithTerrain().sort(),
    buildingScenarioIds: scenariosWithBuildings().sort(),
  }
  const missions: ArtifactMissionDigest[] = []

  for (const missionCase of MISSION_CASES) {
    const evidence = await runRepresentativeMission(missionCase)
    missions.push({
      kind: evidence.kind,
      scenarioId: evidence.scenarioId,
      terrainFixtureId: evidence.terrainFixtureId,
      digest: digest(evidence),
      replayHash: evidence.replayHash,
      eventChainHash: evidence.eventChainHash,
      eventCount: evidence.eventTypes.length,
      replayFrameCount: TICK_COUNT / 20,
      detectionCount: evidence.detections.length,
      safetyDecisionCount: evidence.safetyDecisions.length,
      score: evidence.score,
    })
  }

  const aggregateDigest = digest({
    harnessVersion: HARNESS_VERSION,
    fixtures,
    missions,
  })

  return {
    schemaVersion: 1,
    harnessVersion: HARNESS_VERSION,
    target: input.target,
    build: { version: input.version, gitSha: input.gitSha },
    fixtures,
    missions,
    aggregateDigest,
  }
}

async function runRepresentativeMission(missionCase: MissionCase): Promise<MissionEvidence> {
  const scenario = scenarioById(missionCase.scenarioId)
  const terrainFixtureId = resolveTerrainFixtureId(scenario)
  if (!terrainFixtureId) throw new Error(`${scenario.id} does not declare a terrain fixture`)

  const preparation = await prepareScenarioTerrain(scenario)
  if (!preparation.ok) throw new Error(preparation.reason)
  const occlusion = occlusionServiceFor(terrainFixtureId)
  if (!occlusion) throw new Error(`${scenario.id} terrain did not produce an occlusion service`)

  const weather = getDefaultWeatherState(scenario.seed)
  const heatSource = scenario.heatSources[0]
  const buildingPoint = missionCase.kind === 'building'
    ? firstBuildingInteriorPoint(scenario.id)
    : null
  const origin = buildingPoint ?? heatSource?.position ?? scenario.startPosition
  let drones = initialDrones(missionCase.kind, origin)
  const contacts: ThermalContactState[] = []
  const events: MissionEvent[] = []
  const frames: FullMissionFrame[] = []
  const safetyDecisions: Array<Record<string, unknown>> = []
  const recordedSafetyKeys = new Set<string>()
  const recordedDetectionIds = new Set<string>()
  let previousHash = getGenesisHash()
  let previousPositions = new Map(drones.map((drone) => [drone.id, drone.position]))
  const metrics: MissionMetrics = {
    totalFlightDistanceM: 0,
    waypointsReached: 0,
    conflictsDetected: 0,
    thermalContacts: 0,
    geofenceBreaches: 0,
    rtbTriggers: 0,
    recoveryDispatches: 0,
    groundUnitDispatch: 0,
  }

  const emit = (
    eventType: EventType,
    tick: number,
    droneId: string,
    payload: Record<string, unknown>,
  ) => {
    const partial: Omit<MissionEvent, 'hash'> = {
      tick,
      timestamp: EVENT_EPOCH_MS + tick * FIXED_DT * 1_000,
      droneId,
      operatorId: 'artifact-parity',
      role: 'pic',
      eventType,
      payload,
      prevHash: previousHash,
    }
    const event: MissionEvent = { ...partial, hash: hashEvent(previousHash, partial) }
    events.push(event)
    previousHash = event.hash
  }

  emit('mission_start', 0, 'system', {
    scenarioId: scenario.id,
    seed: scenario.seed,
    terrainFixtureId,
  })

  for (let tick = 0; tick < TICK_COUNT; tick += 1) {
    const stepped = drones.map((drone, index) => {
      const target = heatSource?.position
        ?? scenario.perDroneWaypoints?.[drone.id]?.[0]?.position
        ?? offsetLatLng(origin, 35 + index * 145, 100)
      return stepDrone(
        drone,
        {
          targetHeadingDeg: bearingDeg(drone.position, target),
          targetAltitudeFt: missionCase.kind === 'building' ? 10 + index * 4 : 80 + index * 8,
          throttle: missionCase.kind === 'building' ? 0 : 0.18,
        },
        FIXED_DT,
        missionCase.kind === 'thermal'
          ? PLATFORM_CATALOG.skydio_x10
          : platformForDrone(scenario, drone.id),
        {
          tempC: (weather.tempF - 32) * 5 / 9,
          windMs: weather.windKts * 0.514444,
          gustMs: 0,
          drainMultiplier: weather.batteryDrainMultiplier,
        },
      )
    })

    const geofenced = applyGeofenceFlags(stepped, scenario.geofences)
    const withComms = applyCommsModel(geofenced, tick * FIXED_DT, scenario, weather, occlusion)
    const conflicts = detectConflicts(withComms, occlusion)
    const conflictFlagged = applyConflictFlags(withComms, conflicts)
    const surface = applySurfaceClearanceSafety(conflictFlagged, occlusion)
    drones = surface.drones

    for (const drone of drones) {
      const prior = previousPositions.get(drone.id)
      if (prior) metrics.totalFlightDistanceM += haversineDistanceM(prior, drone.position)
    }
    previousPositions = new Map(drones.map((drone) => [drone.id, drone.position]))

    for (const conflict of conflicts) {
      const key = `conflict:${conflict.idA}:${conflict.idB}`
      if (recordedSafetyKeys.has(key)) continue
      recordedSafetyKeys.add(key)
      metrics.conflictsDetected += 1
      const decision = {
        kind: 'separation',
        idA: conflict.idA,
        idB: conflict.idB,
        horizontalM: conflict.horizDistM,
        verticalFt: conflict.vertDistFt,
      }
      safetyDecisions.push(decision)
      emit('conflict_detected', tick, conflict.idA, decision)
    }

    for (const hazard of surface.hazards) {
      const key = `surface:${hazard.droneId}:${hazard.kind}`
      if (recordedSafetyKeys.has(key)) continue
      recordedSafetyKeys.add(key)
      const decision = {
        kind: 'surface_clearance',
        droneId: hazard.droneId,
        hazardKind: hazard.kind,
        clearanceFt: hazard.clearanceFt,
        minimumClearanceFt: hazard.minimumClearanceFt,
      }
      safetyDecisions.push(decision)
      emit('emergency_land', tick, hazard.droneId, decision)
    }

    const breached = drones.filter((drone) => drone.geofenceBreachFlag)
    for (const drone of breached) {
      const key = `geofence:${drone.id}:${drone.geofenceBreach?.id ?? 'unknown'}`
      if (recordedSafetyKeys.has(key)) continue
      recordedSafetyKeys.add(key)
      metrics.geofenceBreaches += 1
      const decision = {
        kind: 'geofence',
        droneId: drone.id,
        geofenceId: drone.geofenceBreach?.id ?? 'unknown',
      }
      safetyDecisions.push(decision)
      emit('geofence_breach', tick, drone.id, decision)
    }

    if (tick % 20 === 0 && scenario.heatSources.length > 0) {
      for (const drone of drones) {
        const detections = checkThermalDetections(
          drone,
          scenario.heatSources,
          tick,
          scenario.seed,
          {
            platform: missionCase.kind === 'thermal'
              ? PLATFORM_CATALOG.skydio_x10
              : platformForDrone(scenario, drone.id),
            weather,
            occlusion,
          },
        )
        for (const detection of detections) {
          if (recordedDetectionIds.has(detection.sourceId)) continue
          recordedDetectionIds.add(detection.sourceId)
          contacts.push({
            ...detection,
            selected: false,
            weatherAdjustedConfidence: detection.confidence * weather.sensorConfidenceFactor,
          })
          metrics.thermalContacts += 1
          emit('thermal_detection', tick, drone.id, {
            sourceId: detection.sourceId,
            confidence: detection.confidence,
            position: detection.position,
          })
        }
      }
    }

    if (tick % 20 === 0) {
      frames.push({
        tick,
        elapsedSec: tick * FIXED_DT,
        drones: drones.map((drone) => ({
          ...drone,
          position: { ...drone.position },
        })),
        thermalContacts: contacts.map((contact) => ({
          ...contact,
          position: { ...contact.position },
        })),
        groundUnits: [],
        recoveryTeams: [],
        weatherState: { ...weather },
        activeEventIds: events.slice(-4).map((event) => event.hash),
      })
    }
  }

  emit('mission_complete', TICK_COUNT, 'system', {
    elapsedSec: TICK_COUNT * FIXED_DT,
    replayFrames: frames.length,
  })

  const outcome = buildMissionOutcomeSummary({
    scenario,
    drones,
    metrics,
    thermalContacts: contacts,
    eventsCount: events.length,
    elapsedSec: TICK_COUNT * FIXED_DT,
  })
  const buildingIndex = buildingIndexFor(scenario.id)
  const buildingHit = buildingPoint ? buildingIndex?.surfaceAt(buildingPoint.lat, buildingPoint.lng) : null
  const samplePoints = [
    scenario.startPosition,
    heatSource?.position ?? scenario.startPosition,
    drones[0].position,
  ]
  const lineOfSight = samplePoints.slice(1).map((point) => {
    const fromGround = occlusion.groundElevation(scenario.startPosition.lat, scenario.startPosition.lng)
    const toGround = occlusion.groundElevation(point.lat, point.lng)
    const los = occlusion.hasLineOfSight(
      { ...scenario.startPosition, altMslM: fromGround + 40 },
      { ...point, altMslM: toGround + 2 },
    )
    return {
      clear: los.clear,
      blockedBy: los.blockedBy,
      clearanceM: Number.isFinite(los.clearanceM) ? los.clearanceM : null,
    }
  })
  const replayHash = digest(frames)

  return {
    kind: missionCase.kind,
    scenarioId: scenario.id,
    terrainFixtureId,
    terrain: {
      minElevationM: occlusion.raster.minElevationM,
      maxElevationM: occlusion.raster.maxElevationM,
      samplesM: samplePoints.map((point) => occlusion.groundElevation(point.lat, point.lng)),
      lineOfSight,
    },
    buildings: {
      fixtureCount: buildingFixtureFor(scenario.id)?.features.length ?? 0,
      sampledTopMslM: buildingHit?.topMslM ?? null,
      sampledHeightM: buildingHit?.h ?? null,
    },
    finalDrones: drones.map((drone) => ({
      id: drone.id,
      position: drone.position,
      altitudeFt: drone.altitudeFt,
      batteryPct: drone.batteryPct,
      signalDbm: drone.signalDbm,
      missionState: drone.missionState,
      conflictFlag: drone.conflictFlag,
      geofenceBreachFlag: drone.geofenceBreachFlag,
    })),
    safetyDecisions,
    detections: contacts.map((contact) => ({
      sourceId: contact.sourceId,
      confidence: contact.confidence,
      tick: contact.tick,
      position: contact.position,
    })),
    score: {
      searchCoveragePct: outcome.searchCoveragePct,
      fleetHealthScore: outcome.fleetHealthScore,
      detectedContacts: outcome.detectedContacts,
      evidenceEvents: outcome.evidenceEvents,
    },
    metrics,
    eventTypes: events.map((event) => event.eventType),
    eventChainHash: events.at(-1)?.hash ?? getGenesisHash(),
    eventChainVerified: verifyChain(events),
    replayHash,
  }
}

function scenarioById(id: string): ScenarioConfig {
  const scenario = ALL_SCENARIOS.find((candidate) => candidate.id === id)
  if (!scenario) throw new Error(`Parity mission scenario "${id}" is missing`)
  return scenario
}

function initialDrones(kind: MissionKind, origin: LatLng): DroneState[] {
  const lowAltitude = kind === 'building'
  return [
    {
      ...createDroneState('uav-01', 'UAV-01', '#00d4ff', origin, lowAltitude ? 10 : 80),
      missionState: 'navigate',
    },
    {
      ...createDroneState(
        'uav-02',
        'UAV-02',
        '#44ff88',
        offsetLatLng(origin, 90, 6),
        lowAltitude ? 14 : 84,
      ),
      missionState: 'navigate',
    },
  ]
}

function firstBuildingInteriorPoint(scenarioId: string): LatLng {
  const fixture = buildingFixtureFor(scenarioId)
  const index = buildingIndexFor(scenarioId)
  if (!fixture || !index) throw new Error(`${scenarioId} does not contain a building fixture`)

  for (const feature of fixture.features) {
    const polygon = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates
      : feature.geometry.coordinates[0]
    const ring = polygon[0]
    const points = ring.slice(0, -1).map((position) => ({
      lat: Number(position[1]),
      lng: Number(position[0]),
    }))
    const centroid = {
      lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
      lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
    }
    const candidates = [
      centroid,
      ...points.map((point) => ({
        lat: centroid.lat + (point.lat - centroid.lat) * 0.25,
        lng: centroid.lng + (point.lng - centroid.lng) * 0.25,
      })),
    ]
    const hit = candidates.find((point) => index.surfaceAt(point.lat, point.lng) !== null)
    if (hit) return hit
  }
  throw new Error(`${scenarioId} building fixture has no queryable interior point`)
}

function digest(value: unknown): string {
  return bytesToHex(sha256(canonicalJson(value)))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : Math.round(value * 1e8) / 1e8
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    )
  }
  return value
}

// A default export keeps the artifact entrypoint stable even when Rollup minifies internal
// named exports. The release plugin imports this generated module after the bundle is written.
export default buildTargetParityManifest
