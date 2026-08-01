import { validateCustomMission } from './designerValidation'
import type { CustomMissionDefinition } from '@/types'

export const MAX_CUSTOM_MISSION_IMPORT_BYTES = 256 * 1024

export interface CustomMissionExportEnvelope {
  kind: 'drone-sim-custom-mission'
  schemaVersion: 1
  exportedAt: string
  definition: CustomMissionDefinition
}

export type MissionImportResult =
  | { ok: true; definition: CustomMissionDefinition; fingerprint: string }
  | { ok: false; message: string }

export function buildCustomMissionExport(definition: CustomMissionDefinition): CustomMissionExportEnvelope {
  return {
    kind: 'drone-sim-custom-mission',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    definition,
  }
}

export function missionFingerprint(definition: CustomMissionDefinition): string {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = definition
  return JSON.stringify(content)
}

export function parseCustomMissionImport(
  text: string,
  createId: () => string,
  now = Date.now(),
): MissionImportResult {
  const bytes = new TextEncoder().encode(text).byteLength
  if (bytes === 0) return { ok: false, message: 'The selected file is empty. Choose a custom-mission JSON export.' }
  if (bytes > MAX_CUSTOM_MISSION_IMPORT_BYTES) {
    return { ok: false, message: `The file is ${Math.ceil(bytes / 1024)} KB; custom mission imports are limited to 256 KB.` }
  }

  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    return { ok: false, message: 'The file is not valid JSON. Export it again without editing or repair the JSON syntax.' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'The file does not contain a custom mission object.' }
  }

  const record = parsed as Record<string, unknown>
  let candidate: unknown
  if (record.kind === 'drone-sim-custom-mission') {
    if (record.schemaVersion !== 1) {
      return { ok: false, message: `Custom mission schema ${String(record.schemaVersion)} is not supported. Export with simulator v1.1.` }
    }
    candidate = record.definition
  } else {
    // Compatibility with individual mission exports created before the v1.1 envelope.
    candidate = record
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, message: 'The custom mission definition is missing or malformed.' }
  }

  let clone: CustomMissionDefinition
  try { clone = structuredClone(candidate) as CustomMissionDefinition } catch {
    return { ok: false, message: 'The custom mission contains values this browser cannot safely import.' }
  }
  clone.id = createId()
  clone.createdAt = now
  clone.updatedAt = now
  clone.geographicMode ??= 'synthetic_training'
  const validation = validateCustomMission(clone)
  if (!validation.valid) {
    return { ok: false, message: `Import blocked: ${validation.errors.slice(0, 4).join(' ')}` }
  }
  return { ok: true, definition: clone, fingerprint: missionFingerprint(clone) }
}
