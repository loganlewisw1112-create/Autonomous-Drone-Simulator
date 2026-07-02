import type {
  SavedDroneWaypointRoute,
  SavedMissionWaypointPlan,
  ScenarioVariantConfig,
  Waypoint,
  WaypointSaveSource,
  WaypointSaveStatus,
} from '@/types'

const SCHEMA_VERSION = 1
const STORAGE_PREFIX = 'drone-sim:waypoint-drafts:v1'

interface SaveDroneWaypointRouteInput {
  storage?: Storage
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  droneId: string
  route: Waypoint[]
  source: WaypointSaveSource
  now?: number
}

interface RestoreSavedWaypointRoutesInput {
  storage?: Storage
  scenarioId: string
  scenarioVariant: ScenarioVariantConfig
  baselineRoutes: Record<string, Waypoint[]>
  validateRoute: (droneId: string, route: Waypoint[]) => boolean
}

export interface SaveDroneWaypointRouteResult {
  ok: boolean
  status: WaypointSaveStatus
}

export interface RestoreSavedWaypointRoutesResult {
  routes: Record<string, Waypoint[]>
  statuses: Record<string, WaypointSaveStatus>
}

export function storageKeyForWaypointPlan(
  scenarioId: string,
  scenarioVariant: ScenarioVariantConfig,
): string {
  return `${STORAGE_PREFIX}:${scenarioId}:${scenarioVariantKey(scenarioVariant)}`
}

export function saveDroneWaypointRoute(input: SaveDroneWaypointRouteInput): SaveDroneWaypointRouteResult {
  const updatedAt = input.now ?? Date.now()
  const storage = resolveStorage(input.storage)
  if (!storage) {
    return failedSave(input.source, updatedAt, 'Browser storage unavailable')
  }

  const key = storageKeyForWaypointPlan(input.scenarioId, input.scenarioVariant)
  const existing = readPlan(storage, key)
  const plan: SavedMissionWaypointPlan = existing ?? {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: input.scenarioId,
    scenarioVariant: cloneScenarioVariant(input.scenarioVariant),
    updatedAt,
    routes: {},
  }

  plan.routes[input.droneId] = {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: input.scenarioId,
    scenarioVariant: cloneScenarioVariant(input.scenarioVariant),
    droneId: input.droneId,
    route: cloneRoute(input.route),
    updatedAt,
    source: input.source,
  }
  plan.updatedAt = updatedAt

  try {
    storage.setItem(key, JSON.stringify(plan))
    return {
      ok: true,
      status: { state: 'autosaved', updatedAt, source: input.source },
    }
  } catch {
    return failedSave(input.source, updatedAt, 'Waypoint draft save failed')
  }
}

export function loadSavedDroneWaypointRoute(
  storage: Storage | undefined,
  scenarioId: string,
  scenarioVariant: ScenarioVariantConfig,
  droneId: string,
): SavedDroneWaypointRoute | null {
  const resolved = resolveStorage(storage)
  if (!resolved) return null
  const plan = readPlan(resolved, storageKeyForWaypointPlan(scenarioId, scenarioVariant))
  return plan?.routes[droneId] ?? null
}

export function clearSavedDroneWaypointRoute(
  storage: Storage | undefined,
  scenarioId: string,
  scenarioVariant: ScenarioVariantConfig,
  droneId: string,
): WaypointSaveStatus {
  const updatedAt = Date.now()
  const resolved = resolveStorage(storage)
  if (!resolved) return { state: 'failed', updatedAt, message: 'Browser storage unavailable' }

  const key = storageKeyForWaypointPlan(scenarioId, scenarioVariant)
  const plan = readPlan(resolved, key)
  if (!plan) return { state: 'cleared', updatedAt, message: 'No saved draft' }

  delete plan.routes[droneId]
  plan.updatedAt = updatedAt

  try {
    if (Object.keys(plan.routes).length === 0) {
      resolved.removeItem(key)
    } else {
      resolved.setItem(key, JSON.stringify(plan))
    }
    return { state: 'cleared', updatedAt, message: 'Draft cleared' }
  } catch {
    return { state: 'failed', updatedAt, message: 'Waypoint draft clear failed' }
  }
}

export function clearAllSavedWaypointPlans(storage?: Storage): number {
  const resolved = resolveStorage(storage)
  if (!resolved) return 0
  const keys: string[] = []
  for (let index = 0; index < resolved.length; index++) {
    const key = resolved.key(index)
    if (key?.startsWith(STORAGE_PREFIX)) keys.push(key)
  }
  keys.forEach((key) => resolved.removeItem(key))
  return keys.length
}
export function restoreSavedWaypointRoutes(input: RestoreSavedWaypointRoutesInput): RestoreSavedWaypointRoutesResult {
  const storage = resolveStorage(input.storage)
  const routes = cloneRoutes(input.baselineRoutes)
  const statuses: Record<string, WaypointSaveStatus> = {}
  if (!storage) return { routes, statuses }

  const plan = readPlan(storage, storageKeyForWaypointPlan(input.scenarioId, input.scenarioVariant))
  if (!plan) return { routes, statuses }

  Object.entries(plan.routes).forEach(([droneId, saved]) => {
    if (!routes[droneId]) return
    const route = cloneRoute(saved.route)
    if (input.validateRoute(droneId, route)) {
      routes[droneId] = route
      statuses[droneId] = {
        state: 'restored',
        updatedAt: saved.updatedAt,
        source: saved.source,
      }
      return
    }

    statuses[droneId] = {
      state: 'failed',
      updatedAt: Date.now(),
      source: saved.source,
      message: 'Saved route rejected by current mission safety rules',
    }
  })

  return { routes, statuses }
}

