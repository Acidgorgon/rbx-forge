// Folder suggestions for "Add to game", from the project's Rojo layout. Pure: the caller passes the
// mapped roots per place and a resolver that turns an instance path into its disk folder (Forge
// Sync's mapping.toDisk).

import type { AddTargetOption, AddToGameRealm, AddToGameTarget } from './types.ts'

export interface PlaceRoots {
  projectFile: string
  name: string
  roots: { instance: string[]; path: string; isFile: boolean }[]
}

export type FolderResolver = (placeFile: string, instance: string[]) => { dir: string; exists: boolean } | null

const CLIENTISH = /client|controller|playerscripts/i
const SPECIAL = /^(events|interface|ui|gui|packages|serverpackages|devpackages|_index|tests?|config|data|admins?)$/i

// Score for a mapped root as the parent of the lab folder (higher is better; < 0 = never offer).
export function scoreRoot(realm: AddToGameRealm, instance: string[], path: string): { score: number; reason: string } {
  const top = instance[0] ?? ''
  const last = instance[instance.length - 1] ?? ''
  const clientish = instance.some((s) => CLIENTISH.test(s)) || /(^|\/)client(\/|$)/i.test(path)
  const special = SPECIAL.test(last)
  if (realm === 'server') {
    if (top === 'ServerScriptService' || top === 'ServerStorage') return { score: 40 + (special ? -10 : 0), reason: `${top}: server only` }
    return { score: -1, reason: 'not server-side' }
  }
  if (top === 'ServerScriptService' || top === 'ServerStorage') return { score: -1, reason: 'server only: clients cannot see it' }
  let score = 0
  const why: string[] = []
  if (top === 'ReplicatedStorage') {
    score += 40
    why.push('ReplicatedStorage: client and server can require it')
  } else if (top === 'StarterPlayer') {
    score += realm === 'client' ? 10 : -20
    why.push('client scripts')
  } else if (top === 'ReplicatedFirst') {
    score -= 10
    why.push('ReplicatedFirst loads before everything')
  } else score -= 5
  if (realm === 'client' && clientish) {
    score += 20
    why.push('client tree')
  }
  if (realm === 'shared') {
    if (instance.includes('Shared')) score += 15
    if (last === 'Modules') score += 10
    if (clientish) score -= 5
  }
  if (special) score -= 15
  return { score, reason: why.join('; ') || 'mapped folder' }
}

// Candidate folders (each mapped root + "/<folderName>"), best first, for every place.
export function suggestTargets(places: PlaceRoots[], realm: AddToGameRealm, folderName: string, resolve: FolderResolver): AddTargetOption[] {
  const out: (AddTargetOption & { score: number })[] = []
  for (const place of places) {
    const seen = new Set<string>()
    for (const root of place.roots) {
      if (root.isFile) continue
      const { score, reason } = scoreRoot(realm, root.instance, root.path)
      if (score < 0) continue
      // A root that IS the lab folder (e.g. "VFX" mapped directly) takes items as is.
      const instance = root.instance[root.instance.length - 1] === folderName ? root.instance : [...root.instance, folderName]
      const r = resolve(place.projectFile, instance)
      if (!r || seen.has(r.dir)) continue
      seen.add(r.dir)
      out.push({ placeFile: place.projectFile, instance, dir: r.dir, exists: r.exists, label: instance.join('.'), recommended: false, reason: r.exists ? `${reason}; already has ${folderName}/` : reason, score: score + (r.exists ? 25 : 0) })
    }
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
  const best = new Set<string>()
  for (const o of out) {
    if (best.has(o.placeFile)) continue
    best.add(o.placeFile)
    o.recommended = true
  }
  return out.map(({ score: _s, ...o }) => o)
}

// The default place first (default.project.json), then by name.
export function orderPlaces<T extends { file: string }>(places: T[]): T[] {
  return [...places].sort((a, b) => (a.file === 'default.project.json' ? -1 : b.file === 'default.project.json' ? 1 : a.file.localeCompare(b.file)))
}

// The remembered choice when it is still offered, else the recommended target of the first place.
export function pickSuggestion(targets: AddTargetOption[], remembered: AddToGameTarget | null, placeOrder: string[]): { target: AddToGameTarget | null; remembered: boolean } {
  if (remembered) {
    const hit = targets.find((t) => t.placeFile === remembered.placeFile && t.instance.join('/') === remembered.instance.join('/'))
    if (hit) return { target: { placeFile: hit.placeFile, instance: hit.instance }, remembered: true }
  }
  for (const file of placeOrder) {
    const t = targets.find((x) => x.placeFile === file && x.recommended)
    if (t) return { target: { placeFile: t.placeFile, instance: t.instance }, remembered: false }
  }
  return { target: null, remembered: false }
}
