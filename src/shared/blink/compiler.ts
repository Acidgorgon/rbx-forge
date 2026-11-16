// Which compiler builds a project's .blink files: upstream Blink (github.com/1Axen/blink, command
// `blink`) or Current (github.com/Acidgorgon/current, our fork of Blink, command `current`). Current
// reads the same schema language (events.blink stays the entry) plus `From: Both`, takes the same
// arguments (`current events.blink --yes`) and writes the same output files.
// Shared so main (lookup, checks, doctor) and the renderer (labels, docs) agree.

export type BlinkCommand = 'current' | 'blink'

// Forge looks for these, in this order, unless the project pins one of them (see blinkCommands).
export const BLINK_COMMANDS: readonly BlinkCommand[] = ['current', 'blink']

// Current's vetted rokit pin. Forge's own global pin (new projects, first-run setup) stays upstream
// Blink; a game opts in to Current with this one rokit.toml line in place of `blink = ...`.
export const CURRENT_TOOL = { alias: 'current', id: 'Acidgorgon/current', version: '0.1.0' } as const
export const CURRENT_ROKIT_LINE = `${CURRENT_TOOL.alias} = "${CURRENT_TOOL.id}@${CURRENT_TOOL.version}"`

// The commands to try, best first, given the aliases a rokit.toml pins. A project that pins only
// one of them gets that one first: rokit's shim for the other alias would otherwise fail there
// ("no tool named current") or run a compiler the project did not choose. Otherwise `current`,
// then `blink`.
export function blinkCommands(pinned: Iterable<string> = []): BlinkCommand[] {
  const names = new Set([...pinned].map((a) => a.toLowerCase()))
  if (names.has('blink') && !names.has('current')) return ['blink', 'current']
  return [...BLINK_COMMANDS]
}

// The alias of the compiler a rokit.toml pins (Current wins when both are there), or null.
export function pinnedBlinkCommand(pinned: Iterable<string>): BlinkCommand | null {
  const names = new Set([...pinned].map((a) => a.toLowerCase()))
  return BLINK_COMMANDS.find((c) => names.has(c)) ?? null
}

// "Current" or "Blink", for labels.
export function blinkCompilerName(command: BlinkCommand | undefined | null): 'Current' | 'Blink' {
  return command === 'current' ? 'Current' : 'Blink'
}

// The command a binary path runs (".../current", "C:\...\current.exe"), when it is one of ours.
export function blinkCommandOf(binary: string): BlinkCommand | undefined {
  const base = binary.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '')
  return base === 'current' || base === 'blink' ? base : undefined
}
