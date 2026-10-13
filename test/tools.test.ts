import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildToolPath,
  envGet,
  findBash,
  findPowerShell,
  findPythonCommand,
  findTool,
  outputLines,
  planSpawn,
  quoteCmdArg,
  rokitBin,
  toolEnv,
  toRepoPath,
  type ToolContext
} from '../src/main/services/tools.ts'
import { devCommand } from '../src/main/services/supervisor.ts'
import { bundledClaudeExecutable } from '../src/main/services/sdkBinary.ts'

function ctx(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, files: string[] = [], dirs: Record<string, string[]> = {}): ToolContext {
  const set = new Set(files.map((f) => (platform === 'win32' ? f.toLowerCase() : f)))
  return {
    platform,
    env,
    home: platform === 'win32' ? 'C:\\Users\\me' : platform === 'darwin' ? '/Users/me' : '/home/me',
    isExecutable: (file) => set.has(platform === 'win32' ? file.toLowerCase() : file),
    listDir: (dir) => dirs[dir] ?? []
  }
}

test('envGet is case-insensitive on Windows only', () => {
  assert.equal(envGet({ Path: 'a' }, 'PATH', 'win32'), 'a')
  assert.equal(envGet({ Path: 'a' }, 'PATH', 'linux'), undefined)
})

test('rokit bin uses USERPROFILE on Windows and home elsewhere', () => {
  assert.equal(rokitBin(ctx('win32', { USERPROFILE: 'D:\\Me' })), 'D:\\Me\\.rokit\\bin')
  assert.equal(rokitBin(ctx('darwin', {})), '/Users/me/.rokit/bin')
})

test('macOS tool PATH adds rokit first, then the Finder PATH, login PATH, Homebrew and nvm', () => {
  const c = ctx('darwin', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, [], { '/Users/me/.nvm/versions/node': ['v18.20.0', 'v22.3.0', 'v20.11.1'] })
  const dirs = buildToolPath(c, '/opt/homebrew/bin:/Users/me/custom').split(':')
  assert.equal(dirs[0], '/Users/me/.rokit/bin')
  assert.deepEqual(dirs.slice(1, 5), ['/usr/bin', '/bin', '/usr/sbin', '/sbin'])
  assert.ok(dirs.indexOf('/Users/me/custom') > 0)
  assert.ok(dirs.includes('/opt/homebrew/bin'))
  assert.ok(dirs.includes('/usr/local/bin'))
  assert.ok(dirs.includes('/Users/me/.nvm/versions/node/v22.3.0/bin'))
  assert.equal(new Set(dirs).size, dirs.length, 'no duplicates')
})

test('NVM_BIN wins over scanning nvm versions', () => {
  const c = ctx('darwin', { PATH: '/usr/bin', NVM_BIN: '/Users/me/.nvm/versions/node/v20.0.0/bin' }, [], {
    '/Users/me/.nvm/versions/node': ['v22.3.0']
  })
  const dirs = buildToolPath(c).split(':')
  assert.ok(dirs.includes('/Users/me/.nvm/versions/node/v20.0.0/bin'))
  assert.ok(!dirs.includes('/Users/me/.nvm/versions/node/v22.3.0/bin'))
})

test('Windows tool PATH uses ; and dedupes case-insensitively', () => {
  const c = ctx('win32', { Path: 'C:\\Users\\me\\.rokit\\bin\;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\me', ProgramFiles: 'C:\\Program Files' })
  const dirs = buildToolPath(c).split(';')
  assert.equal(dirs[0], 'C:\\Users\\me\\.rokit\\bin')
  assert.equal(dirs.filter((d) => d.toLowerCase().startsWith('c:\\users\\me\\.rokit')).length, 1)
  assert.ok(dirs.includes('C:\\Windows\\System32'))
  assert.ok(dirs.includes('C:\\Program Files\\Git\\cmd'))
})

test('toolEnv on Windows leaves exactly one PATH key', () => {
  const env = toolEnv(ctx('win32', { PATH: 'C:\\a', Path: 'C:\\b', USERPROFILE: 'C:\\Users\\me' }))
  const keys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
  assert.deepEqual(keys, ['Path'])
  assert.ok(env.Path!.startsWith('C:\\Users\\me\\.rokit\\bin;'))
})

test('findTool resolves PATHEXT on Windows, preferring .exe over .cmd', () => {
  const c = ctx('win32', { Path: 'C:\\tools', USERPROFILE: 'C:\\Users\\me' }, ['C:\\tools\\rojo.cmd', 'C:\\tools\\rojo.exe', 'C:\\Users\\me\\.rokit\\bin\\wally.exe'])
  assert.equal(findTool('rojo', c), 'C:\\tools\\rojo.exe')
  assert.equal(findTool('wally', c), 'C:\\Users\\me\\.rokit\\bin\\wally.exe')
  assert.equal(findTool('missing', c), null)
})

test('findTool finds rokit tools on macOS even with the Finder PATH', () => {
  const c = ctx('darwin', { PATH: '/usr/bin:/bin' }, ['/Users/me/.rokit/bin/luau-lsp', '/opt/homebrew/bin/git', '/usr/bin/git'])
  assert.equal(findTool('luau-lsp', c), '/Users/me/.rokit/bin/luau-lsp')
  assert.equal(findTool('git', c), '/usr/bin/git', 'the existing PATH wins over Homebrew')
})

