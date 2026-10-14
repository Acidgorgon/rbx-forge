// Rojo 7 JSON models (.model.json) and meta files for non-script instances.
// Rojo 7.7 reads and writes camelCase keys (className, children, properties, attributes) and also
// accepts the older PascalCase ones (ClassName, Children, Properties); we read both and write in the
// style a file already uses. Property values use Rojo's explicit form ({ "Vector3": [..] }) except
// for strings/numbers/bools, which are written plainly (Rojo resolves them through its reflection
// database). Tags go in properties.Tags as an array of strings (Rojo resolution.rs StringArray).

import type { StudioNode, SyncValue } from '../../../shared/sync/types.ts'
import { isScriptClass } from './mapping.ts'

export interface ModelNode {
  name?: string
  className: string
  properties: Record<string, SyncValue>
  attributes: Record<string, SyncValue>
  tags: string[]
  children: ModelNode[]
}

export type ModelStyle = 'camel' | 'pascal'

const PRIMITIVE_TYPES = new Set(['String', 'Bool', 'Float32', 'Float64', 'Int32', 'Int64', 'Content', 'ContentId'])

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeys((value as Record<string, unknown>)[key])
    return out
  }
  return value
}

// Most Roblox property components are float32 (Color3, Vector3, CFrame, Size, Volume ...): Rojo
// stores 0.2, Studio reads it back as 0.20000000298023224. A number that is exactly a float32 is
// written as the shortest decimal with the same float32, so the two compare equal (and pulled files
// keep 0.2). Doubles that are not float32 values (NumberValue 0.1, big integers) are untouched.
export function shortFloat(n: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n) || Math.fround(n) !== n) return n
  for (let p = 1; p <= 9; p++) {
    const v = Number(n.toPrecision(p))
    if (Math.fround(v) === n) return v
  }
  return n
}

function shortFloats(value: unknown): unknown {
  if (typeof value === 'number') return shortFloat(value)
  if (Array.isArray(value)) return value.map(shortFloats)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = shortFloats(v)
    return out
  }
  return value
}

// One spelling per value so Studio's and disk's forms compare equal: explicit primitives unwrapped,
// float32 noise removed.
export function canonicalValue(value: SyncValue): SyncValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && PRIMITIVE_TYPES.has(keys[0])) {
      const inner = (value as Record<string, unknown>)[keys[0]]
      if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'boolean') return shortFloats(inner) as SyncValue
    }
  }
  return shortFloats(sortKeys(value)) as SyncValue
}

function canonicalMap(map: Record<string, SyncValue> | undefined): Record<string, SyncValue> {
  const out: Record<string, SyncValue> = {}
  for (const key of Object.keys(map ?? {}).sort()) out[key] = canonicalValue(map![key])
  return out
}

function childKey(node: ModelNode): string {
  return `${node.name ?? ''}\u0000${node.className}\u0000${JSON.stringify(toJson(node, 'camel', true))}`
}

function normaliseNode(node: ModelNode): ModelNode {
  const children = node.children.map(normaliseNode)
  children.sort((a, b) => (childKey(a) < childKey(b) ? -1 : childKey(a) > childKey(b) ? 1 : 0))
  return { name: node.name, className: node.className, properties: canonicalMap(node.properties), attributes: canonicalMap(node.attributes), tags: [...new Set(node.tags)].sort(), children }
}

// ---- Studio -> model ----

// The node and every non-script descendant (scripts, and anything under them, live in their own files).
export function modelFromStudio(root: StudioNode, descendants: StudioNode[]): ModelNode {
  const depth = root.path.length
  const byParent = new Map<string, StudioNode[]>()
  for (const node of descendants) {
    if (node.path.length <= depth || !root.path.every((p, i) => node.path[i] === p)) continue
    const key = node.path.slice(0, -1).join('\u0000')
    const list = byParent.get(key) ?? []
    list.push(node)
    byParent.set(key, list)
  }
  const build = (node: StudioNode, named: boolean): ModelNode => ({
    name: named ? node.path[node.path.length - 1] : undefined,
    className: node.className,
    properties: { ...(node.properties ?? {}) },
    attributes: { ...(node.attributes ?? {}) },
    tags: [...(node.tags ?? [])],
    children: (byParent.get(node.path.join('\u0000')) ?? []).filter((c) => !isScriptClass(c.className)).map((c) => build(c, true))
  })
  return normaliseNode(build(root, false))
}

// ---- read / write ----

