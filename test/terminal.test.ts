// Integrated terminal: PtyManager over an injected fake pty, shell detection, tasks, env, and the
// run_in_terminal confirmation flow (TerminalService).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PtyManager, plainText, type PtyLike, type PtySpawnOptions } from '../src/main/services/terminal/ptyManager.ts'
import { commandArgs, detectShells, terminalEnv, terminalTasks } from '../src/main/services/terminal/shells.ts'
import { TerminalService } from '../src/main/services/terminal/index.ts'
import type { ToolContext } from '../src/main/services/tools.ts'
import type { ShellInfo, TerminalInfo } from '../src/shared/types.ts'

class FakePty implements PtyLike {
  pid: number
  written: string[] = []
  sizes: [number, number][] = []
  killed = false
  private data = new Set<(d: string) => void>()
  private exit = new Set<(e: { exitCode: number }) => void>()
  file: string
  args: string[]
  options: PtySpawnOptions
  constructor(file: string, args: string[], options: PtySpawnOptions, pid: number) {
    this.file = file
    this.args = args
    this.options = options
    this.pid = pid
  }
  onData(l: (d: string) => void) {
    this.data.add(l)
    return { dispose: () => this.data.delete(l) }
  }
  onExit(l: (e: { exitCode: number }) => void) {
    this.exit.add(l)
    return { dispose: () => this.exit.delete(l) }
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r])
  }
  kill() {
    this.killed = true
  }
  emit(d: string) {
    for (const l of this.data) l(d)
  }
  end(code: number) {
    for (const l of this.exit) l({ exitCode: code })
  }
}

const SHELLS: ShellInfo[] = [
  { id: 'login', label: 'zsh (login)', path: '/bin/zsh', args: ['-l'], default: true },
  { id: 'bash', label: 'bash', path: '/bin/bash', args: ['-l'] }
]

