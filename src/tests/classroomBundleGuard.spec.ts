import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

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
})
