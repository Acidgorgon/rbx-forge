// Browser-preview mock of the integrated terminal (TerminalApi): a fake shell that echoes what you
// type, knows a few commands (help, ls, echo, clear, rojo/wally/lune --version) and fakes the tasks.
// mock.ts spreads it into its api object. window.__forgeTerminalAsk("cmd") fakes a run_in_terminal
// confirmation for design work.
import type { HarnessEvents, ShellInfo, TerminalApi, TerminalInfo, TerminalRunRequest, TerminalTask } from '@shared/types'

type Emit = <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void

const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const ROOT = mac ? '/Users/dev/Projects/gentree-game' : 'C:\\Users\\dev\\Projects\\gentree-game'

export function terminalMock(emit: Emit): TerminalApi {
  let shells: ShellInfo[] = mac
    ? [
        { id: 'login', label: 'zsh (login)', path: '/bin/zsh', args: ['-l'], default: true },
        { id: 'bash', label: 'bash', path: '/bin/bash', args: ['-l'] },
        { id: 'sh', label: 'sh', path: '/bin/sh', args: [] }
      ]
    : [
        { id: 'pwsh', label: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'], default: true },
        { id: 'powershell', label: 'Windows PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] },
        { id: 'cmd', label: 'Command Prompt', path: 'C:\\Windows\\System32\\cmd.exe', args: [] },
        { id: 'gitbash', label: 'Git Bash', path: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
      ]
  const tasks: TerminalTask[] = [
    { id: 'dev', label: './dev', command: mac ? './dev' : '& ./tools/dev.ps1', detail: 'watcher: Blink, features, wally' },
    { id: 'check', label: './check', command: mac ? './check' : '& ./tools/check.ps1', detail: 'lint, format and type checks' },
    { id: 'rojo', label: 'rojo serve', command: 'rojo serve', detail: 'live sync to Studio' },
    { id: 'wally', label: 'wally install', command: 'wally install', detail: 'install Packages/' },
    { id: 'lune', label: 'lune run tests', command: 'lune run tests', detail: 'Lune test runner' }
  ]
  const terms = new Map<string, { info: TerminalInfo; line: string; buffer: string }>()
  const pending: TerminalRunRequest[] = []
  let seq = 0

  const list = () => [...terms.values()].map((t) => ({ ...t.info }))
  const changed = () => emit('terminal:list', list())
  const out = (id: string, data: string) => {
    const t = terms.get(id)
    if (!t) return
    t.buffer += data
    setTimeout(() => emit('terminal:data', { id, data }), 0)
  }
  const prompt = (t: { info: TerminalInfo }) =>
    t.info.shellId.includes('powershell') || t.info.shellId === 'pwsh'
      ? `\x1b[38;5;245mPS\x1b[0m ${ROOT}> `
      : `\x1b[38;5;108mdev\x1b[0m \x1b[38;5;110m~/Projects/gentree-game\x1b[0m \x1b[38;5;245m%\x1b[0m `

  const run = (id: string, command: string): string => {
    const [cmd, ...rest] = command.trim().split(/\s+/)
    switch (cmd) {
      case '':
        return ''
      case 'help':
        return 'This is the browser preview: a fake shell that echoes.\r\nTry: ls, echo hi, rojo --version, wally install, clear\r\n'
      case 'ls':
      case 'dir':
        return '\x1b[38;5;110mPackages\x1b[0m  \x1b[38;5;110msrc\x1b[0m  \x1b[38;5;110mtests\x1b[0m  \x1b[38;5;110mtools\x1b[0m  default.project.json  events.blink  rokit.toml  wally.toml  dev  check\r\n'
      case 'echo':
        return rest.join(' ') + '\r\n'
      case 'pwd':
        return ROOT + '\r\n'
      case 'clear':
      case 'cls':
        return '\x1b[2J\x1b[3J\x1b[H'
      case 'rojo':
        if (rest[0] === 'serve') return 'Rojo server listening:\r\n  Address: localhost\r\n  Port:    34872\r\n\r\nVisit http://localhost:34872/ in your browser for more information.\r\n'
        return 'Rojo 7.7.0\r\n'
      case 'wally':
        return '\x1b[32m   Downloaded\x1b[0m 14 packages\r\n\x1b[32m   Installed\x1b[0m sleitnick/signal@2.0.3, centau/vide@0.4.1, littensy/charm@0.10.0 …\r\n'
      case 'lune':
        return '\x1b[32m✓\x1b[0m MathUtil.spec  6 passed\r\n\x1b[32m✓\x1b[0m ShopService.spec  4 passed\r\n\x1b[31m✗\x1b[0m HudController.spec  1 failed\r\n    expected 3, got 2  \x1b[4msrc/client/Client/Controllers/HudController.spec.luau:18\x1b[0m\r\n'
      case './dev':
      case '&':
        return '\x1b[2m[dev]\x1b[0m watching src/ and events.blink\r\n\x1b[2m[dev]\x1b[0m blink: compiled events.blink → src/shared/events\r\n\x1b[2m[dev]\x1b[0m wally: up to date\r\n'
      case './check':
        return 'selene: \x1b[32m0 errors\x1b[0m, \x1b[33m2 warnings\x1b[0m\r\nstylua: \x1b[32mok\x1b[0m\r\nluau-lsp analyze: \x1b[32mok\x1b[0m\r\n'
      default:
        return `${command}\r\n\x1b[2m(browser preview: commands are echoed, not run; see https://github.com/Acidgorgon/rbx-forge)\x1b[0m\r\n`
    }
  }

  const create = (shellId?: string, title?: string, kind: TerminalInfo['kind'] = 'shell', command?: string, withPrompt = true): TerminalInfo => {
    const shell = shells.find((s) => s.id === shellId) ?? shells.find((s) => s.default) ?? shells[0]
    const id = `t${++seq}`
    const base = title || shell.path.split(/[\\/]/).pop()!.replace(/\.exe$/i, '')
    const used = new Set(list().map((t) => t.title))
    let name = base
    for (let n = 2; used.has(name); n++) name = `${base} ${n}`
    const info: TerminalInfo = { id, title: name, kind, shellId: shell.id, shellLabel: shell.label, cwd: ROOT, pid: 4000 + seq, createdAt: Date.now(), exited: false, ...(command ? { command } : {}) }
    const t = { info, line: '', buffer: '' }
    terms.set(id, t)
    changed()
    if (withPrompt) out(id, prompt(t))
    return { ...info }
  }

  ;(window as unknown as { __forgeTerminalAsk?: (command: string) => void }).__forgeTerminalAsk = (command: string) => {
    pending.push({ id: `run${++seq}`, command, cwd: ROOT, requestedAt: Date.now() })
    emit('terminal:confirm', [...pending])
  }

  return {
    async terminalShells() {
      return shells
    },
    async terminalSetDefaultShell(shellId) {
      if (shells.some((s) => s.id === shellId)) shells = shells.map((s) => ({ ...s, default: s.id === shellId }))
      return shells
    },
    async terminalList() {
      return list()
    },
    async terminalCreate(options) {
      return create(options?.shellId, options?.title)
    },
    async terminalWrite(id, data) {
      const t = terms.get(id)
      if (!t || t.info.exited) return
      for (const ch of data) {
        if (ch === '\r') {
          const line = t.line
          t.line = ''
          out(id, '\r\n' + run(id, line) + prompt(t))
        } else if (ch === '\x7f') {
          if (t.line) {
            t.line = t.line.slice(0, -1)
            out(id, '\b \b')
          }
        } else if (ch === '\x03') {
          t.line = ''
          out(id, '^C\r\n' + prompt(t))
        } else if (ch >= ' ') {
          t.line += ch
          out(id, ch)
        }
      }
    },
    async terminalResize() {},
    async terminalKill(id) {
      terms.delete(id)
      changed()
    },
    async terminalRename(id, title) {
      const t = terms.get(id)
      if (t && title.trim()) t.info.title = title.trim().slice(0, 60)
      changed()
      return list()
    },
    async terminalBuffer(id) {
      return terms.get(id)?.buffer ?? ''
    },
    async terminalTasks() {
      return tasks
    },
    async terminalRunTask(taskId) {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) throw new Error(`unknown task ${taskId}`)
      const info = create(undefined, task.label, 'task', task.command)
      setTimeout(() => void this.terminalWrite(info.id, task.command + '\r'), 120)
      emit('terminal:focus', { id: info.id })
      return info
    },
    async terminalPendingRuns() {
      return [...pending]
    },
    async terminalConfirmRun(requestId, allow) {
      const i = pending.findIndex((p) => p.id === requestId)
      if (i < 0) return
      const [req] = pending.splice(i, 1)
      emit('terminal:confirm', [...pending])
      if (!allow) return
      const info = create(undefined, req.command.slice(0, 40), 'agent', req.command, false)
      const t = terms.get(info.id)!
      out(info.id, `\x1b[2m$ ${req.command}\x1b[0m\r\n` + run(info.id, req.command) + '\r\n\x1b[2m[process exited]\x1b[0m\r\n')
      t.info.exited = true
      t.info.exitCode = 0
      changed()
      emit('terminal:focus', { id: info.id })
    }
  }
}
