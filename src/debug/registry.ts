import { markRunDebugTainted } from '@/debug/taint'
import type { DebugCommand, DebugCommandContext } from '@/debug/types'

const commands = new Map<string, DebugCommand>()
const aliases = new Map<string, string>()

export function registerDebugCommands(pack: DebugCommand[]): void {
  for (const command of pack) {
    const key = command.name.toLowerCase()
    const existing = commands.get(key)
    // Same name in the same group is a re-registration (Vite HMR re-runs a pack's module); a
    // clash across groups is a real naming collision.
    if (existing && existing.group !== command.group) throw new Error(`Debug command already registered: ${command.name}`)
    commands.set(key, command)
    for (const alias of command.aliases ?? []) aliases.set(alias.toLowerCase(), key)
  }
}

export function getDebugCommand(name: string): DebugCommand | undefined {
  const key = name.toLowerCase()
  return commands.get(key) ?? commands.get(aliases.get(key) ?? '')
}

export function listDebugCommands(): DebugCommand[] {
  return [...commands.values()].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
}

/** Shell-style split: whitespace separates, single or double quotes group. */
export function splitDebugArgs(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

/** Parse and run one line. Unknown commands and thrown errors print as `err`. */
export async function runDebugLine(
  line: string,
  io: Pick<DebugCommandContext, 'print' | 'json'>,
): Promise<void> {
  const [name, ...args] = splitDebugArgs(line.trim())
  if (!name) return
  const command = getDebugCommand(name)
  if (!command) {
    io.print(`Unknown command: ${name}. Type "help" for the list.`, 'err')
    return
  }
  if (command.mutatesSim) markRunDebugTainted(`${command.name}: ${line.trim()}`)
  try {
    await command.run({ args, raw: line, ...io })
  } catch (error) {
    io.print(error instanceof Error ? error.message : String(error), 'err')
  }
}

/** Test-only: forget every registered command. */
export function resetDebugRegistryForTests(): void {
  commands.clear()
  aliases.clear()
}