function setup(root: string | null = '/proj', releaseExited = false) {
  const ptys: FakePty[] = []
  const data: { id: string; data: string }[] = []
  const lists: TerminalInfo[][] = []
  const manager = new PtyManager({
    spawn: (file, args, options) => {
      const p = new FakePty(file, args, options, 100 + ptys.length)
      ptys.push(p)
      return p
    },
    cwd: () => root,
    env: () => ({ PATH: '/rokit/bin:/usr/bin', TERM: 'xterm-256color' }),
    shells: () => SHELLS,
    commandArgs: (shell, command) => commandArgs(shell, command, 'darwin'),
    onData: (id, d) => data.push({ id, data: d }),
    onList: (list) => lists.push(list),
    batchMs: 0,
    now: () => 1000,
    releaseExited
  })
  return { manager, ptys, data, lists }
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

test('create spawns the default shell in the project root with the terminal env', () => {
  const { manager, ptys, lists } = setup()
  const t = manager.create({ cols: 100, rows: 30 })
  assert.equal(ptys.length, 1)
  assert.equal(ptys[0].file, '/bin/zsh')
  assert.deepEqual(ptys[0].args, ['-l'])
  assert.equal(ptys[0].options.cwd, '/proj')
  assert.equal(ptys[0].options.cols, 100)
  assert.equal(ptys[0].options.rows, 30)
  assert.equal(ptys[0].options.env.PATH, '/rokit/bin:/usr/bin')
  assert.equal(t.title, 'zsh')
  assert.equal(t.pid, 100)
  assert.equal(t.kind, 'shell')
  assert.equal(lists.at(-1)?.length, 1)
  // A second one with the same shell gets a numbered title; picking a shell by id works.
  assert.equal(manager.create().title, 'zsh 2')
  assert.equal(manager.create({ shellId: 'bash' }).title, 'bash')
  assert.equal(ptys[2].file, '/bin/bash')
})

test('create refuses without a project', () => {
  const { manager } = setup(null)
  assert.throws(() => manager.create(), /Open a project/)
})

test('output is batched to onData and kept for replay; input and resize reach the pty', async () => {
  const { manager, ptys, data } = setup()
  const t = manager.create()
  ptys[0].emit('hello ')
  ptys[0].emit('world\r\n')
  await tick()
  assert.deepEqual(data, [{ id: t.id, data: 'hello world\r\n' }])
  assert.equal(manager.buffer(t.id), 'hello world\r\n')
  manager.write(t.id, 'ls\r')
  assert.deepEqual(ptys[0].written, ['ls\r'])
  manager.resize(t.id, 5000, 0)
  manager.resize(t.id, NaN, 10)
  assert.deepEqual(ptys[0].sizes, [[1000, 1]])
})

test('exit keeps the tab with its status; kill removes it and kills the process', async () => {
  const { manager, ptys, lists } = setup()
  const a = manager.create()
  const b = manager.create()
  ptys[0].end(2)
  await tick()
  const after = manager.get(a.id)!
  assert.equal(after.exited, true)
  assert.equal(after.exitCode, 2)
  assert.match(manager.buffer(a.id), /process exited with code 2/)
  // Writing to an exited terminal is ignored.
  manager.write(a.id, 'x')
  assert.deepEqual(ptys[0].written, [])
  manager.kill(b.id)
  assert.equal(ptys[1].killed, true)
  assert.deepEqual(manager.list().map((t) => t.id), [a.id])
  assert.deepEqual(lists.at(-1)?.map((t) => t.id), [a.id])
})

test('rename trims and caps; empty names are ignored', () => {
  const { manager } = setup()
  const t = manager.create()
  manager.rename(t.id, '   build   logs  ')
  assert.equal(manager.get(t.id)?.title, 'build logs')
  manager.rename(t.id, '   ')
  assert.equal(manager.get(t.id)?.title, 'build logs')
  manager.rename(t.id, 'x'.repeat(100))
  assert.equal(manager.get(t.id)?.title.length, 60)
})

test('killAll ends every process (project close / quit)', () => {
  const { manager, ptys } = setup()
  manager.create()
  manager.create()
  manager.killAll()
  assert.equal(manager.list().length, 0)
  assert.ok(ptys.every((p) => p.killed))
})

test('a spawn failure shows the error in an exited tab', () => {
  const manager = new PtyManager({
    spawn: () => {
      throw new Error('posix_spawnp failed')
    },
    cwd: () => '/proj',
    env: () => ({}),
    shells: () => SHELLS,
    commandArgs: (s, c) => commandArgs(s, c, 'darwin'),
    onData: () => undefined,
    onList: () => undefined,
    batchMs: 0
  })
  const t = manager.create()
  assert.equal(t.exited, true)
  assert.match(manager.buffer(t.id), /posix_spawnp failed/)
})

test('run executes one command through the shell and returns plain output and the exit code', async () => {
  const { manager, ptys } = setup()
  const pending = manager.run('wally install', { timeoutMs: 1000 })
  assert.deepEqual(ptys[0].args, ['-lc', 'wally install'])
  assert.equal(manager.list()[0].kind, 'agent')
  assert.equal(manager.list()[0].command, 'wally install')
  ptys[0].emit('\x1b[32m   Downloaded\x1b[0m 3 packages\r\n')
  ptys[0].emit('50%\r100%\r\n')
  ptys[0].end(0)
  const r = await pending
  assert.equal(r.exitCode, 0)
  assert.equal(r.timedOut, false)
  assert.equal(r.output, '   Downloaded 3 packages\n100%')
})

test('run times out but leaves the process running in its tab', async () => {
  const { manager, ptys } = setup()
  const r = await manager.run('rojo serve', { timeoutMs: 20 })
  assert.equal(r.timedOut, true)
  assert.equal(r.exitCode, null)
  assert.equal(ptys[0].killed, false)
  assert.equal(manager.get(r.id)?.exited, false)
})

test('run stops the command when aborted', async () => {
  const { manager, ptys } = setup()
  const abort = new AbortController()
  const pending = manager.run('sleep 100', { signal: abort.signal })
  abort.abort()
  const r = await pending
  assert.equal(r.exitCode, null)
  assert.equal(ptys[0].killed, true)
})

test('closing an exited tab releases its pty only where the backend needs it (Windows ConPTY)', () => {
  for (const release of [false, true]) {
    const { manager, ptys } = setup('/proj', release)
    const a = manager.create()
    const b = manager.create()
    ptys[0].end(0)
    ptys[1].end(1)
    manager.kill(a.id)
    manager.killAll()
    assert.deepEqual(ptys.map((p) => p.killed), [release, release])
  }
})

test('plainText strips CSI/OSC sequences and carriage-return overwrites', () => {
  assert.equal(plainText('\x1b]0;title\x07a\x1b[1;31mb\x1b[0m\r\nx\ry\r\n'), 'ab\ny\n')
})

// ---------------------------------------------------------------- shells, env, tasks

function ctx(platform: NodeJS.Platform, files: string[], env: NodeJS.ProcessEnv = {}): ToolContext {
  const set = new Set(files)
  return { platform, env, home: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me', isExecutable: (f) => set.has(f), listDir: () => [] }
}

test('macOS: the login shell is the default and starts as a login shell', () => {
  const shells = detectShells(ctx('darwin', ['/bin/zsh', '/bin/bash', '/bin/sh'], { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }))
  assert.equal(shells[0].id, 'login')
  assert.equal(shells[0].path, '/bin/zsh')
  assert.deepEqual(shells[0].args, ['-l'])
  assert.equal(shells[0].default, true)
  // zsh is not listed twice.
  assert.deepEqual(shells.map((s) => s.id), ['login', 'bash', 'sh'])
  // Without $SHELL the passwd entry is used.
  assert.equal(detectShells(ctx('darwin', ['/bin/zsh']), { passwdShell: '/opt/homebrew/bin/fish' })[0].path, '/opt/homebrew/bin/fish')
})

test('Windows: pwsh when installed, else Windows PowerShell; cmd and Git Bash are offered', () => {
  const pwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const env = { Path: 'C:\\Program Files\\PowerShell\\7', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', ProgramFiles: 'C:\\Program Files', PATHEXT: '.EXE' }
  const withPwsh = detectShells(ctx('win32', [pwsh, gitBash], env))
  assert.deepEqual(withPwsh.map((s) => s.id), ['pwsh', 'powershell', 'cmd', 'gitbash'])
  assert.equal(withPwsh[0].default, true)
  assert.equal(withPwsh[0].path, pwsh)
  const without = detectShells(ctx('win32', [], env))
  assert.equal(without[0].id, 'powershell')
  assert.equal(without[0].path, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(without[0].default, true)
  // A saved preference wins.
  assert.equal(detectShells(ctx('win32', [pwsh], env), { preferred: 'cmd' }).find((s) => s.default)?.id, 'cmd')
})

test('one-shot command arguments per shell', () => {
  const sh = (path: string): ShellInfo => ({ id: 'x', label: 'x', path, args: [] })
  assert.deepEqual(commandArgs(sh('/bin/zsh'), 'ls', 'darwin'), ['-lc', 'ls'])
  assert.deepEqual(commandArgs(sh('/opt/homebrew/bin/fish'), 'ls', 'darwin'), ['-l', '-c', 'ls'])
  assert.deepEqual(commandArgs(sh('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'ls', 'win32'), ['-NoLogo', '-NoProfile', '-Command', 'ls'])
  assert.deepEqual(commandArgs(sh('C:\\Windows\\System32\\cmd.exe'), 'dir', 'win32'), ['/d', '/s', '/c', 'dir'])
})

test('terminal env keeps the tool PATH (Rokit first), turns colour on and drops Electron switches', () => {
  const env = terminalEnv({ PATH: '/Users/me/.rokit/bin:/usr/bin', NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1', HOME: '/Users/me' }, 'darwin')
  assert.equal(env.PATH, '/Users/me/.rokit/bin:/usr/bin')
  assert.equal(env.NO_COLOR, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.COLORTERM, 'truecolor')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(terminalEnv({ LANG: 'de_DE.UTF-8' }, 'darwin').LANG, 'de_DE.UTF-8')
})

test('tasks: ./dev and ./check use tools/*.ps1 under PowerShell when present, else bash', () => {
  const mac = terminalTasks('darwin', () => false)
  assert.deepEqual(mac.map((t) => t.label), ['./dev', './check', 'rojo serve', 'wally install', 'lune run tests'])
  assert.equal(mac[0].command, './dev')
  const ps: ShellInfo = { id: 'pwsh', label: 'PowerShell 7', path: 'pwsh.exe', args: [] }
  const win = terminalTasks('win32', (rel) => rel === 'tools/dev.ps1', ps)
  assert.equal(win[0].command, '& ./tools/dev.ps1')
  assert.equal(win[1].command, 'bash ./check')
  assert.equal(terminalTasks('win32', () => true, { ...ps, id: 'gitbash' })[0].command, './dev')
})

// ---------------------------------------------------------------- service + run_in_terminal

function service(root: string | null = '/proj') {
  const events: { event: string; payload: any }[] = []
  const ptys: FakePty[] = []
  const settings = new Map<string, unknown>()
  const svc = new TerminalService({
    backend: async () => ({
      spawn: (file, args, options) => {
        const p = new FakePty(file, args, options, 1 + ptys.length)
        ptys.push(p)
        return p
      }
    }),
    root: () => root,
    emit: (event, payload) => events.push({ event, payload }),
    getSetting: (k, f) => (settings.has(k) ? (settings.get(k) as any) : f),
    setSetting: (k, v) => settings.set(k, v),
    toolContext: () => ctx('darwin', ['/bin/zsh', '/bin/bash'], { SHELL: '/bin/zsh' }),
    env: () => ({ PATH: '/Users/me/.rokit/bin:/usr/bin' }),
    confirmTimeoutMs: 200
  })
  return { svc, events, ptys, settings }
}

test('run_in_terminal waits for the user and runs only after approval', async () => {
  const { svc, events, ptys } = service()
  const tool = svc.chatTools().find((t) => t.name === 'run_in_terminal')!
  const pending = tool.handler({ command: 'rokit install' }, {})
  await tick()
  assert.equal(ptys.length, 0)
  const ask = events.filter((e) => e.event === 'terminal:confirm').at(-1)!
  assert.equal(ask.payload.length, 1)
  assert.equal(ask.payload[0].command, 'rokit install')
  assert.equal(ask.payload[0].cwd, '/proj')
  svc.handlers().terminalConfirmRun(ask.payload[0].id, true)
  await tick()
  assert.equal(ptys.length, 1)
  assert.deepEqual(ptys[0].args, ['-lc', 'rokit install'])
  ptys[0].emit('installed 4 tools\r\n')
  ptys[0].end(0)
  const r = await pending
  assert.ok(!r.isError)
  assert.match(r.content[0].text, /^exit code 0\ninstalled 4 tools/)
  assert.deepEqual(events.filter((e) => e.event === 'terminal:confirm').at(-1)!.payload, [])
  assert.ok(events.some((e) => e.event === 'terminal:focus'))
})

test('run_in_terminal: deny, timeout and no project never spawn', async () => {
  const { svc, events, ptys } = service()
  const tool = svc.chatTools()[0]
  const denied = tool.handler({ command: 'rm -rf /' }, {})
  await tick()
  svc.confirm(events.filter((e) => e.event === 'terminal:confirm').at(-1)!.payload[0].id, false)
  assert.match((await denied).content[0].text, /declined/)
  // Nobody answers: the request expires.
  const expired = await tool.handler({ command: 'ls' }, {})
  assert.equal(expired.isError, true)
  assert.equal(ptys.length, 0)
  const none = service(null)
  assert.match((await none.svc.chatTools()[0].handler({ command: 'ls' }, {})).content[0].text, /no project/)
})

test('project close denies pending runs and kills every terminal', async () => {
  const { svc, events, ptys } = service()
  await svc.handlers().terminalCreate({})
  const pending = svc.chatTools()[0].handler({ command: 'ls' }, {})
  await tick()
  svc.onProjectClose()
  assert.match((await pending).content[0].text, /declined/)
  assert.equal(ptys[0].killed, true)
  assert.deepEqual(svc.manager.list(), [])
  assert.deepEqual(events.filter((e) => e.event === 'terminal:list').at(-1)!.payload, [])
})

test('the default shell is a saved setting; tasks open a tab and type the command', async () => {
  const { svc, ptys, settings } = service()
  const shells = svc.handlers().terminalSetDefaultShell('bash') as ShellInfo[]
  assert.equal(settings.get('terminal.defaultShell'), 'bash')
  assert.equal(shells.find((s) => s.default)?.id, 'bash')
  const info = await svc.runTask('wally')
  assert.equal(ptys[0].file, '/bin/bash')
  assert.equal(info.title, 'wally install')
  assert.equal(info.kind, 'task')
  assert.deepEqual(ptys[0].written, ['wally install\r'])
})

test('a backend that cannot load reports why', async () => {
  const svc = new TerminalService({
    backend: async () => ({ error: 'node-pty could not load: wrong ELF class' }),
    root: () => '/proj',
    emit: () => undefined,
    getSetting: (_k, f) => f,
    setSetting: () => undefined,
    toolContext: () => ctx('darwin', ['/bin/zsh'], { SHELL: '/bin/zsh' })
  })
  await assert.rejects(Promise.resolve(svc.handlers().terminalCreate({})), /wrong ELF class/)
})
