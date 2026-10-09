// Types for roads.mjs so specs can import the authoring pipeline under `tsc -b` without allowJs.
export interface RoadNetworkLike {
  origin: [number, number]
  nodes: Array<{ lat: number; lng: number }>
  edges: Array<{
    from: number
    to: number
    cls: number
    speedMps: number
    oneway: number
    flags: number
    pts: Array<{ lat: number; lng: number }>
  }>
  entries: number[]
}

export declare const OVERTURE_ROADS_DATA_RELEASE: string
export declare const OVERTURE_ROADS_SCHEMA_VERSION: string
export declare const OVERTURE_ROADS_CLIENT_VERSION: string
export declare const OVERTURE_ROADS_ATTRIBUTION: string
export declare const MAX_SCENARIO_BYTES: number
export declare const WATER_TOLERANCE_M: number
export declare const ROAD_CLASSES: string[]
export declare const MINOR_ROAD_CLASSES: ReadonlySet<string>
export declare const CLASS_SPEED_CAP_MPS: Record<string, number>
export declare const FLAG_BRIDGE: number
export declare const FLAG_HIDDEN: number

export declare function directionalAccess(restrictions: unknown): { forward: boolean; backward: boolean; ambiguous: number }
export declare function normalizeRoadFlags(roadFlags: unknown): Array<{ values: string[]; between: [number, number] | null }>
export declare function wholeSegmentLimitMps(speedLimits: unknown): number | null
export declare function edgeSpeedCode(roadClass: string, limitMps: number | null): number
export declare function encodeRoadNetwork(net: RoadNetworkLike): Record<string, unknown>
export declare function serializeRoadNetwork(encoded: Record<string, unknown>): string
export declare function decodeRoadNetwork(encoded: unknown): RoadNetworkLike
export declare function stronglyConnectedComponents(
  nodeCount: number,
  edges: ReadonlyArray<{ from: number; to: number; oneway: number }>,
): { comp: Int32Array; count: number }
export declare function buildNetwork(input: Record<string, unknown>): {
  json: string
  decoded: RoadNetworkLike
  gzipBytes: number
  keptEdgeCount: number
  validation: Record<string, unknown>
  stats: { select: { input: number; kept: number; ambiguousAccessRules: number; droppedByAccess: number } } & Record<string, unknown>
}
export declare function ladderConfig(
  step: number,
  ctx: Record<string, unknown>,
): { applied: string[]; simplifyM: number; dropClasses: string[]; minorNearOnly?: boolean }
export declare function selectSegments(
  features: unknown[],
  ctx: Record<string, unknown>,
): { segments: Array<{ id: string; roadClass: string }>; stats: { input: number; kept: number; ambiguousAccessRules: number; droppedByAccess: number } }
export declare function mergeManifest(
  previous: any,
  options: { scenarioId: string; source?: any; roadsRemoved?: boolean },
): any
