// Blink (github.com/1Axen/blink) support: a tolerant parser for events.blink and its imports,
// a check that runs the real compiler into a throwaway folder, and parsing of Blink's error output.
//
// The parser itself is in shared/blinkParser.ts (grammar notes there).
//
// Nothing here imports Electron, so it runs under node --test.

import { watch, type FSWatcher } from 'node:fs'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { BlinkDiagnostic, BlinkEvent, BlinkModel, BlinkTypeDecl, LogLine } from '@shared/types'
import { findTool, run } from './tools.ts'
import { appendDeclaration, BLINK_ENTRY, formatDeclaration, parseBlink, type BlinkEventSpec } from '../../shared/blinkParser.ts'

export { appendDeclaration, BLINK_ENTRY, formatDeclaration, importScopeName, parseBlink, tokenize } from '../../shared/blinkParser.ts'
export type { BlinkEventSpec, BlinkImport, ParsedBlinkFile } from '../../shared/blinkParser.ts'

// ---------------------------------------------------------------- model (entry + imports)

export interface BlinkFs {
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
}

const nodeFs: BlinkFs = {
  readFile: (path) => readFile(path, 'utf8'),
  exists: async (path) => !!(await stat(path).catch(() => null))?.isFile()
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

// Blink tries the path as written, then with .txt, then with .blink (GetDefinitionFilePath.luau).
async function resolveImport(fs: BlinkFs, fromDir: string, path: string): Promise<string | null> {
  const base = isAbsolute(path) ? path : join(fromDir, path)
  for (const ext of ['', '.txt', '.blink']) {
    if (await fs.exists(base + ext)) return base + ext
  }
  return null
}

export interface LoadedBlink {
  model: BlinkModel
  // Absolute paths of every file read (entry first).
  files: string[]
  // Import path as written -> repo-relative file, for mapping Blink's error labels.
  importLabels: Record<string, string>
}

// Rojo instance path for a repo file, from default.project.json ($path mappings).
export function instancePathFor(projectTree: Record<string, unknown> | undefined, file: string): string[] | null {
  if (!projectTree) return null
  let best: { parts: string[]; path: string } | null = null
  const walk = (node: Record<string, unknown>, parts: string[]) => {
    const p = node.$path
    const path = typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as { optional?: unknown }).optional === 'string' ? String((p as { optional: string }).optional) : null
    if (path) {
      const norm = posix.normalize(toPosix(path)).replace(/\/$/, '')
      if ((file === norm || file.startsWith(norm + '/')) && (!best || norm.length > best.path.length)) best = { parts, path: norm }
    }
    for (const [key, value] of Object.entries(node)) {
      if (!key.startsWith('$') && value && typeof value === 'object' && !Array.isArray(value)) walk(value as Record<string, unknown>, [...parts, key])
    }
  }
  walk(projectTree, [])
  if (!best) return null
  const found = best as { parts: string[]; path: string }
  const rest = file.slice(found.path.length).split('/').filter(Boolean)
  const last = rest.pop()
  if (last !== undefined) {
    const name = last.replace(/(\.server|\.client)?\.(luau|lua)$/, '')
    if (name !== 'init') rest.push(name)
  }
  return [...found.parts, ...rest]
}

// "ReplicatedStorage.Shared.events.client" for a dotted require path (identifiers only).
export function requireExpression(instancePath: string[]): string {
  return instancePath.map((part, k) => (k === 0 || /^[A-Za-z_]\w*$/.test(part) ? (k === 0 ? part : `.${part}`) : `["${part}"]`)).join('')
}

