import { getDebugCommand, listDebugCommands, splitDebugArgs } from '@/debug/registry'

export interface CompletionResult {
  /** The new input value (unchanged when nothing matched). */
  value: string
  /** Every candidate, for printing when the choice is ambiguous. */
  candidates: string[]
}

function commonPrefix(items: string[]): string {
  if (items.length === 0) return ''
  let prefix = items[0]
  for (const item of items) {
    while (!item.toLowerCase().startsWith(prefix.toLowerCase())) prefix = prefix.slice(0, -1)
  }
  return prefix
}

/** Tab completion over command names (first word) and `DebugCommand.complete` (later words). */
export function completeDebugInput(input: string): CompletionResult {
  const trailingSpace = /\s$/.test(input)
  const tokens = splitDebugArgs(input)
  const typing = trailingSpace ? '' : (tokens[tokens.length - 1] ?? '')
  const done = trailingSpace ? tokens : tokens.slice(0, -1)

  let candidates: string[]
  if (done.length === 0) {
    candidates = listDebugCommands().flatMap((c) => [c.name, ...(c.aliases ?? [])])
  } else {
    const command = getDebugCommand(done[0])
    // `complete` receives the args after the command name, ending with the word being typed.
    candidates = command?.complete?.([...done.slice(1), typing]) ?? []
  }
  const matches = [...new Set(candidates.filter((c) => c.toLowerCase().startsWith(typing.toLowerCase())))].sort()
  if (matches.length === 0) return { value: input, candidates: [] }

  const head = done.map((t) => (/\s/.test(t) ? `"${t}"` : t)).join(' ')
  const prefix = matches.length === 1 ? matches[0] : commonPrefix(matches)
  const word = /\s/.test(prefix) ? `"${prefix}"` : prefix
  const value = `${head}${head ? ' ' : ''}${word}${matches.length === 1 ? ' ' : ''}`
  return { value, candidates: matches }
}
