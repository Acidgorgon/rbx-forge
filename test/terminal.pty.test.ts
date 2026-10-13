// Smoke test against the real node-pty native module. Skips when it cannot load (no prebuild or
// compiler for this platform, or a binary built for another arch/ABI).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadPtyBackend } from '../src/main/services/terminal/backend.ts'
import { PtyManager } from '../src/main/services/terminal/ptyManager.ts'
import { commandArgs } from '../src/main/services/terminal/shells.ts'
import type { ShellInfo } from '../src/shared/types.ts'

const backend = await loadPtyBackend()
const skip = backend.error ? `node-pty unavailable: ${backend.error}` : false
const win = process.platform === 'win32'
const shell: ShellInfo = win
  ? { id: 'cmd', label: 'cmd', path: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', args: [], default: true }
  : { id: 'sh', label: 'sh', path: '/bin/sh', args: [], default: true }

function manager(data: string[] = []) {
  return new PtyManager({
    spawn: backend.spawn!,
    cwd: () => process.cwd(),
    env: () => ({ ...(process.env as Record<string, string>), FORGE_SMOKE: 'pty-ok' }),
    shells: () => [shell],
    commandArgs: (s, c) => commandArgs(s, c, process.platform),
    onData: (_id, d) => data.push(d),
    onList: () => undefined,
    batchMs: 1
  })
}

test('node-pty runs a command and reports its exit code', { skip, timeout: 20_000 }, async () => {
  const m = manager()
  const r = await m.run(win ? 'echo %FORGE_SMOKE% & exit 3' : 'echo "$FORGE_SMOKE"; exit 3', { timeoutMs: 15_000 })
  assert.equal(r.timedOut, false)
  assert.equal(r.exitCode, 3)
  assert.match(r.output, /pty-ok/)
  m.killAll()
})

test('node-pty interactive shell: input, resize and kill', { skip, timeout: 20_000 }, async () => {
  const data: string[] = []
  const m = manager(data)
  const t = m.create({ cols: 90, rows: 20 })
  assert.ok(t.pid && t.pid > 0)
  m.resize(t.id, 120, 30)
  m.write(t.id, win ? 'echo forge-%FORGE_SMOKE%\r' : 'echo "forge-$FORGE_SMOKE"\r')
  const deadline = Date.now() + 10_000
  while (!data.join('').includes('forge-pty-ok') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.match(data.join(''), /forge-pty-ok/)
  m.kill(t.id)
  assert.equal(m.list().length, 0)
})
