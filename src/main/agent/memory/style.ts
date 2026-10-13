// Luau style profile: reads the project's own Luau (not Packages/ or Blink output) and extracts the
// habits a code-writing agent should copy: indentation, naming, module patterns, comment habits and
// Vide UI idioms. Saved as the project memory "luau-style-profile". Pure function; no electron.

import type { StyleProfile } from './types.ts'

export const STYLE_MEMORY_NAME = 'luau-style-profile'
export const STYLE_FILE_LIMIT = 400

export interface SourceFile {
  path: string
  text: string
}

// Generated or vendored Luau that says nothing about the team's style.
export function isStyleSource(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  if (!/\.(luau|lua)$/.test(p)) return false
  if (/(^|\/)(Packages|ServerPackages|DevPackages|node_modules|\.forge)\//.test(p)) return false
  if (/(^|\/)src\/(shared|server|client)\/events\//.test(p)) return false
  return true
}

type Case = 'camelCase' | 'PascalCase' | 'snake_case' | 'UPPER_SNAKE' | 'lower'

function caseOf(name: string): Case | null {
  if (name.length < 2 || name === '_') return null
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name) || /^[A-Z]{2,}[0-9]*$/.test(name)) return 'UPPER_SNAKE'
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake_case'
  if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) return 'PascalCase'
  if (/^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/.test(name)) return 'camelCase'
  if (/^[a-z][a-z0-9]*$/.test(name)) return 'lower'
  return null
}

class Tally {
  private m = new Map<string, number>()
  add(k: string | null, n = 1): void {
    if (k) this.m.set(k, (this.m.get(k) ?? 0) + n)
  }
  get(k: string): number {
    return this.m.get(k) ?? 0
  }
  total(): number {
    let t = 0
    for (const v of this.m.values()) t += v
    return t
  }
  // Dominant value, folding 'lower' into whichever multi-word case wins (single words fit both).
  top(): string {
    const entries = [...this.m.entries()].filter(([k]) => k !== 'lower').sort((a, b) => b[1] - a[1])
    if (!entries.length) return this.get('lower') ? 'lowercase' : 'unknown'
    const [k, v] = entries[0]
    const share = v / (this.total() - this.get('lower') || 1)
    return share >= 0.8 ? k : `mostly ${k} (${Math.round(share * 100)}%)`
  }
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : '0%'
}