export async function loadBlinkModel(root: string, entry = BLINK_ENTRY, fs: BlinkFs = nodeFs): Promise<LoadedBlink> {
  const entryAbs = resolve(root, entry)
  const model: BlinkModel = { file: null, events: [], types: [], options: {}, diagnostics: [], imports: [] }
  const loaded: LoadedBlink = { model, files: [], importLabels: {} }
  if (!(await fs.exists(entryAbs))) return loaded
  model.file = toPosix(relative(root, entryAbs))

  const seen = new Set<string>()
  const visit = async (abs: string, scope: string[]) => {
    if (seen.has(abs)) return
    seen.add(abs)
    loaded.files.push(abs)
    const rel = toPosix(relative(root, abs))
    let source = ''
    try {
      source = await fs.readFile(abs)
    } catch {
      return
    }
    const parsed = parseBlink(source, rel, scope)
    if (abs === entryAbs) {
      model.options = parsed.options
      model.optionLines = parsed.optionLines
    }
    model.events.push(...parsed.events)
    model.types.push(...parsed.types)
    for (const imp of parsed.imports) {
      const target = await resolveImport(fs, dirname(abs), imp.path)
      const relTarget = target ? toPosix(relative(root, target)) : undefined
      model.imports!.push({ path: imp.path, scope: [...imp.scope, imp.scopeName], file: relTarget, from: rel, line: imp.line })
      if (target && relTarget) {
        loaded.importLabels[imp.path] = relTarget
        await visit(target, [...imp.scope, imp.scopeName])
      }
    }
  }
  await visit(entryAbs, [])

  const str = (key: string) => (typeof model.options[key] === 'string' ? (model.options[key] as string) : undefined)
  const outputs: NonNullable<BlinkModel['outputs']> = {}
  const entryDir = dirname(entryAbs)
  const outPath = (value: string | undefined) => {
    if (!value) return undefined
    // Blink appends .luau to the file name it is given (Compile.luau: `{Directory}/{Filename}.luau`).
    const withExt = /\.luau$/.test(value) ? value : `${value.replace(/\.lua$/, '')}.luau`
    const abs = isAbsolute(withExt) ? withExt : resolve(entryDir, withExt)
    return toPosix(relative(root, abs))
  }
  outputs.client = outPath(str('ClientOutput'))
  outputs.server = outPath(str('ServerOutput'))
  const typesOut = str('TypesOutput')
  if (typesOut) outputs.types = toPosix(relative(root, isAbsolute(typesOut) ? typesOut : resolve(entryDir, typesOut)))
  model.outputs = outputs

  // Require paths, from the Rojo project mapping: default.project.json, then the other places
  // (a menu place's events live only in menu.project.json).
  const projectFiles = ['default.project.json', ...(await rootFiles(root, /\.project\.json$/)).filter((f) => f !== 'default.project.json')]
  const trees: (Record<string, unknown> | undefined)[] = []
  for (const file of projectFiles) {
    try {
      trees.push((JSON.parse(await fs.readFile(join(root, file))) as { tree?: Record<string, unknown> }).tree)
    } catch {
      // missing or unreadable project file
    }
  }
  if (trees.length) {
    const requires: NonNullable<BlinkModel['requirePaths']> = {}
    for (const side of ['client', 'server'] as const) {
      const file = outputs[side]
      if (!file) continue
      for (const tree of trees) {
        const path = instancePathFor(tree, file)
        if (path && path.length) {
          requires[side] = requireExpression(path)
          break
        }
      }
    }
    model.requirePaths = requires
  }
  return loaded
}

async function rootFiles(root: string, pattern: RegExp): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

// Root-level *.blink files, each its own Blink entry (events.blink first). Imported files live
// in subfolders or are named by an entry; a root file imported by another entry is not an entry.
export async function discoverBlinkFiles(root: string): Promise<string[]> {
  const files = await rootFiles(root, /\.blink$/)
  return files.sort((a, b) => (a === BLINK_ENTRY ? -1 : b === BLINK_ENTRY ? 1 : a.localeCompare(b)))
}

