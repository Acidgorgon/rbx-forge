#!/usr/bin/env node
// Reproduces the rojo serve crash behind "Rojo disconnects during syncs" and checks a rojo binary
// survives it:  node tools/rojo/burst-test.mjs <path to rojo> [--expect-crash]
//
// rojo 7.7.0 panics (and on Windows exits with code 1) when it handles a file event for a path that
// no longer exists: change_processor.rs unwraps canonicalize(). Studio's Rojo plugin then shows
// "WebSocket error ... forcibly closed by the remote host". Each case below makes such an event:
//   rename-after-write  a folder renamed right after files were written into it (crashes on Windows)
//   delete-after-write  a folder deleted right after files were written into it (crashes on Linux)
//   temp-rename         editor/agent style atomic writes: temp file, then rename over the target
// Each case gets a fresh `rojo serve` and a WebSocket client like Studio's plugin. A case passes when
// the server is still running and the socket still open afterwards. Exit code 0 = every case passed
// (with --expect-crash: at least one case crashed, i.e. the bug reproduces with that binary).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CI: a crash of this script itself as an annotation (job logs are not always readable).
if (process.env.GITHUB_ACTIONS) {
  process.on('uncaughtException', (error) => {
    console.log(`::error::burst-test crashed: ${String(error?.stack ?? error).replace(/\r?\n/g, ' | ')}`)
    process.exit(1)
  })
}

const bin = process.argv[2]
const expectCrash = process.argv.includes('--expect-crash')
if (!bin) {
  console.error('usage: node tools/rojo/burst-test.mjs <rojo binary> [--expect-crash]')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ROUNDS = 20

// Windows: rojo briefly holds files it is reading, so a rename / delete can fail with EPERM / EBUSY.
// That is the writer's problem, not rojo's: retry like editors and agents do.
function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return fn()
    } catch (error) {
      if (i >= 50 || !['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}

const CASES = {
  'rename-after-write': (src, round) => {
    const dir = join(src, `H${round}`)
    mkdirSync(join(dir, 'Sub'), { recursive: true })
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, 'Sub', `M${i}.luau`), `return ${i}\n`)
    retry(() => renameSync(dir, join(src, `H${round}x`)))
  },
  'delete-after-write': (src, round) => {
    const dir = join(src, `T${round}`)
    mkdirSync(join(dir, 'Sub'), { recursive: true })
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, 'Sub', `M${i}.luau`), `return ${i}\n`)
    retry(() => rmSync(dir, { recursive: true, force: true }))
  },
  'temp-rename': (src, round) => {
    mkdirSync(join(src, 'Modules'), { recursive: true })
    for (let i = 0; i < 10; i++) {
      const temp = join(src, 'Modules', `.P${i}.luau.${process.pid}-${round}.tmp`)
      writeFileSync(temp, `return "${round}-${i}"\n`)
      retry(() => renameSync(temp, join(src, 'Modules', `P${i}.luau`)))
    }
  }
}

async function runCase(name, write, port) {
  const root = mkdtempSync(join(tmpdir(), 'rojo-burst-'))
  const src = join(root, 'src', 'shared')
  mkdirSync(join(src, 'Modules'), { recursive: true })
  for (let i = 0; i < 10; i++) writeFileSync(join(src, 'Modules', `P${i}.luau`), `return ${i}\n`)
  writeFileSync(
    join(root, 'default.project.json'),
    JSON.stringify({ name: 'Burst', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared', $ignoreUnknownInstances: true } } } })
  )
  let output = ''
  let exited = null
  const child = spawn(bin, ['serve', 'default.project.json', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  child.on('exit', (code, signal) => (exited = signal ?? code))
  child.on('error', (error) => {
    output += `spawn failed: ${error.message}`
    exited = 'spawn-error'
  })
  try {
    let ws = null
    for (let i = 0; i < 50 && !ws; i++) {
      await sleep(200)
      if (exited !== null) break
      ws = await new Promise((resolve) => {
        const s = new WebSocket(`ws://127.0.0.1:${port}/api/socket/0`)
        s.onopen = () => resolve(s)
        s.onerror = () => resolve(null)
      })
    }
    if (!ws) return { name, ok: false, why: `rojo serve never accepted a WebSocket${exited !== null ? ` (exited ${exited})` : ''}`, output }
    let closed = false
    ws.onclose = () => (closed = true)
    for (let round = 0; round < ROUNDS; round++) {
      try {
        write(src, round)
      } catch (error) {
        return { name, ok: false, why: `the test's own write failed (${error.code ?? error.message})`, output }
      }
      await sleep(25)
    }
    await sleep(2500)
    const panicked = /panicked|unwrap\(\)/.test(output)
    const ok = exited === null && !closed && !panicked
    ws.close()
    return { name, ok, why: ok ? 'still serving' : [exited !== null ? `exited (${exited})` : '', closed ? 'socket closed' : '', panicked ? 'panicked' : ''].filter(Boolean).join(', '), output }
  } finally {
    child.kill()
    await sleep(300)
    rmSync(root, { recursive: true, force: true })
  }
}

let port = 34990
const results = []
for (const [name, write] of Object.entries(CASES)) results.push(await runCase(name, write, port++))
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.why}`)
  const details = r.output.split(/\r?\n/).find((l) => /Details:/.test(l))
  if (!r.ok && details) console.log(`      ${details.trim()}`)
  // CI: failures as annotations (readable without the job log).
  if (!r.ok && process.env.GITHUB_ACTIONS) console.log(`::error::${r.name}: ${r.why} | ${(details ?? r.output.slice(-400)).replace(/\r?\n/g, ' ').trim()}`)
}
const crashed = results.some((r) => !r.ok)
if (expectCrash) {
  console.log(crashed ? 'The crash reproduces with this binary.' : 'No crash with this binary.')
  process.exit(crashed ? 0 : 1)
}
process.exit(crashed ? 1 : 0)
