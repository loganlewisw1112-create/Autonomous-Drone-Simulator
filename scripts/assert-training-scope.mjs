import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const roots = ['src', 'server', 'desktop']
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts'])
const forbidden = [
  'live_operational_assurance',
  'connected_digital_twin',
  'real_mission_planning',
  'verified_operational_authorization',
  'operational_windows_pilot',
  'operationalLaunchAllowed',
]

// Pitch review k1: labels that made a training screen read like a standards result or a
// regulatory compliance check. Banned from shipped UI code (src/tests may name them in order to
// assert they are absent). The rubric's provenance stays, worded as a simulated training score.
const forbiddenUiLabels = [
  { token: 'NIST Standard Test Method', extensions: sourceExtensions },
  { token: 'referenced by NFPA 2400', extensions: sourceExtensions },
  { token: 'FAA Part 107', extensions: new Set(['.tsx']) },
  { token: 'FAA PART 107', extensions: new Set(['.tsx']) },
]
const testsDir = join(root, 'src', 'tests')

function filesUnder(path) {
  return readdirSync(path).flatMap((name) => {
    const candidate = join(path, name)
    return statSync(candidate).isDirectory() ? filesUnder(candidate) : [candidate]
  })
}

const offenders = []
for (const sourceRoot of roots) {
  for (const file of filesUnder(join(root, sourceRoot))) {
    if (!sourceExtensions.has(extname(file))) continue
    const body = readFileSync(file, 'utf8')
    for (const token of forbidden) {
      if (body.includes(token)) offenders.push(`${relative(root, file)} contains ${token}`)
    }
    if (file.startsWith(testsDir)) continue
    for (const { token, extensions } of forbiddenUiLabels) {
      if (extensions.has(extname(file)) && body.includes(token)) {
        offenders.push(`${relative(root, file)} contains UI label "${token}"`)
      }
    }
  }
}

if (offenders.length > 0) {
  throw new Error(`Training-only scope assertion failed:\n${offenders.join('\n')}`)
}

console.log('Training-only scope assertion passed: no legacy operational modes, enablement fields or compliance-styled UI labels found.')