function toJson(node: ModelNode, style: ModelStyle, includeName: boolean): Record<string, unknown> {
  const k = style === 'pascal' ? { name: 'Name', className: 'ClassName', properties: 'Properties', children: 'Children' } : { name: 'name', className: 'className', properties: 'properties', children: 'children' }
  const out: Record<string, unknown> = {}
  if (includeName && node.name !== undefined) out[k.name] = node.name
  out[k.className] = node.className
  const props: Record<string, unknown> = { ...node.properties }
  if (node.tags.length) props.Tags = node.tags
  if (Object.keys(props).length) out[k.properties] = sortKeys(props)
  if (Object.keys(node.attributes).length) out.attributes = sortKeys(node.attributes)
  if (node.children.length) out[k.children] = node.children.map((c) => toJson(c, style, true))
  return out
}

// Rojo .model.json text for the node (its own name comes from the file name, so it is omitted).
export function writeModel(node: ModelNode, style: ModelStyle = 'camel'): string {
  return JSON.stringify(toJson(normaliseNode(node), style, false), null, 2) + '\n'
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (key in obj) return obj[key]
  return undefined
}

function fromJson(value: unknown, named: boolean): ModelNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('model node must be an object')
  const obj = value as Record<string, unknown>
  const className = pick(obj, 'className', 'ClassName')
  if (typeof className !== 'string' || !className) throw new Error('model node has no className')
  const name = pick(obj, 'name', 'Name')
  const properties = { ...((pick(obj, 'properties', 'Properties') as Record<string, SyncValue>) ?? {}) }
  let tags: string[] = []
  if ('Tags' in properties) {
    const raw = properties.Tags as unknown
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).Tags) ? ((raw as Record<string, unknown>).Tags as unknown[]) : []
    tags = list.filter((t): t is string => typeof t === 'string')
    delete properties.Tags
  }
  const attributes = (pick(obj, 'attributes', 'Attributes') as Record<string, SyncValue>) ?? {}
  const children = (pick(obj, 'children', 'Children') as unknown[]) ?? []
  if (!Array.isArray(children)) throw new Error('children must be an array')
  return { name: named && typeof name === 'string' ? name : undefined, className, properties, attributes, tags, children: children.map((c) => fromJson(c, true)) }
}

// Parses a .model.json (either key style). Throws on invalid JSON or shape.
export function readModel(text: string): ModelNode {
  return normaliseNode(fromJson(JSON.parse(text.replace(/^﻿/, '')), false))
}

export function detectStyle(text: string | null | undefined): ModelStyle {
  return text && /"ClassName"\s*:/.test(text) && !/"className"\s*:/.test(text) ? 'pascal' : 'camel'
}

// Comparison form of a model file's text (camelCase, sorted), or null when it does not parse.
export function canonicalModel(text: string): string | null {
  try {
    return writeModel(readModel(text))
  } catch {
    return null
  }
}

// ---- meta files ----

// init.meta.json / X.meta.json content for an instance: keeps keys Forge does not manage
// (ignoreUnknownInstances, $schema, other properties when `onlyRunContext`).
export function writeMeta(existing: string | null, update: { className?: string | null; properties?: Record<string, SyncValue>; attributes?: Record<string, SyncValue>; tags?: string[]; runContext?: string | null }, onlyRunContext: boolean): string {
  let obj: Record<string, unknown> = {}
  if (existing) {
    try {
      const parsed = JSON.parse(existing.replace(/^﻿/, ''))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
    } catch {
      obj = {}
    }
  }
  const props: Record<string, unknown> = { ...((obj.properties as Record<string, unknown>) ?? {}) }
  if (onlyRunContext) {
    if (update.runContext) props.RunContext = update.runContext
    else delete props.RunContext
  } else {
    for (const key of Object.keys(props)) delete props[key]
    Object.assign(props, canonicalMap(update.properties))
    if (update.tags?.length) props.Tags = [...update.tags].sort()
    if (update.className && update.className !== 'Folder') obj.className = update.className
    else delete obj.className
    const attrs = canonicalMap(update.attributes)
    if (Object.keys(attrs).length) obj.attributes = attrs
    else delete obj.attributes
  }
  if (Object.keys(props).length) obj.properties = sortKeys(props)
  else delete obj.properties
  return JSON.stringify(obj, null, 2) + '\n'
}

// Comparison form of a JSON (meta) file: keys sorted. Null when it does not parse.
export function canonicalJson(text: string): string | null {
  try {
    return JSON.stringify(shortFloats(sortKeys(JSON.parse(text.replace(/^﻿/, '')))), null, 2) + '\n'
  } catch {
    return null
  }
}
