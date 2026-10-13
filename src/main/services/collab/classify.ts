import type { ScriptCategory, ScriptEntry, ScriptKind } from '@shared/types'
import { categorize, CATEGORY_ORDER } from '../project.ts'

// Groups repo paths the way the Scripts panel does (GenTree categories and features), without
// needing the Rojo tree: realm and kind are inferred from the path and file name alone.

export type ChangeCategory = ScriptCategory | 'Project'

export interface PathClass {
  category: ChangeCategory
  feature?: string
}

const SCRIPT_EXT = /\.(luau|lua)$/

function stripScriptExt(segment: string): string {
  return segment.replace(/(\.server|\.client)?\.(luau|lua)$/, '')
}

// Same rule as project.ts featureOf: the folder (or file) under Features/, or Controllers/<X>Controller.
export function featureOfPath(path: string): string | undefined {
  const segments = path.split('/')
  const features = segments.indexOf('Features')
  if (features >= 0 && features + 1 < segments.length) {
    const name = stripScriptExt(segments[features + 1])
    if (name && !name.startsWith('init') && name !== '.gitkeep') return name
  }
  const controllers = segments.indexOf('Controllers')
  if (controllers >= 0 && controllers + 1 < segments.length) {
    const name = stripScriptExt(segments[controllers + 1]).replace(/Controller$/, '')
    if (name && name !== '.gitkeep') return name
  }
  return undefined
}

function realmOfPath(path: string, kind: ScriptKind): ScriptEntry['realm'] {
  const segments = path.split('/')
  if (segments.includes('shared')) return 'shared'
  if (segments.includes('server') || segments.includes('ServerStorage')) return 'server'
  if (segments.includes('client')) return 'client'
  return kind === 'Script' ? 'server' : kind === 'LocalScript' ? 'client' : 'shared'
}

export function classifyPath(path: string): PathClass {
  const feature = featureOfPath(path)
  const segments = path.split('/')
  const fileName = segments[segments.length - 1]
  if (!SCRIPT_EXT.test(fileName)) {
    return feature ? { category: 'Project', feature } : { category: 'Project' }
  }
  const kind: ScriptKind = /\.server\.(luau|lua)$/.test(fileName)
    ? 'Script'
    : /\.client\.(luau|lua)$/.test(fileName)
      ? 'LocalScript'
      : 'ModuleScript'
  const stem = stripScriptExt(fileName)
  const name = stem === 'init' && segments.length > 1 ? segments[segments.length - 2] : stem
  const category = categorize({ path, instancePath: [], name, kind, realm: realmOfPath(path, kind) })
  return feature ? { category, feature } : { category }
}

export interface Grouped<T> {
  // "feature:Inventory" or "category:Services"
  key: string
  label: string
  feature?: string
  category?: ChangeCategory
  items: T[]
}

// Feature groups first (alphabetical), then categories in the Scripts panel order, then Project files.
export function groupByFeature<T extends { path: string }>(items: T[]): Grouped<T>[] {
  const features = new Map<string, T[]>()
  const categories = new Map<ChangeCategory, T[]>()
  for (const item of items) {
    const cls = classifyPath(item.path)
    if (cls.feature) {
      const list = features.get(cls.feature) || []
      list.push(item)
      features.set(cls.feature, list)
    } else {
      const list = categories.get(cls.category) || []
      list.push(item)
      categories.set(cls.category, list)
    }
  }
  const out: Grouped<T>[] = []
  for (const name of [...features.keys()].sort((a, b) => a.localeCompare(b))) {
    out.push({ key: `feature:${name}`, label: name, feature: name, items: features.get(name)! })
  }
  const order: ChangeCategory[] = [...CATEGORY_ORDER, 'Project']
  for (const category of order) {
    const list = categories.get(category)
    if (list) out.push({ key: `category:${category}`, label: category === 'Project' ? 'Project files' : category, category, items: list })
  }
  return out
}