// Every root entry loaded, each with its own model, check context and output paths.
export async function loadBlinkModels(root: string, fs: BlinkFs = nodeFs): Promise<LoadedBlink[]> {
  const entries = await discoverBlinkFiles(root)
  const loaded: LoadedBlink[] = []
  for (const entry of entries) loaded.push(await loadBlinkModel(root, entry, fs))
  // Drop entries that another entry imports (they are part of that model).
  const imported = new Set(loaded.flatMap((l) => l.files.slice(1).map((f) => toPosix(relative(root, f)))))
  return loaded.filter((l) => !imported.has(l.model.file ?? ''))
}

// Generated-API usage lives in shared/ so the renderer can use it too.
export { blinkUsage, dataValues, type BlinkUsage } from '../../shared/blinkUsage.ts'

// ---------------------------------------------------------------- error output

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const RED = '\x1b[31m'

export interface ErrorContext {
  // Repo-relative path of the entry file (Blink labels it by its file name).
  entry: string
  // Import path as written -> repo-relative file.
  importLabels?: Record<string, string>
}

function mapFile(label: string, ctx: ErrorContext): string {
  const entryName = ctx.entry.split('/').pop()
  if (label === entryName || label === ctx.entry || label === 'input.blink') return ctx.entry
  if (ctx.importLabels?.[label]) return ctx.importLabels[label]
  for (const [raw, file] of Object.entries(ctx.importLabels ?? {})) {
    if (raw.replace(/^\.\//, '') === label.replace(/^\.\//, '')) return file
  }
  return label.replace(/^\.\//, '')
}

// Parses what `blink <file>` writes on failure. Handles the full report
//   [E2003] Error: Unknown option "Reliabl"
//       ╭─[bad.blink:1:9]          <- note: Blink prints 1:<line count> here, not a position
//   005 │     Type: Reliabl,
//       ┆           ───┬───
//       ┆              ╰── Expected one of "Reliable" or "Unreliable"
// the --compact form `[E2003] [L005:L005] [bad.blink] Error: ...`, and uncaught Lune errors
// (`[string "STANDALONE"]:4027: Cannot use yield type...`) from the generator.
export function parseBlinkErrors(output: string, ctx: ErrorContext): BlinkDiagnostic[] {
  const diagnostics: BlinkDiagnostic[] = []
  const rawLines = output.split(/\r?\n/)
  const plain = rawLines.map((l) => l.replace(ANSI, ''))

  for (let k = 0; k < plain.length; k++) {
    const compact = /^\[E(\d{4})\] \[L(\d+):L(\d+)\] \[([^\]]*)\] Error: (.*)$/.exec(plain[k])
    if (compact) {
      diagnostics.push({
        file: mapFile(compact[4], ctx),
        line: Number(compact[2]),
        column: 1,
        endLine: Number(compact[3]),
        message: compact[5].trim(),
        code: `E${compact[1]}`,
        severity: 'error'
      })
      continue
    }
    const head = /^\[E(\d{4})\] Error: (.*)$/.exec(plain[k].trim())
    if (!head) continue
    const code = `E${head[1]}`
    const message = head[2].trim()
    let file = ctx.entry
    interface Label { line: number; firstLine: number; column: number; length: number; text: string; primary: boolean }
    const labels: Label[] = []
    let sliceLines: number[] = []
    let j = k + 1
    for (; j < plain.length; j++) {
      const p = plain[j]
      if (/^\[E\d{4}\]/.test(p.trim())) break
      const loc = /╭─\[(.*):\d+:\d+\]\s*$/.exec(p)
      if (loc) {
        file = mapFile(loc[1], ctx)
        continue
      }
      const src = /^(\d{3,})\s│\s?/.exec(p)
      if (src) {
        sliceLines.push(Number(src[1]))
        continue
      }
      // Underline row: "    ┆ <spaces>───┬───"
      const under = /^ {4}┆ ( *)([─┬]+)\s*$/.exec(p)
      if (under && sliceLines.length) {
        const label: Label = {
          line: sliceLines[sliceLines.length - 1],
          firstLine: sliceLines[0],
          column: sliceLines.length > 1 ? 1 : under[1].length + 1,
          length: under[2].length,
          text: '',
          primary: rawLines[j].includes(RED)
        }
        labels.push(label)
        continue
      }
      const text = /^ {4}┆ *╰── ?(.*)$/.exec(p)
      if (text && labels.length) {
        labels[labels.length - 1].text = text[1].trim()
        sliceLines = []
        continue
      }
      if (/^─+╯/.test(p)) {
        j++
        break
      }
    }
    const primary = labels.filter((l) => l.primary).pop() ?? labels[labels.length - 1]
    const diag: BlinkDiagnostic = { file, line: primary?.firstLine ?? 1, column: primary?.column ?? 1, message, code, severity: 'error' }
    if (primary) {
      if (primary.line !== primary.firstLine) diag.endLine = primary.line
      else diag.endColumn = primary.column + Math.max(1, primary.length)
      if (primary.text && primary.text !== message) diag.detail = primary.text
    }
    const related = labels.filter((l) => l !== primary && l.text)
    if (related.length) diag.related = related.map((l) => ({ file, line: l.firstLine, column: l.column, message: l.text }))
    diagnostics.push(diag)
    k = j - 1
  }

  if (diagnostics.length) return diagnostics
  // Uncaught errors (generator, missing output option, I/O): no position, attach to line 1 of the entry.
  const lune = plain.map((l) => /^\[string "[^"]*"\]:\d+: (.*)$/.exec(l.trim())).find(Boolean)
  if (lune) return [{ file: ctx.entry, line: 1, column: 1, message: lune[1].trim(), severity: 'error' }]
  const text = plain.map((l) => l.trim()).filter((l) => l && !/^\[Stack (Begin|End)\]$/.test(l) && !/^Script '/.test(l))
  if (text.length) return [{ file: ctx.entry, line: 1, column: 1, message: text[0], severity: 'error' }]
  return []
}

// ---------------------------------------------------------------- check (real compiler, temp output)

export interface CheckResult {
  ok: boolean
  diagnostics: BlinkDiagnostic[]
  // Missing binary or no entry file: the check did not run.
  skipped?: string
  version?: string
  output?: string
}

// Same resolution as the supervisor: PATH plus the rokit bin folder (~/.rokit/bin).
export function findBlink(): string | null {
  return findTool('blink')
}

export interface CheckOptions {
  entry?: string
  binary?: string | null
  fs?: BlinkFs
  runner?: typeof run
  timeoutMs?: number
}

// Compiles a copy of the entry file and its imports so nothing in the project is written.
// Output options are rewritten to absolute paths inside the temp folder; the copy keeps every
// line where it was, so Blink's line numbers still point at the real files.
export async function checkBlink(root: string, options: CheckOptions = {}): Promise<CheckResult> {
  const entry = options.entry ?? BLINK_ENTRY
  const fs = options.fs ?? nodeFs
  const runner = options.runner ?? run
  const binary = options.binary === undefined ? findBlink() : options.binary
  if (!binary) return { ok: true, diagnostics: [], skipped: 'blink not found. Run rokit install.' }
  const loaded = await loadBlinkModel(root, entry, fs)
  if (!loaded.model.file) return { ok: true, diagnostics: [], skipped: `No ${entry}` }

  const temp = await mkdtemp(join(tmpdir(), 'forge-blink-'))
  try {
    // Mirror the files under a common base so relative imports (including ../) still resolve.
    const dirs = loaded.files.map((f) => dirname(f))
    let base = dirs[0]
    for (const d of dirs) while (relative(base, d).startsWith('..')) base = dirname(base)
    const mirror = join(temp, 'src')
    const outDir = toPosix(join(temp, 'out'))
    for (const file of loaded.files) {
      const target = join(mirror, relative(base, file))
      await mkdir(dirname(target), { recursive: true })
      let source = await fs.readFile(file)
      if (file === loaded.files[0]) {
        source = source.replace(/^(\s*option\s+(ClientOutput|ServerOutput|TypesOutput)\s*=\s*)(["'])([^"'\n]*)\3/gm, (_m, lead: string, name: string, q: string) => `${lead}${q}${outDir}/${name}${name === 'TypesOutput' ? '.luau' : ''}${q}`)
      }
      await writeFile(target, source, 'utf8')
    }
    const mainCopy = toPosix(join(mirror, relative(base, loaded.files[0])))
    // cwd stays the project root so rokit's shim picks the version pinned in rokit.toml.
    const result = await runner(binary, [mainCopy, '--yes'], root)
    const output = `${result.stderr}\n${result.stdout}`
    const version = /Blink\S*\s+(\d+\.\d+\.\d+\S*)/.exec(output.replace(ANSI, ''))?.[1]
    if (result.code === 0 && !/\[E\d{4}\]/.test(output)) return { ok: true, diagnostics: [], version, output }
    const ctx: ErrorContext = { entry: loaded.model.file, importLabels: loaded.importLabels }
    let diagnostics = parseBlinkErrors(result.stderr, ctx)
    if (!diagnostics.length) diagnostics = parseBlinkErrors(output, ctx)
    if (!diagnostics.length) diagnostics = [{ file: loaded.model.file, line: 1, column: 1, message: `blink exited with code ${result.code}`, severity: 'error' }]
    return { ok: false, diagnostics, version, output }
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------------------------------------------------------------- AI tool helpers

// Compact list for tools/LLMs: one line per event/function.
// Without an entry: the events of every root *.blink file (each event names its file).
export async function listEvents(root: string, entry?: string): Promise<BlinkEvent[]> {
  if (entry) return (await loadBlinkModel(root, entry)).model.events
  const all = await loadBlinkModels(root)
  if (!all.length) return (await loadBlinkModel(root, BLINK_ENTRY)).model.events
  return all.flatMap((l) => l.model.events)
}

export function describeEvent(ev: BlinkEvent): string {
  const name = [...ev.scope, ev.name].join('.')
  if (ev.kind === 'function') return `function ${name}: Yield ${ev.yield ?? '?'}, Data ${ev.data ?? '-'}, Return ${ev.return ?? '-'} (${ev.file}:${ev.line})`
  const dir = ev.from === 'Client' ? 'Client->Server' : 'Server->Client'
  return `event ${name}: ${dir}, ${ev.type ?? '?'}, ${ev.call ?? '?'}${ev.poll ? ', Poll' : ''}, Data ${ev.data ?? '-'} (${ev.file}:${ev.line})`
}

// Appends a declaration to events.blink, then compiles a copy. The file is written even when the
// check fails so the caller can show the diagnostics; it is restored if `revertOnError` is set.
export async function addEvent(
  root: string,
  spec: BlinkEventSpec,
  options: { entry?: string; revertOnError?: boolean; check?: typeof checkBlink } = {}
): Promise<{ declaration: string; check: CheckResult }> {
  const entry = options.entry ?? BLINK_ENTRY
  const path = resolve(root, entry)
  const before = await readFile(path, 'utf8').catch(() => '')
  const after = appendDeclaration(before, spec)
  await writeFile(path, after, 'utf8')
  const check = await (options.check ?? checkBlink)(root, { entry })
  if (!check.ok && options.revertOnError) await writeFile(path, before, 'utf8')
  return { declaration: formatDeclaration(spec).trim(), check }
}

// ---------------------------------------------------------------- generate (real outputs)

export interface GenerateResult {
  ok: boolean
  skipped?: string
  output?: string
}

// Compiles an entry in place, so Blink writes its configured ClientOutput/ServerOutput/TypesOutput.
// The GenTree dev loop only does this for events.blink; other root *.blink files (menu.blink...)
// are generated by Forge through this. Run only after checkBlink passed (a failed compile writes
// nothing, but the check gives better diagnostics).
export async function generateBlink(root: string, entry: string, options: { binary?: string | null; runner?: typeof run } = {}): Promise<GenerateResult> {
  const binary = options.binary === undefined ? findBlink() : options.binary
  if (!binary) return { ok: false, skipped: 'blink not found. Run rokit install.' }
  const result = await (options.runner ?? run)(binary, [entry, '--yes'], root)
  const output = `${result.stderr}\n${result.stdout}`.trim()
  return { ok: result.code === 0 && !/\[E\d{4}\]/.test(output), output }
}

// ---------------------------------------------------------------- live service

export interface BlinkWatcherOptions {
  root: string
  // One fixed entry. Without it every root *.blink file is an entry (events.blink first), and new
  // ones are picked up as they appear.
  entry?: string
  log: (line: Omit<LogLine, 'at'>) => void
  onChange: (model: BlinkModel) => void
  debounceMs?: number
  // For tests.
  check?: typeof checkBlink
  // Entries Forge should compile to their real outputs after a passing check (the dev loop only
  // generates events.blink). Default: none.
  generate?: (entry: string) => boolean
  // For tests.
  generator?: typeof generateBlink
}

// Keeps a parsed model of each Blink entry (and its imports), re-checks with the real compiler on
// change. `model` is the primary entry (events.blink when there is one) with every entry's model
// in `model.files`.
export class BlinkWatcher {
  private options: BlinkWatcherOptions
  private watchers = new Map<string, FSWatcher>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  private closed = false
  private lastReport = new Map<string, string>()
  private fileModels: BlinkModel[] = []
  model: BlinkModel = { file: null, events: [], types: [], options: {}, diagnostics: [] }

  constructor(options: BlinkWatcherOptions) {
    this.options = options
  }

  async start(): Promise<BlinkModel> {
    await this.refresh()
    return this.model
  }

  schedule(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, this.options.debounceMs ?? 400)
  }

  async refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.once()
      } while (this.again && !this.closed)
    })()
    try {
      await this.running
    } finally {
      this.running = null
    }
  }

  private async entries(): Promise<string[]> {
    if (this.options.entry) return [this.options.entry]
    const found = await discoverBlinkFiles(this.options.root)
    return found.length ? found : [BLINK_ENTRY]
  }

  private publish(): void {
    const files = this.fileModels
    const primary = files.find((m) => m.file === BLINK_ENTRY) ?? files.find((m) => m.file) ?? files[0]
    const base: BlinkModel = primary ?? { file: null, events: [], types: [], options: {}, diagnostics: [] }
    this.model = { ...base, files: files.filter((m) => m.file) }
    this.options.onChange(this.model)
  }

  private async once(): Promise<void> {
    const { root } = this.options
    let entries = await this.entries()
    const all = await Promise.all(entries.map((entry) => loadBlinkModel(root, entry).catch(() => null)))
    if (this.closed) return
    // An entry another entry imports is part of that model, not its own.
    const imported = new Set(all.flatMap((l) => (l ? l.files.slice(1).map((f) => toPosix(relative(root, f))) : [])))
    const keep = entries.map((entry, k) => ({ entry, loaded: all[k] })).filter(({ loaded }) => !imported.has(loaded?.model.file ?? ''))
    entries = keep.map((k) => k.entry)
    this.watchFiles([...entries.map((entry) => resolve(root, entry)), ...keep.flatMap((k) => k.loaded?.files ?? [])])
    if (keep.every((k) => !k.loaded)) return
    // Publish the parse right away; diagnostics follow from the compiler.
    const previous = new Map(this.fileModels.map((m) => [m.file, m]))
    this.fileModels = keep.map(({ loaded }) => {
      const model = loaded?.model ?? { file: null, events: [], types: [], options: {}, diagnostics: [] }
      const before = previous.get(model.file)
      return { ...model, diagnostics: before?.diagnostics ?? [], checking: Boolean(model.file), checker: before?.checker }
    })
    this.publish()
    for (const key of [...this.lastReport.keys()]) if (!entries.includes(key)) this.lastReport.delete(key)
    for (let k = 0; k < keep.length; k++) {
      const { entry, loaded } = keep[k]
      if (!loaded?.model.file) continue
      const result = await (this.options.check ?? checkBlink)(root, { entry }).catch(
        (error): CheckResult => ({ ok: false, diagnostics: [{ file: entry, line: 1, column: 1, message: String(error), severity: 'error' }] })
      )
      if (this.closed) return
      this.fileModels[k] = {
        ...this.fileModels[k],
        diagnostics: result.diagnostics,
        checking: false,
        checkedAt: Date.now(),
        checker: result.skipped ? 'missing' : 'blink',
        checkerDetail: result.skipped ?? (result.version ? `blink ${result.version}` : 'blink'),
        blinkVersion: result.version
      }
      this.publish()
      this.report(entry, this.fileModels[k], result)
      if (result.ok && !result.skipped && this.options.generate?.(entry)) {
        const gen = await (this.options.generator ?? generateBlink)(root, entry).catch((error): GenerateResult => ({ ok: false, output: String(error) }))
        if (this.closed) return
        this.options.log(
          gen.ok
            ? { service: 'dev', stream: 'info', text: `[blink] generated outputs of ${entry}` }
            : { service: 'dev', stream: 'stderr', text: `[blink] generating ${entry} failed: ${gen.skipped ?? gen.output ?? 'unknown error'}` }
        )
      }
    }
  }

  private report(entry: string, model: BlinkModel, result: CheckResult): void {
    const key = result.skipped ? `skip:${result.skipped}` : JSON.stringify(result.diagnostics)
    if (key === this.lastReport.get(entry)) return
    this.lastReport.set(entry, key)
    if (result.skipped) {
      // The same reason (missing binary) for every entry: say it once.
      if ([...this.lastReport.entries()].some(([other, value]) => other !== entry && value === key)) return
      this.options.log({ service: 'dev', stream: 'info', text: `[blink] check skipped: ${result.skipped}` })
    } else if (result.ok) {
      const n = model.events.length
      this.options.log({ service: 'dev', stream: 'info', text: `[blink] ${entry} OK (${n} event${n === 1 ? '' : 's'}/function${n === 1 ? '' : 's'})` })
    } else {
      for (const d of result.diagnostics) {
        this.options.log({
          service: 'dev',
          stream: 'stderr',
          text: `[blink] ${d.file}:${d.line}:${d.column}: ${d.code ? `${d.code} ` : ''}${d.message}${d.detail ? ` (${d.detail})` : ''}`
        })
      }
    }
  }

  // Watches the folders of each entry and every import, filtered to those files. Without a fixed
  // entry the root folder also reacts to any *.blink file (a new entry).
  private watchFiles(files: string[]): void {
    const root = resolve(this.options.root)
    const byDir = new Map<string, Set<string>>()
    if (!this.options.entry) byDir.set(root, new Set())
    for (const file of files) {
      const dir = dirname(file)
      if (!byDir.has(dir)) byDir.set(dir, new Set())
      byDir.get(dir)!.add(file.slice(dir.length + 1))
    }
    for (const [dir, watcher] of this.watchers) {
      if (!byDir.has(dir)) {
        watcher.close()
        this.watchers.delete(dir)
      }
    }
    this.names = byDir
    for (const dir of byDir.keys()) {
      if (this.watchers.has(dir)) continue
      try {
        const watcher = watch(dir, (_event, name) => {
          const names = this.names.get(dir)
          const file = name ? String(name) : ''
          if (!file || names?.has(file) || (!this.options.entry && dir === root && file.endsWith('.blink'))) this.schedule()
        })
        watcher.on('error', () => {
          watcher.close()
          this.watchers.delete(dir)
        })
        this.watchers.set(dir, watcher)
      } catch {
        // folder missing; picked up on the next refresh
      }
    }
  }

  private names = new Map<string, Set<string>>()

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }
}