test('python: py -3 on Windows, never the WindowsApps store stub; python3 elsewhere', () => {
  const local = 'C:\\Users\\me\\AppData\\Local'
  const stub = `${local}\\Microsoft\\WindowsApps`
  const win = (files: string[], dirs: Record<string, string[]> = {}) =>
    ctx('win32', { Path: `${stub};C:\\Windows`, USERPROFILE: 'C:\\Users\\me', LOCALAPPDATA: local }, files, dirs)
  assert.deepEqual(findPythonCommand(win([`${stub}\\python.exe`, 'C:\\Windows\\py.exe'])), { file: 'C:\\Windows\\py.exe', args: ['-3'] })
  assert.equal(findPythonCommand(win([`${stub}\\python.exe`, `${stub}\\python3.exe`])), null)
  const installed = win([`${local}\\Programs\\Python\\Python312\\python.exe`], { [`${local}\\Programs\\Python`]: ['Python311', 'Python312'] })
  assert.deepEqual(findPythonCommand(installed), { file: `${local}\\Programs\\Python\\Python312\\python.exe`, args: [] })
  assert.deepEqual(findPythonCommand(ctx('darwin', { PATH: '/usr/bin' }, ['/usr/bin/python3'])), { file: '/usr/bin/python3', args: [] })
})

test('PowerShell: pwsh, then Windows PowerShell by full path', () => {
  assert.equal(findPowerShell(ctx('win32', { Path: 'C:\\pw', USERPROFILE: 'C:\\u' }, ['C:\\pw\\pwsh.exe'])), 'C:\\pw\\pwsh.exe')
  assert.equal(
    findPowerShell(ctx('win32', { Path: '', USERPROFILE: 'C:\\u', SystemRoot: 'C:\\Windows' })),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  )
})

test('bash on Windows is Git Bash, never the System32 WSL launcher', () => {
  const env = { Path: 'C:\\Windows\\System32;D:\\Git\\cmd', USERPROFILE: 'C:\\u', ProgramFiles: 'C:\\Program Files' }
  assert.equal(findBash(ctx('win32', env, ['C:\\Windows\\System32\\bash.exe'])), null)
  assert.equal(findBash(ctx('win32', env, ['C:\\Windows\\System32\\bash.exe', 'D:\\Git\\cmd\\git.exe', 'D:\\Git\\bin\\bash.exe'])), 'D:\\Git\\bin\\bash.exe')
  assert.equal(findBash(ctx('win32', env, ['C:\\Program Files\\Git\\bin\\bash.exe'])), 'C:\\Program Files\\Git\\bin\\bash.exe')
})

test('.cmd/.bat go through cmd.exe with escaped arguments; others spawn directly', () => {
  assert.deepEqual(planSpawn('C:\\t\\rojo.exe', ['serve'], 'win32', {}), { file: 'C:\\t\\rojo.exe', args: ['serve'] })
  assert.deepEqual(planSpawn('/usr/bin/x.cmd', ['a'], 'linux', {}), { file: '/usr/bin/x.cmd', args: ['a'] })
  const plan = planSpawn('C:\\Program Files\\t\\tool.cmd', ['a b', 'x&calc', '50%'], 'win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(plan.windowsVerbatimArguments, true)
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.ok(plan.args[3].includes('^&calc'), 'metacharacters are caret-escaped')
  assert.ok(plan.args[3].includes('50^%'))
  assert.equal(quoteCmdArg('say "hi"'), '^"say^ \\^"hi\\^"^"')
})

test('outputLines handles CRLF and toRepoPath uses forward slashes', () => {
  assert.deepEqual(outputLines('origin\r\nupstream\r\n\r\n'), ['origin', 'upstream'])
  assert.equal(toRepoPath('src\\shared\\Foo.luau'), 'src/shared/Foo.luau')
  assert.equal(toRepoPath('./src/a.luau'), 'src/a.luau')
})

test('dev command: dev.ps1 under PowerShell on Windows, ./dev under bash elsewhere', () => {
  const locate = { powershell: () => 'pwsh.exe', bash: () => '/bin/bash' }
  const has = (files: string[]) => (p: string) => files.some((f) => p.replace(/\\/g, '/').endsWith(f))
  const win = devCommand('C:/game', 'win32', has(['tools/dev.ps1', 'dev']), locate)
  assert.ok('file' in win && win.file === 'pwsh.exe' && win.args.includes('-File'))
  const winBash = devCommand('C:/game', 'win32', has(['dev']), locate)
  assert.deepEqual(winBash, { file: '/bin/bash', args: ['./dev'] })
  const winNone = devCommand('C:/game', 'win32', has(['dev']), { powershell: () => 'p', bash: () => null })
  assert.ok('missing' in winNone)
  assert.deepEqual(devCommand('/game', 'darwin', has(['dev']), locate), { file: '/bin/bash', args: ['./dev'] })
  assert.deepEqual(devCommand('/game', 'linux', has([]), locate), { file: '/bin/bash', args: ['tools/dev.sh'] })
})

test('bundled Claude CLI is looked up in app.asar.unpacked for the running platform', () => {
  const seen: string[] = []
  const exists = (p: string) => (seen.push(p), p.includes('claude-agent-sdk-darwin-arm64'))
  const found = bundledClaudeExecutable('/Applications/RBX Forge.app/Contents/Resources', 'darwin', 'arm64', exists)
  assert.ok(found?.replace(/\\/g, '/').endsWith('app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'))
  assert.equal(bundledClaudeExecutable('/r', 'win32', 'x64', () => false), undefined)
  bundledClaudeExecutable('/r', 'win32', 'x64', (p) => (seen.push(p), false))
  assert.ok(seen.at(-1)!.endsWith('claude.exe'))
  assert.equal(bundledClaudeExecutable(undefined), undefined)
})
