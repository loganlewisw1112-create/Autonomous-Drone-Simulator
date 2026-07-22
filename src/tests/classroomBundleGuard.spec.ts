import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

// Mechanical guarantee (not a promise): the only networking in src/ lives under the
// classroom module, which main.tsx reaches solely through a flag-gated dynamic
// import. So a build without VITE_CLASSROOM_ENABLED — the mobile and Windows
// bundles — tree-shakes the WebSocket path out entirely.

const SRC = join(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

const codeFiles = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p) && !p.includes(`${sep}tests${sep}`))

function resolveSourceImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : null
  if (!base) return null

  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

function sourceImports(file: string): string[] {
  const source = readFileSync(file, 'utf8')
  const staticImports = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
  const dynamicImports = [...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((match) => match[1])
  return [...staticImports, ...dynamicImports]
}

function collectGraph(entry: string): Set<string> {
  const graph = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (graph.has(file)) continue
    graph.add(file)
    for (const specifier of sourceImports(file)) {
      const imported = resolveSourceImport(file, specifier)
      if (imported && !graph.has(imported)) queue.push(imported)
    }
  }
  return graph
}

describe('classroom bundle isolation', () => {
  it('confines all WebSocket usage to src/classroom', () => {
    const offenders = codeFiles.filter((p) => /new WebSocket\s*\(|WebSocketServer/.test(readFileSync(p, 'utf8')))
      .filter((p) => !p.includes(`${sep}classroom${sep}`))
    expect(offenders).toEqual([])
  })

  it('reaches the classroom entry only via a dynamic import in main.tsx', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    expect(main).toMatch(/import\(\s*['"]@\/components\/classroom\/ClassroomEntry['"]\s*\)/)
    // No STATIC import of the classroom entry (that would pull it into the base bundle).
    expect(main).not.toMatch(/^import .*classroom\/ClassroomEntry/m)
  })

  it('gates the classroom branch behind the build flag', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
    expect(main).toMatch(/VITE_CLASSROOM_ENABLED/)
  })

  it('keeps both operator shell import graphs outside the classroom edition', () => {
    const entries = [
      join(SRC, 'App.tsx'),
      join(SRC, 'components', 'mobile', 'MobileShell.tsx'),
    ]
    for (const entry of entries) {
      const classroomModules = [...collectGraph(entry)]
        .filter((file) => file.includes(`${sep}classroom${sep}`))
      expect(classroomModules).toEqual([])
    }
  })

  it('keeps classroom vocabulary out of shared types', () => {
    const sharedTypes = readFileSync(join(SRC, 'types', 'index.ts'), 'utf8')
    expect(sharedTypes).not.toMatch(/instructor|rubric|classroom|studentId/i)
  })

  it('keeps assessment code and vocabulary out of the shared after-action path', () => {
    const sharedAfterActionFiles = [
      join(SRC, 'sim', 'demo', 'missionReport.ts'),
      join(SRC, 'hooks', 'useMissionControls.ts'),
    ]
    for (const file of sharedAfterActionFiles) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/classroom\/missionAssessment|assessment|rubric|studentId/i)
    }
  })
})
