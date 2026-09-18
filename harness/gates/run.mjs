// npm run gate -- <p0|0|1|…|6> [--no-build]
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from '../config.mjs'

const [name, ...rest] = process.argv.slice(2)
const file = resolve(ROOT, 'harness', 'gates', `gate-${name}.mjs`)
if (!name || !existsSync(file)) {
  console.error(`GATE ${name ?? '?'} FAIL assertions=0/0 failed=[no-such-gate] p75_layer_ms=n/a artifacts=n/a`)
  process.exit(1)
}
process.exit(spawnSync(process.execPath, [file, ...rest], { cwd: ROOT, stdio: 'inherit' }).status ?? 1)
