// Types for aoBbox.mjs so the AO-derivation helper can be unit-tested from src/tests/ under
// `tsc -b` without turning on allowJs for the whole project. The implementation stays plain
// ESM because the fixture CLI (tools/fixtures/index.mjs) is plain Node — it has no build step.

export declare const DEFAULT_AO_MARGIN_M: number

export interface AoLatLng {
  lat: number
  lng: number
}

/** ArcGIS-style WGS84 envelope, the shape the FAA feature service takes as `geometry`. */
export interface AoEnvelope {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

export declare function aoPoints(scenario: unknown): AoLatLng[]

export declare function aoBbox(scenario: unknown, options?: { marginM?: number }): AoEnvelope
