import { registerDebugCommands } from '@/debug/registry'
import { coreCommands } from '@/debug/commands/core'
import { faultsCommands } from '@/debug/commands/faults'
import { simCommands } from '@/debug/commands/sim'
import { verifyCommands } from '@/debug/commands/verify'

let registered = false

/**
 * Registers every shared pack once. Called lazily when the console first opens. The classroom
 * relay pack is registered separately by ClassroomEntry (src/classroom/debugCommands.ts), so it
 * exists only in the classroom edition.
 */
export function registerAllDebugCommands(): void {
  if (registered) return
  registered = true
  registerDebugCommands([
    ...coreCommands,
    ...simCommands,
    ...faultsCommands,
    ...verifyCommands,
  ])
}
