/**
 * Windows/mobile parity matrix. Walks the real import graphs of both shells and
 * asserts every console capability — mission control, OPS, telemetry, evidence,
 * replay, exports, accounts, run drill-down, custom missions — is reachable from
 * each. A capability removed from either shell (or added to only one) fails here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(__dirname, '..')

function resolveModule(spec: string, importer: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = resolve(SRC_ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(importer), spec)
  else return null // package import — outside the parity graph
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts'), resolve(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]\s*\)?/g

function collectGraph(entry: string, exclude: (path: string) => boolean): Map<string, string> {
  const graph = new Map<string, string>()
  const queue = [resolve(SRC_ROOT, entry)]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (graph.has(file) || exclude(file)) continue
    const source = readFileSync(file, 'utf8')
    graph.set(file, source)
    for (const match of source.matchAll(IMPORT_RE)) {
      const target = resolveModule(match[1], file)
      if (target && !graph.has(target) && !exclude(target)) queue.push(target)
    }
  }
  return graph
}

const isMobileModule = (path: string) => path.replace(/\\/g, '/').includes('/components/mobile/')

// Desktop graph starts at App.tsx but must not credit desktop with modules it only
// reaches through the lazily imported mobile chunk.
const desktopGraph = collectGraph('App.tsx', isMobileModule)
const mobileGraph = collectGraph('components/mobile/MobileShell.tsx', () => false)

function graphHas(graph: Map<string, string>, moduleSuffix: string): boolean {
  const normalized = moduleSuffix.replace(/\//g, '[/\\\\]')
  const re = new RegExp(`${normalized}\\.(ts|tsx)$`)
  return [...graph.keys()].some((path) => re.test(path.replace(/\\/g, '/')))
}

const CAPABILITY_MATRIX: Record<string, string> = {
  'scenario catalog & custom registry': 'scenarios/registry',
  'mission lifecycle + export handlers': 'hooks/useMissionControls',
  'tactical map': 'components/TacticalMap',
  'fleet status': 'components/FleetPanel',
  'per-drone OPS commands': 'components/OperatorCommandPanel',
  'telemetry & evidence chain': 'components/TelemetryPanel',
  'dispatch feed': 'components/MissionStatusFeed',
  'preflight checklist': 'components/PreflightChecklist',
  'launch bay planning': 'components/LaunchBayPlanner',
  'mission replay': 'components/ReplayPanel',
  'account sign-in': 'components/account/SignInModal',
  'account analytics/settings/history': 'components/account/AccountPanels',
  'saved-run drill-down': 'components/rundetail/RunDetailView',
  'custom mission designer': 'components/designer/CustomMissionHub',
}

// Every mission/export action exposed by the shared hook, asserted by name in each
// shell's own UI (the hook file itself doesn't count as UI reachability).
const ACTION_HANDLERS = [
  'handleStart',
  'handleAbort',
  'handlePause',
  'handleResume',
  'handleEndMission',
  'handleScenarioChange',
  'handleVariantChange',
  'handleRandomizeSeed',
  'handleDemoReset',
  'handleExportLog',
  'handleExportKML',
  'handleExportGeoJSON',
  'handleExportAfterAction',
] as const

function uiFilesUsing(graph: Map<string, string>, handler: string): string[] {
  return [...graph.entries()]
    .filter(([path, source]) => !path.endsWith('useMissionControls.ts') && source.includes(handler))
    .map(([path]) => path)
}

describe('Windows/mobile parity matrix', () => {
  it('resolves both shell import graphs', () => {
    expect(desktopGraph.size).toBeGreaterThan(10)
    expect(mobileGraph.size).toBeGreaterThan(10)
  })

  for (const [capability, moduleSuffix] of Object.entries(CAPABILITY_MATRIX)) {
    it(`exposes ${capability} on the Windows shell`, () => {
      expect(graphHas(desktopGraph, moduleSuffix)).toBe(true)
    })
    it(`exposes ${capability} on the mobile shell`, () => {
      expect(graphHas(mobileGraph, moduleSuffix)).toBe(true)
    })
  }

  for (const handler of ACTION_HANDLERS) {
    it(`wires ${handler} into UI on both shells`, () => {
      expect(uiFilesUsing(desktopGraph, handler).length).toBeGreaterThan(0)
      expect(uiFilesUsing(mobileGraph, handler).length).toBeGreaterThan(0)
    })
  }
})
