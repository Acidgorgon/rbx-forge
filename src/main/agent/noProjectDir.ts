// Working folder for agent turns when no project is open. process.cwd() in the packaged app is the
// install folder (or C:\Windows\System32 on Windows), so tools must never run there.
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function noProjectDir(): string {
  const dir = join(tmpdir(), 'rbx-forge-no-project')
  mkdirSync(dir, { recursive: true })
  return dir
}
