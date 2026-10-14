// Explorer multi-select (Game and Files views): the pure selection model and the batch-delete plan.
// No DOM, node or electron imports (unit tested in test/explorerSelection.test.ts).
//
// A selection is a set of row keys plus two cursors: `anchor`, where a Shift range starts, and
// `focus`, the row the keyboard acts on (what a single click selects). Keys are row keys in the
// Explorer's visible order: an instance path joined with "/" in the Game view, "f:<path>" in Files.
import { isUnder } from './fileOps.ts'

export interface Selection {
  keys: readonly string[]
  anchor: string | null
  focus: string | null
}

export const EMPTY_SELECTION: Selection = Object.freeze({ keys: Object.freeze([]) as readonly string[], anchor: null, focus: null })

export function single(key: string | null): Selection {
  return key === null ? EMPTY_SELECTION : { keys: [key], anchor: key, focus: key }
}

export function isSelected(sel: Selection, key: string): boolean {
  return sel.keys.includes(key)
}

// Keys from a to b inclusive, in visible order (either direction). Empty when either is not visible.
export function rangeKeys(visible: readonly string[], a: string, b: string): string[] {
  const i = visible.indexOf(a)
  const j = visible.indexOf(b)
  if (i < 0 || j < 0) return []
  return visible.slice(Math.min(i, j), Math.max(i, j) + 1)
}

function inVisibleOrder(visible: readonly string[], keys: Iterable<string>): string[] {
  const want = new Set(keys)
  return visible.filter((k) => want.has(k))
}

export interface ClickMods {
  // Ctrl (Cmd on macOS): toggle the row, keep the rest.
  toggle?: boolean
  // Shift: select the range from the anchor to the row.
  range?: boolean
}

// A click on `key`. Plain: just that row. Toggle: add or remove it (it becomes the anchor). Range:
// anchor..key replaces the selection; with toggle too, the range is added to it.
export function clickSelect(sel: Selection, visible: readonly string[], key: string, mods: ClickMods = {}): Selection {
  if (mods.range) {
    const anchor = sel.anchor !== null && visible.includes(sel.anchor) ? sel.anchor : sel.focus !== null && visible.includes(sel.focus) ? sel.focus : key
    const span = rangeKeys(visible, anchor, key)
    const keys = mods.toggle ? inVisibleOrder(visible, [...sel.keys, ...span]) : span
    return { keys: keys.length ? keys : [key], anchor, focus: key }
  }
  if (mods.toggle) {
    const keys = sel.keys.includes(key) ? sel.keys.filter((k) => k !== key) : inVisibleOrder(visible, [...sel.keys, key])
    return { keys, anchor: key, focus: key }
  }
  return single(key)
}

// Ctrl/Cmd+A: every visible row; the focus stays where it was.
export function selectAll(sel: Selection, visible: readonly string[]): Selection {
  if (!visible.length) return EMPTY_SELECTION
  const focus = sel.focus !== null && visible.includes(sel.focus) ? sel.focus : visible[0]
  return { keys: [...visible], anchor: visible[0], focus }
}

// Arrow Up / Down (delta -1 / +1). Plain: moves to and selects the next row. Shift (extend): the
// range from the anchor to the next row. Off the ends it stays on the first / last row.
export function moveFocus(sel: Selection, visible: readonly string[], delta: number, extend = false): Selection {
  if (!visible.length) return sel
  const i = sel.focus === null ? -1 : visible.indexOf(sel.focus)
  const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))]
  if (!extend) return single(next)
  const anchor = sel.anchor !== null && visible.includes(sel.anchor) ? sel.anchor : i >= 0 ? sel.focus! : next
  return { keys: rangeKeys(visible, anchor, next), anchor, focus: next }
}

// After the visible rows change (filter, collapse, a delete, a mode switch): drop what is no longer
// visible. Returns `sel` itself when nothing changed (safe to compare by identity).
export function pruneSelection(sel: Selection, visible: readonly string[]): Selection {
  const vis = new Set(visible)
  const keys = sel.keys.filter((k) => vis.has(k))
  const anchor = sel.anchor !== null && vis.has(sel.anchor) ? sel.anchor : null
  const focus = sel.focus !== null && vis.has(sel.focus) ? sel.focus : null
  if (keys.length === sel.keys.length && anchor === sel.anchor && focus === sel.focus) return sel
  if (!keys.length && focus === null) return EMPTY_SELECTION
  return { keys, anchor, focus }
}

