// What a restart into an update would interrupt. Pure (tested in test/updater.test.ts): the
// restart asks first when this returns anything, and never restarts on its own.

export interface RestartInput {
  files: { path: string; current: string; saved: string }[]
  busy: Record<string, boolean>
  agents: { state: string }[]
  boards: { state: string }[]
  testsRunning: boolean
}

const base = (path: string) => path.split(/[\\/]/).pop() ?? path
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function restartBlockers(input: RestartInput): string[] {
  const out: string[] = []
  const dirty = input.files.filter((f) => f.current !== f.saved)
  if (dirty.length) {
    const names = dirty.slice(0, 3).map((f) => base(f.path)).join(', ')
    out.push(`${plural(dirty.length, 'file has', 'files have')} unsaved changes (${names}${dirty.length > 3 ? ', ...' : ''})`)
  }
  const chats = Object.values(input.busy).filter(Boolean).length
  if (chats) out.push(`${plural(chats, 'chat is', 'chats are')} still answering`)
  const agents = input.agents.filter((a) => a.state === 'running' || a.state === 'queued').length
  if (agents) out.push(`${plural(agents, 'test agent is', 'test agents are')} running`)
  const boards = input.boards.filter((b) => b.state === 'planning' || b.state === 'running' || b.state === 'integrating').length
  if (boards) out.push(`${plural(boards, 'agent team is', 'agent teams are')} working`)
  if (input.testsRunning) out.push('Lune tests are running')
  return out
}
