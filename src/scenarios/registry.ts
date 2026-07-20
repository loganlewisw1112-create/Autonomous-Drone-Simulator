import { useSyncExternalStore } from 'react'
import { ALL_SCENARIOS, enhanceScenarioForOperations } from '@/scenarios/catalog'
import type { ScenarioConfig } from '@/types'

// ─── Dynamic scenario registry ──────────────────────────────────────────────────
// Module-level source of truth for the scenario picker. Seeded from the static
// ALL_SCENARIOS catalog at load, then extended at runtime with operator-authored
// custom missions. Every SCENARIO_OPTIONS consumer reads through here instead of the
// frozen catalog array, so a registered custom mission shows up in every shell's picker
// without prop-drilling. Reactive consumers use useScenarioOptions(); non-React callers
// (quickDemo, handleScenarioChange) use getScenarioById()/getScenarioOptions().

export interface ScenarioOption {
  id: string
  label: string
  config: ScenarioConfig
}

function toOption(config: ScenarioConfig): ScenarioOption {
  return { id: config.id, label: config.name, config }
}

const registry = new Map<string, ScenarioOption>()
for (const scenario of ALL_SCENARIOS) {
  registry.set(scenario.id, toOption(scenario))
}

// Cached immutable snapshot for useSyncExternalStore — getSnapshot MUST return a stable
// reference between renders, so we only recompute when the registry actually mutates.
let snapshot: ScenarioOption[] = Array.from(registry.values())
const listeners = new Set<() => void>()

function emitChange() {
  snapshot = Array.from(registry.values())
  listeners.forEach((listener) => listener())
}

/** Register (or replace) a custom mission. The raw config is run through the same
 *  enhanceScenarioForOperations pass as the static catalog so launch sites, recovery
 *  sites, and per-drone waypoints are prepared — authored routes are honored, not overwritten. */
export function registerCustomScenario(scenario: ScenarioConfig): ScenarioOption {
  const enhanced = enhanceScenarioForOperations(scenario)
  const option = toOption(enhanced)
  registry.set(option.id, option)
  emitChange()
  return option
}

/** Remove a previously registered custom mission. No-op if the id is unknown. */
export function unregisterCustomScenario(id: string): void {
  if (registry.delete(id)) emitChange()
}

/** Subscribe to registry mutations. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current option list (stable reference until the next register/unregister). */
export function getScenarioOptions(): ScenarioOption[] {
  return snapshot
}

/** Look up a single option by scenario id. */
export function getScenarioById(id: string): ScenarioOption | undefined {
  return registry.get(id)
}

/** React hook: the live option list, re-rendering when a custom mission is (un)registered. */
export function useScenarioOptions(): ScenarioOption[] {
  return useSyncExternalStore(subscribe, getScenarioOptions, getScenarioOptions)
}