// ---- batch delete

// One selected row, as the Explorer classifies it: a file or folder Forge can move to the trash
// (path / isDir already an Explorer entry target: an init script's folder, not the script), a
// Studio-only instance (Delete in Studio through the Forge Bridge), or one that is skipped (a Wally
// package, Blink output, a project-file mount) with why.
export type DeleteCandidate =
  | { key: string; name: string; kind: 'disk'; path: string; isDir: boolean }
  | { key: string; name: string; kind: 'studio'; instancePath: string[]; className: string }
  | { key: string; name: string; kind: 'skip'; reason: string }

export interface DeletePlan {
  disk: { key: string; name: string; path: string; isDir: boolean }[]
  studio: { key: string; name: string; instancePath: string[]; className: string }[]
  skipped: { key: string; name: string; reason: string }[]
  // Selected rows left out because a selected parent already takes them (parent + child: the parent).
  covered: number
}

function keyUnder(key: string, parent: string): boolean {
  return key.startsWith(parent + '/')
}

function instanceUnder(path: string[], parent: string[]): boolean {
  return path.length > parent.length && parent.every((p, i) => path[i] === p)
}

// What deleting a multi-selection does. A row whose selected ancestor is deleted anyway (same tree
// row nesting, a file inside a selected folder, an instance inside a selected Studio instance) is not
// deleted on its own: it goes with the parent. Duplicate disk entries collapse to one.
export function planDelete(candidates: readonly DeleteCandidate[]): DeletePlan {
  const deletable = candidates.filter((c) => c.kind !== 'skip')
  const coveredBy = (c: DeleteCandidate): boolean =>
    deletable.some((p) => {
      if (p === c) return false
      if (keyUnder(c.key, p.key)) return true
      if (c.kind === 'disk' && p.kind === 'disk' && p.isDir && c.path !== p.path && isUnder(c.path, p.path)) return true
      if (c.kind === 'studio' && p.kind === 'studio' && instanceUnder(c.instancePath, p.instancePath)) return true
      return false
    })
  const plan: DeletePlan = { disk: [], studio: [], skipped: [], covered: 0 }
  const seen = new Set<string>()
  for (const c of candidates) {
    if (coveredBy(c)) {
      plan.covered++
      continue
    }
    if (c.kind === 'disk') {
      if (seen.has(c.path)) {
        plan.covered++
        continue
      }
      seen.add(c.path)
      plan.disk.push({ key: c.key, name: c.name, path: c.path, isDir: c.isDir })
    } else if (c.kind === 'studio') plan.studio.push({ key: c.key, name: c.name, instancePath: [...c.instancePath], className: c.className })
    else plan.skipped.push({ key: c.key, name: c.name, reason: c.reason })
  }
  return plan
}

// Disk entries without the ones inside another listed folder, and without duplicates (main applies
// this again to whatever the renderer sends).
export function collapseEntries<T extends { path: string; isDir?: boolean }>(entries: readonly T[]): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (seen.has(e.path)) continue
    if (entries.some((p) => p !== e && p.isDir && p.path !== e.path && isUnder(e.path, p.path))) continue
    seen.add(e.path)
    out.push(e)
  }
  return out
}

// Studio instance paths without the ones inside another listed instance, and without duplicates.
export function collapseInstancePaths<T extends { instancePath: string[] }>(items: readonly T[]): T[] {
  const out: T[] = []
  const seen = new Set<string>()
  for (const it of items) {
    const id = it.instancePath.join('\u0000')
    if (seen.has(id)) continue
    if (items.some((p) => p !== it && instanceUnder(it.instancePath, p.instancePath))) continue
    seen.add(id)
    out.push(it)
  }
  return out
}

// "a, b and 3 more" for confirm notes and toasts.
export function nameList(names: readonly string[], max = 4): string {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('')
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}
