// createSpec: a *.spec.luau next to a ModuleScript, requiring it by instance path the GenTree way
// (game:GetService(...) then the Rojo path), with one smoke test, an Init(janitor) test when the
// module has Init, and it.todo entries for its public functions.

import { readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { toRepoPath } from '../tools.ts'
import { buildSourcemap, instancePathOf, isSpecFile, type SourcemapNode } from './rojoTree.ts'
import type { CreateSpecResult } from './types.ts'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// Spec path for a module file: X.luau -> X.spec.luau; Folder/init.luau -> Folder/Folder.spec.luau.
export function specPathFor(modulePath: string): string {
  const path = toRepoPath(modulePath)
  const dir = posix.dirname(path)
  const base = posix.basename(path)
  const ext = base.endsWith('.lua') ? '.lua' : '.luau'
  if (/^init\.(luau|lua)$/.test(base)) {
    return posix.join(dir, `${posix.basename(dir)}.spec${ext}`)
  }
  return posix.join(dir, base.replace(/\.(luau|lua)$/, `.spec${ext}`))
}

// ["ReplicatedStorage","Shared","Modules","My Thing"] -> ReplicatedStorage.Shared.Modules["My Thing"]
export function instanceExpression(path: string[]): string {
  const [first, ...rest] = path
  return rest.reduce((expr, name) => (IDENT.test(name) ? `${expr}.${name}` : `${expr}[${JSON.stringify(name)}]`), first)
}

export interface ModuleShape {
  tableName: string | null
  functions: string[]
  hasInit: boolean
  hasStart: boolean
}

// Reads the module's returned table name and its public functions (function T.f / function T:f).
export function moduleShape(source: string): ModuleShape {
  const returned = /\breturn\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(source.replace(/\s*(--[^\n]*)?\s*$/, ''))
  const tableName = returned ? returned[1] : null
  const functions: string[] = []
  let hasInit = false
  let hasStart = false
  if (tableName) {
    const pattern = new RegExp(`^\\s*function\\s+${tableName}\\s*[.:]\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`, 'gm')
    for (const match of source.matchAll(pattern)) {
      const name = match[1]
      if (name === 'Init') hasInit = true
      else if (name === 'Start') hasStart = true
      else if (!name.startsWith('_') && !functions.includes(name)) functions.push(name)
    }
  }
  return { tableName, functions, hasInit, hasStart }
}

export function specTemplate(instancePath: string[], moduleName: string, shape: ModuleShape): string {
  const service = instancePath[0]
  const local = IDENT.test(moduleName) ? moduleName : 'Module'
  const requireExpr = instanceExpression(instancePath)
  const lines = [
    `-- Tests for ${requireExpr}.`,
    '-- Runs headless under Lune (RBX Forge Tests panel / run_tests). Specs get describe/it/expect,',
    '-- beforeEach/afterEach and `forge` helpers (fn, janitor, addPlayer, step, realm).',
    `local ${service} = game:GetService(${JSON.stringify(service)})`,
    '',
    `local ${local} = require(${requireExpr})`,
    '',
    `describe(${JSON.stringify(moduleName)}, function()`,
    '\tit("loads", function()',
    `\t\texpect(${local}).never.toBeNil()`,
    '\tend)'
  ]
  if (shape.hasInit) {
    lines.push(
      '',
      '\tit("initializes with a janitor", function()',
      '\t\tlocal janitor = forge.janitor()',
      `\t\t${local}:Init(janitor)`,
      '\t\tjanitor:Cleanup()',
      '\tend)'
    )
  }
  for (const name of shape.functions) lines.push('', `\tit.todo(${JSON.stringify(name)})`)
  lines.push('end)', '')
  return lines.join('\n')
}

export class SpecError extends Error {}

// Writes the spec unless it exists (then returns the existing one with created: false).
export async function createSpec(root: string, modulePath: string, tree?: SourcemapNode): Promise<CreateSpecResult> {
  const path = toRepoPath(modulePath).replace(/^\/+/, '')
  if (path.split('/').includes('..')) throw new SpecError(`Path is outside the project: ${modulePath}`)
  if (isSpecFile(path)) throw new SpecError(`${path} is already a spec`)
  if (!/\.(luau|lua)$/.test(path)) throw new SpecError(`${path} is not a .luau/.lua file`)
  if (/\.(server|client)\.(luau|lua)$/.test(path)) throw new SpecError(`${path} is a Script/LocalScript; only ModuleScripts can be required by a spec`)
  const map = tree ?? (await buildSourcemap(root))
  const found = instancePathOf(map, path)
  if (!found) throw new SpecError(`${path} is not mapped by default.project.json, so it has no instance path`)
  if (found.className !== 'ModuleScript') throw new SpecError(`${path} maps to a ${found.className}, not a ModuleScript`)
  const specPath = specPathFor(path)
  const existing = await readFile(join(root, ...specPath.split('/')), 'utf8').catch(() => null)
  const requirePath = instanceExpression(found.path)
  if (existing !== null) return { path: specPath, created: false, content: existing, requirePath }
  const source = await readFile(join(root, ...path.split('/')), 'utf8')
  const moduleName = found.path[found.path.length - 1]
  const content = specTemplate(found.path, moduleName, moduleShape(source))
  await writeFile(join(root, ...specPath.split('/')), content, { flag: 'wx' })
  return { path: specPath, created: true, content, requirePath }
}