export function analyzeLuauStyle(input: SourceFile[]): StyleProfile {
  const files = input.filter((f) => isStyleSource(f.path)).slice(0, STYLE_FILE_LIMIT)
  let lines = 0
  let tabLines = 0
  let spaceLines = 0
  const spaceWidths = new Map<number, number>()
  let strict = 0
  const locals = new Tally()
  const fns = new Tally()
  const consts = new Tally()
  const mods = new Tally()
  let tableModules = 0
  let returnFunction = 0
  let metatableClasses = 0
  let lifecycle = 0
  let requireScript = 0
  let requirePath = 0
  let getService = 0
  let exportTypes = 0
  let typedParams = 0
  let fnCount = 0
  let trailingCommaHits = 0
  let tableCloses = 0
  let lineComments = 0
  let trailingComments = 0
  let blockComments = 0
  let docComments = 0
  let filesWithHeader = 0
  let selfMethods = 0
  let dotFns = 0
  // Vide
  let videFiles = 0
  let videAlias = new Tally()
  let createCurried = 0
  let createSugar = 0
  let createLocal = 0
  const videApis = new Tally()
  let componentProps = 0

  for (const f of files) {
    const text = f.text.replace(/\r\n/g, '\n')
    const ls = text.split('\n')
    lines += ls.length
    const firstCode = ls.find((l) => l.trim())?.trim() ?? ''
    if (/^--!strict/.test(firstCode)) strict++
    if (/^--(?!!)/.test(firstCode) || /^--\[\[/.test(firstCode)) filesWithHeader++
    let prevTrim = ''
    for (const l of ls) {
      const m = /^([\t ]+)\S/.exec(l)
      if (m) {
        if (m[1].startsWith('\t')) tabLines++
        else {
          spaceLines++
          spaceWidths.set(m[1].length, (spaceWidths.get(m[1].length) ?? 0) + 1)
        }
      }
      const t = l.trim()
      if (/^---(?!-)/.test(t)) docComments++
      else if (/^--\[=*\[/.test(t)) blockComments++
      else if (/^--(?!!)/.test(t)) lineComments++
      else if (/\S.*\s--\s/.test(l) && !/["'].*--.*["']/.test(l)) trailingComments++
      if (/^[}\)]/.test(t) && prevTrim && !/[{(,]$/.test(prevTrim) && !prevTrim.startsWith('--')) {
        tableCloses++
      } else if (/^[}\)]/.test(t) && prevTrim.endsWith(',')) {
        tableCloses++
        trailingCommaHits++
      }
      if (t) prevTrim = t
    }

    for (const m of text.matchAll(/^([ \t]*)local\s+([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*(.*)$/gm)) {
      const [, indent, name, rhs] = m
      if (/^game:GetService\(/.test(rhs)) {
        getService++
        mods.add(caseOf(name))
        continue
      }
      if (/^require\(/.test(rhs)) {
        mods.add(caseOf(name))
        if (/^require\(script/.test(rhs)) requireScript++
        else requirePath++
        continue
      }
      if (!indent && /^\{\s*\}$/.test(rhs.trim())) {
        tableModules += new RegExp(`^return\\s+${name}\\s*$`, 'm').test(text) ? 1 : 0
        mods.add(caseOf(name))
        continue
      }
      const c = caseOf(name)
      if (!indent && c === 'UPPER_SNAKE') consts.add(c)
      else if (!indent && /^(\d|["'{]|true|false)/.test(rhs) && c) consts.add(c)
      else locals.add(c)
    }
    for (const m of text.matchAll(/^[ \t]*local\s+function\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) {
      fns.add(caseOf(m[1]))
      fnCount++
      if (/:\s*\w/.test(m[2])) typedParams++
      if (/^props\b|^\s*props\s*:/.test(m[2].trim())) componentProps++
    }
    for (const m of text.matchAll(/^[ \t]*function\s+[A-Za-z_]\w*([.:])([A-Za-z_]\w*)\s*\(([^)]*)\)/gm)) {
      fns.add(caseOf(m[2]))
      fnCount++
      if (m[1] === ':') selfMethods++
      else dotFns++
      if (/:\s*\w/.test(m[3])) typedParams++
    }
    if (/^return\s+function\b/m.test(text)) returnFunction++
    if (/\.__index\s*=\s*\w+/.test(text) && /setmetatable\(/.test(text)) metatableClasses++
    if (/function\s+\w+[:.]Init\s*\(/.test(text) || /function\s+\w+[:.]Start\s*\(/.test(text)) lifecycle++
    if (/^export\s+type\s+/m.test(text)) exportTypes++

    const vide = /local\s+(\w+)\s*=\s*require\([^)]*\bVide\b[^)]*\)/i.exec(text)
    if (vide) {
      videFiles++
      const alias = vide[1]
      videAlias.add(alias)
      if (new RegExp(`local\\s+create\\s*=\\s*${alias}\\.create`).test(text)) createLocal++
      createCurried += (text.match(/\bcreate\s*\(\s*["'][A-Za-z]+["']\s*\)\s*\(?\s*\{/g) ?? []).length
      createSugar += (text.match(/\bcreate\s*["'][A-Za-z]+["']\s*\{/g) ?? []).length
      for (const api of ['source', 'derive', 'effect', 'cleanup', 'show', 'switch', 'indexes', 'values', 'mount', 'spring', 'action', 'changed', 'untrack', 'batch', 'root']) {
        const re = new RegExp(`(?:\\b${alias}\\.${api}\\b|^local\\s+${api}\\s*=\\s*${alias}\\.${api}\\b)`, 'gm')
        const n = (text.match(re) ?? []).length
        if (n) videApis.add(api, n)
      }
    }
  }

  const indentLines = tabLines + spaceLines
  let indent: StyleProfile['indent'] = { style: 'unknown' }
  if (indentLines) {
    if (tabLines / indentLines >= 0.9) indent = { style: 'tabs' }
    else if (spaceLines / indentLines >= 0.9) {
      const width = [2, 4, 3, 8].find((w) => [...spaceWidths.entries()].every(([n, c]) => n % w === 0 || c < spaceLines * 0.05)) ?? 4
      indent = { style: 'spaces', width }
    } else indent = { style: 'mixed' }
  }
  const strictMode = files.length ? strict / files.length : 0
  const naming = { locals: locals.top(), functions: fns.top(), constants: consts.total() ? consts.top() : 'none seen', modules: mods.top() }

  const modules: string[] = []
  if (tableModules) modules.push(`Table modules: \`local X = {}\` … \`return X\` (${tableModules} file${tableModules === 1 ? '' : 's'}).`)
  if (lifecycle) modules.push(`GenTree lifecycle: Services/Controllers define \`:Init(janitor)\` and \`:Start()\` (${lifecycle} file${lifecycle === 1 ? '' : 's'}).`)
  if (selfMethods || dotFns) modules.push(`Module functions use ${selfMethods >= dotFns ? '`function M:Method()` (colon, self)' : '`function M.fn()` (dot)'} (${selfMethods} colon / ${dotFns} dot).`)
  if (returnFunction) modules.push(`Some modules return a single function (${returnFunction}).`)
  if (metatableClasses) modules.push(`Classes use \`X.__index = X\` + setmetatable (${metatableClasses}).`)
  if (getService) modules.push('Services are fetched once at the top with `local X = game:GetService("X")`.')
  if (requirePath || requireScript) modules.push(`Requires are ${requirePath >= requireScript ? 'absolute from services (`require(ReplicatedStorage.Packages.X)`)' : 'relative (`require(script.Parent.X)`)'} (${requirePath} absolute / ${requireScript} relative).`)
  if (exportTypes || typedParams) modules.push(`Types: ${exportTypes} file(s) with \`export type\`; ${pct(typedParams, fnCount)} of functions annotate parameters.`)
  if (tableCloses >= 5) modules.push(`Multi-line tables ${trailingCommaHits / tableCloses >= 0.6 ? 'keep a trailing comma on the last field' : 'usually omit the trailing comma'}.`)

  const comments: string[] = []
  const commentTotal = lineComments + blockComments + docComments + trailingComments
  if (!commentTotal) comments.push('Code is almost uncommented; keep comments rare.')
  else {
    comments.push(`About ${lines ? Math.max(1, Math.round((commentTotal / lines) * 1000) / 10) : 0}% of lines are comments.`)
    const kinds: [number, string][] = [
      [lineComments, '`--` line comments on their own line'],
      [trailingComments, 'trailing `--` comments'],
      [blockComments, '`--[[ ]]` block comments (often commented-out code)'],
      [docComments, '`---` doc comments']
    ]
    kinds.sort((a, b) => b[0] - a[0])
    comments.push(`Mostly ${kinds[0][1]}${kinds[1][0] ? `, then ${kinds[1][1]}` : ''}.`)
  }
  if (filesWithHeader / (files.length || 1) >= 0.5) comments.push('Files usually start with a header comment.')

  const vide: string[] = []
  if (videFiles) {
    vide.push(`Vide is required as \`${videAlias.top()}\` (${videFiles} file${videFiles === 1 ? '' : 's'}).`)
    if (createLocal) vide.push('`local create = Vide.create` is hoisted at the top of UI files.')
    if (createCurried || createSugar) vide.push(createCurried >= createSugar ? 'Instances are built as `create("Frame")({ ... })` (parenthesised calls).' : 'Instances are built as `create "Frame" { ... }` (call sugar).')
    const apis = ['source', 'derive', 'effect', 'cleanup', 'show', 'switch', 'indexes', 'values', 'mount', 'spring', 'action'].filter((a) => videApis.get(a))
    if (apis.length) vide.push(`Vide APIs in use: ${apis.map((a) => `${a} (${videApis.get(a)})`).join(', ')}.`)
    if (componentProps) vide.push('Components are `local function Name(props)` returning a create(...) tree.')
  }

  const indentText = indent.style === 'tabs' ? 'tabs' : indent.style === 'spaces' ? `${indent.width} spaces` : indent.style
  const body = [
    `Observed in ${files.length} Luau files (${lines} lines) of this project. Follow it when writing or editing Luau here; the existing code wins over these notes if they disagree.`,
    '',
    '## Formatting',
    `- Indentation: ${indentText}.`,
    `- \`--!strict\`: ${pct(strict, files.length)} of files${strictMode >= 0.6 ? ' (add it to new files)' : strictMode > 0 ? '' : ' (not used)'}.`,
    '',
    '## Naming',
    `- Locals: ${naming.locals}. Functions/methods: ${naming.functions}. Constants: ${naming.constants}. Modules/services: ${naming.modules}.`,
    '',
    '## Modules',
    ...(modules.length ? modules.map((m) => `- ${m}`) : ['- No dominant module pattern.']),
    '',
    '## Comments',
    ...comments.map((c) => `- ${c}`),
    ...(vide.length ? ['', '## Vide UI', ...vide.map((v) => `- ${v}`)] : [])
  ].join('\n')

  return { files: files.length, lines, indent, strictMode, naming, modules, comments, vide, body }
}