function failedSave(
  source: WaypointSaveSource,
  updatedAt: number,
  message: string,
): SaveDroneWaypointRouteResult {
  return {
    ok: false,
    status: { state: 'failed', updatedAt, source, message },
  }
}

function readPlan(storage: Storage, key: string): SavedMissionWaypointPlan | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return normalizePlan(parsed)
  } catch {
    return null
  }
}

function normalizePlan(value: unknown): SavedMissionWaypointPlan | null {
  if (!isObject(value)) return null
  if (value.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof value.scenarioId !== 'string') return null
  const scenarioVariant = normalizeScenarioVariant(value.scenarioVariant)
  if (!scenarioVariant) return null
  if (!isObject(value.routes)) return null

  const routes: Record<string, SavedDroneWaypointRoute> = {}
  Object.entries(value.routes).forEach(([droneId, routeValue]) => {
    const savedRoute = normalizeSavedRoute(routeValue)
    if (savedRoute && savedRoute.droneId === droneId) routes[droneId] = savedRoute
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: value.scenarioId,
    scenarioVariant,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    routes,
  }
}

function normalizeSavedRoute(value: unknown): SavedDroneWaypointRoute | null {
  if (!isObject(value)) return null
  if (value.schemaVersion !== SCHEMA_VERSION) return null
  if (typeof value.scenarioId !== 'string') return null
  const scenarioVariant = normalizeScenarioVariant(value.scenarioVariant)
  if (!scenarioVariant) return null
  if (typeof value.droneId !== 'string') return null
  if (!isWaypointSaveSource(value.source)) return null
  const route = normalizeRoute(value.route)
  if (!route) return null

  return {
    schemaVersion: SCHEMA_VERSION,
    scenarioId: value.scenarioId,
    scenarioVariant,
    droneId: value.droneId,
    route,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    source: value.source,
  }
}

function normalizeRoute(value: unknown): Waypoint[] | null {
  if (!Array.isArray(value)) return null
  const route = value.map(normalizeWaypoint)
  if (route.some((waypoint) => waypoint == null)) return null
  return route as Waypoint[]
}

function normalizeWaypoint(value: unknown): Waypoint | null {
  if (!isObject(value)) return null
  if (typeof value.id !== 'string' || value.id.length === 0) return null
  if (!isObject(value.position)) return null
  if (typeof value.position.lat !== 'number' || typeof value.position.lng !== 'number') return null
  if (!Number.isFinite(value.position.lat) || !Number.isFinite(value.position.lng)) return null
  if (typeof value.altitudeFt !== 'number' || !Number.isFinite(value.altitudeFt)) return null

  return {
    id: value.id,
    position: { lat: value.position.lat, lng: value.position.lng },
    altitudeFt: value.altitudeFt,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.dwellTimeSec === 'number' ? { dwellTimeSec: value.dwellTimeSec } : {}),
  }
}

function normalizeScenarioVariant(value: unknown): ScenarioVariantConfig | null {
  if (!isObject(value)) return null
  const variant = value as Partial<ScenarioVariantConfig>
  if (typeof variant.seed !== 'number') return null
  if (!['dawn', 'day', 'dusk', 'night'].includes(String(variant.timeOfDay))) return null
  if (!['spring', 'summer', 'fall', 'winter'].includes(String(variant.season))) return null
  if (!isKnob(variant.weatherSeverity, 3)) return null
  if (!isKnob(variant.commsDegradation, 2)) return null
  if (!isKnob(variant.thermalDensity, 2)) return null
  if (!isKnob(variant.batteryPressure, 2)) return null
  if (!isKnob(variant.terrainDifficulty, 2)) return null

  return {
    seed: variant.seed,
    timeOfDay: variant.timeOfDay as ScenarioVariantConfig['timeOfDay'],
    season: variant.season as ScenarioVariantConfig['season'],
    weatherSeverity: variant.weatherSeverity,
    commsDegradation: variant.commsDegradation,
    thermalDensity: variant.thermalDensity,
    batteryPressure: variant.batteryPressure,
    terrainDifficulty: variant.terrainDifficulty,
  }
}

function isKnob(value: unknown, max: number): value is 0 | 1 | 2 | 3 {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
}

function isWaypointSaveSource(value: unknown): value is WaypointSaveSource {
  return value === 'operator_edit'
    || value === 'manual_save'
    || value === 'command_route'
    || value === 'route_suggestion'
}

function cloneRoutes(routes: Record<string, Waypoint[]>): Record<string, Waypoint[]> {
  return Object.fromEntries(Object.entries(routes).map(([droneId, route]) => [droneId, cloneRoute(route)]))
}

function cloneRoute(route: Waypoint[]): Waypoint[] {
  return route.map((waypoint) => ({
    ...waypoint,
    position: { ...waypoint.position },
  }))
}

function cloneScenarioVariant(variant: ScenarioVariantConfig): ScenarioVariantConfig {
  return { ...variant }
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function scenarioVariantKey(variant: ScenarioVariantConfig): string {
  return [
    `seed=${variant.seed}`,
    `timeOfDay=${variant.timeOfDay}`,
    `season=${variant.season}`,
    `weatherSeverity=${variant.weatherSeverity}`,
    `commsDegradation=${variant.commsDegradation}`,
    `thermalDensity=${variant.thermalDensity}`,
    `batteryPressure=${variant.batteryPressure}`,
    `terrainDifficulty=${variant.terrainDifficulty}`,
  ].join('|')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
