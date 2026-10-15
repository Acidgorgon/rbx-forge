// Explorer multi-select (Game and Files views): the pure selection model and the batch-delete plan.
// No DOM, node or electron imports (unit tested in test/explorerSelection.test.ts).
//
// A selection is a set of row keys plus two cursors: `anchor`, where a Shift range starts, and
// `focus`, the keyboard cursor (what the arrows move from; drawn with an outline when it is not the
// one selected row). Commands (Enter, F2, Delete, copy) act on the selected keys only, never on a
// focus row that is not selected. Keys are row keys in the Explorer's visible order: an instance path
// joined with "/" in the Game view (made unique among same-named siblings, see uniqueKey), and
// "f:<path>" in Files.
//
// `context`: rows a filter shows only because something under them matches (the Game view keeps a
// match's ancestors on screen). Ctrl/Cmd+A and Shift ranges leave them out, so a filtered "select
// all" never picks up a folder whose other contents the filter hides; a plain or Ctrl/Cmd-click on
// one still selects it.
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

const NO_CONTEXT: ReadonlySet<string> = new Set()

// A row key not used yet this render: `base`, or `base#2`, `base#3`... for a second same-named
// sibling (a Studio-only duplicate next to the repo instance, Foo.luau next to a Foo/ folder), so one
// click selects one row.
export function uniqueKey(used: Set<string>, base: string): string {
  let key = base
  for (let n = 2; used.has(key); n++) key = `${base}#${n}`
  used.add(key)
  return key
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

// A Shift range without the filter's context rows.
function span(visible: readonly string[], a: string, b: string, context: ReadonlySet<string>): string[] {
  return rangeKeys(visible, a, b).filter((k) => !context.has(k))
}

export interface ClickMods {
  // Ctrl (Cmd on macOS): toggle the row, keep the rest.
  toggle?: boolean
  // Shift: select the range from the anchor to the row.
  range?: boolean
}

// A click on `key`. Plain: just that row. Toggle: add or remove it (it becomes the anchor and the
// focus; toggling the last row off leaves nothing selected, the focus stays for the arrows). Range:
// anchor..key replaces the selection, without the filter's context rows; with toggle too, the range
// is added to it.
export function clickSelect(sel: Selection, visible: readonly string[], key: string, mods: ClickMods = {}, context: ReadonlySet<string> = NO_CONTEXT): Selection {
  if (mods.range) {
    const anchor = sel.anchor !== null && visible.includes(sel.anchor) ? sel.anchor : sel.focus !== null && visible.includes(sel.focus) ? sel.focus : key
    const range = span(visible, anchor, key, context)
    const keys = mods.toggle ? inVisibleOrder(visible, [...sel.keys, ...range]) : range
    return { keys, anchor, focus: key }
  }
  if (mods.toggle) {
    const keys = sel.keys.includes(key) ? sel.keys.filter((k) => k !== key) : inVisibleOrder(visible, [...sel.keys, key])
    return { keys, anchor: key, focus: key }
  }
  return single(key)
}

// Ctrl/Cmd+A: every visible row except the filter's context rows; the focus stays where it was.
export function selectAll(sel: Selection, visible: readonly string[], context: ReadonlySet<string> = NO_CONTEXT): Selection {
  if (!visible.length) return EMPTY_SELECTION
  const keys = visible.filter((k) => !context.has(k))
  if (!keys.length) return sel
  const focus = sel.focus !== null && visible.includes(sel.focus) ? sel.focus : keys[0]
  return { keys, anchor: keys[0], focus }
}

// Esc / the header chip's clear button: nothing selected, the keyboard cursor stays where it was (so
// the arrows carry on from there).
export function clearKeys(sel: Selection): Selection {
  if (sel.focus === null) return EMPTY_SELECTION
  if (!sel.keys.length && sel.anchor === sel.focus) return sel
  return { keys: [], anchor: sel.focus, focus: sel.focus }
}

// Arrow Up / Down (delta -1 / +1). Plain: moves to and selects the next row. Shift (extend): the
// range from the anchor to the next row (without the filter's context rows). Off the ends it stays
// on the first / last row.
export function moveFocus(sel: Selection, visible: readonly string[], delta: number, extend = false, context: ReadonlySet<string> = NO_CONTEXT): Selection {
  if (!visible.length) return sel
  const i = sel.focus === null ? -1 : visible.indexOf(sel.focus)
  const next = visible[Math.max(0, Math.min(visible.length - 1, i + delta))]
  if (!extend) return single(next)
  const anchor = sel.anchor !== null && visible.includes(sel.anchor) ? sel.anchor : i >= 0 ? sel.focus! : next
  return { keys: span(visible, anchor, next, context), anchor, focus: next }
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
// (path / isDir already an Explorer entry target: an init script's folder, not the script; `file` the
// row's own file when that differs, i.e. the init script), a Studio-only instance (Delete in Studio
// through the Forge Bridge), or one that is skipped (a Wally package, Blink output, a project-file
// mount) with why. `instancePath` (Game view rows) and `path` (a skipped row's own file or folder)
// are only used to tell which rows sit inside which.
export type DeleteCandidate =
  | { key: string; name: string; kind: 'disk'; path: string; isDir: boolean; file?: string; instancePath?: string[] }
  | { key: string; name: string; kind: 'studio'; instancePath: string[]; className: string }
  | { key: string; name: string; kind: 'skip'; reason: string; path?: string; instancePath?: string[] }

export interface DeletePlan {
  disk: { key: string; name: string; path: string; isDir: boolean }[]
  studio: { key: string; name: string; instancePath: string[]; className: string }[]
  skipped: { key: string; name: string; reason: string }[]
  // Selected rows left out because a selected parent already takes them (parent + child: the parent).
  covered: number
}

// Instance paths compare name by name: an instance name may itself contain "/".
function instanceUnder(path: string[], parent: string[]): boolean {
  return path.length > parent.length && parent.every((p, i) => path[i] === p)
}

// Whether deleting `p` takes `c` with it. A file or folder goes with a selected folder that holds it
// on disk (never by instance nesting: a nested project-file mapping can put a folder's child
// instance somewhere else on disk); a Studio instance with the instance it is inside; a skipped row
// with the folder that holds its file, or else with the instance it is inside (a .model.json's
// children have no file of their own).
function inside(c: DeleteCandidate, p: DeleteCandidate): boolean {
  if (p === c || p.kind === 'skip') return false
  if (c.kind === 'studio') return !!p.instancePath && instanceUnder(c.instancePath, p.instancePath)
  if (p.kind === 'studio') return !!c.instancePath && instanceUnder(c.instancePath, p.instancePath)
  if (c.path !== undefined) return p.isDir && c.path !== p.path && isUnder(c.path, p.path)
  return !!c.instancePath && !!p.instancePath && instanceUnder(c.instancePath, p.instancePath)
}

// What deleting a multi-selection does. A row whose selected ancestor is deleted anyway (a file
// inside a selected folder, an instance inside a selected instance) is not deleted on its own: it
// goes with the parent. Duplicate disk entries collapse to one.
export function planDelete(candidates: readonly DeleteCandidate[]): DeletePlan {
  const deletable = candidates.filter((c) => c.kind !== 'skip')
  const coveredBy = (c: DeleteCandidate): boolean => deletable.some((p) => inside(c, p))
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

// For each folder the plan moves to the trash: how many of `files` (every file the Explorer knows of)
// are inside it but were not selected themselves or with a selected subfolder: rows the filter or a
// collapsed parent hides, or that were just not picked. The batch confirmation names them, and asks
// even with "Don't ask again" ticked.
export function unselectedInside(plan: DeletePlan, candidates: readonly DeleteCandidate[], files: readonly string[]): { path: string; count: number }[] {
  const picked = candidates.filter((c): c is Extract<DeleteCandidate, { kind: 'disk' }> => c.kind === 'disk')
  const known = [...new Set(files)]
  const out: { path: string; count: number }[] = []
  for (const d of plan.disk) {
    if (!d.isDir) continue
    const count = known.filter((f) => f !== d.path && isUnder(f, d.path) && !picked.some((c) => (c.path === d.path ? c.file === f : c.path === f || (c.isDir && isUnder(f, c.path))))).length
    if (count) out.push({ path: d.path, count })
  }
  return out
}

// The batch confirmation's line for unselectedInside: "src/server/Services/ also holds 23 files you
// did not select. They go too." (the first three folders by name, the rest as a total).
export function unselectedNote(hidden: readonly { path: string; count: number }[]): string {
  if (!hidden.length) return ''
  const files = (n: number, more = '') => `${n} ${more}file${n === 1 ? '' : 's'}`
  const shown = hidden.slice(0, 3).map((h) => `${h.path}/ also holds ${files(h.count)} you did not select`)
  const rest = hidden.slice(3)
  const restFiles = rest.reduce((n, h) => n + h.count, 0)
  const more = rest.length ? `, and ${rest.length} more folder${rest.length === 1 ? ' holds' : 's hold'} ${files(restFiles, 'more ')}` : ''
  const total = hidden.reduce((n, h) => n + h.count, 0)
  return `${shown.join('; ')}${more}. ${total === 1 ? 'It goes' : 'They go'} too.`
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
